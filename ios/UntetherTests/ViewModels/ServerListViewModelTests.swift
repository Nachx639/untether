import Foundation
import Testing
@testable import Untether

@Suite("ServerListViewModel Tests", .tags(.critical, .mvvm))
@MainActor
struct ServerListViewModelTests {
    // MARK: - Test Helpers

    private func createTestViewModel() -> (viewModel: ServerListViewModel, keychain: MockKeychainService) {
        let mockKeychain = MockKeychainService()
        let testUserDefaults = UserDefaults(suiteName: "test-\(UUID().uuidString)")!
        let mockStorage = MockStorage()
        let mockNetworkMonitor = MockNetworkMonitor(isConnected: true)
        let connectionManager = ConnectionManager.forTests(storage: mockStorage)

        let viewModel = ServerListViewModel(
            connectionManager: connectionManager,
            networkMonitor: mockNetworkMonitor,
            keychainService: mockKeychain,
            userDefaults: testUserDefaults)

        return (viewModel, mockKeychain)
    }

    private func createTestProfile(
        name: String = "Test Server",
        url: String = "http://localhost:4020",
        requiresAuth: Bool = false)
        -> ServerProfile
    {
        ServerProfile(
            id: UUID(),
            name: name,
            url: url,
            requiresAuth: requiresAuth)
    }

    // MARK: - Tests

    @Test("ViewModel initializes with empty profiles")
    func initializationWithEmptyProfiles() {
        let (viewModel, _) = self.createTestViewModel()

        #expect(viewModel.profiles.isEmpty)
        #expect(viewModel.isLoading == false)
        #expect(viewModel.errorMessage == nil)
        #expect(viewModel.showLoginView == false)
        #expect(viewModel.currentConnectingProfile == nil)
    }

    @Test("Adding new profile updates profiles list")
    func addNewProfile() async throws {
        let (viewModel, keychain) = self.createTestViewModel()

        let profile = self.createTestProfile(
            name: "Test Server",
            url: "http://192.168.1.100:4020",
            requiresAuth: true)

        try await viewModel.addProfile(profile, password: "testpass123")

        #expect(viewModel.profiles.contains { $0.id == profile.id })

        // Verify password was saved
        let savedPassword = try? keychain.getPassword(for: profile.id)
        #expect(savedPassword == "testpass123")
    }

    @Test("Adding profile without password doesn't save to keychain")
    func addProfileWithoutPassword() async throws {
        let (viewModel, keychain) = self.createTestViewModel()

        let profile = self.createTestProfile(requiresAuth: false)

        try await viewModel.addProfile(profile, password: nil)

        #expect(viewModel.profiles.contains { $0.id == profile.id })

        // Verify no password was saved
        let savedPassword = try? keychain.getPassword(for: profile.id)
        #expect(savedPassword == nil)
    }

    @Test("Deleting profile removes from list")
    func deleteProfile() async throws {
        let (viewModel, _) = self.createTestViewModel()

        let profile = self.createTestProfile()
        try await viewModel.addProfile(profile, password: nil)

        #expect(viewModel.profiles.contains { $0.id == profile.id })

        try await viewModel.deleteProfile(profile)

        #expect(!viewModel.profiles.contains { $0.id == profile.id })
    }

    // The connection tests answer the server's routes themselves (MockURLProtocol, by host).
    // 2026-11-10: they connected for real to http://localhost:4020, the Untether of the Mac
    // that runs the tests, and to a ts.net name.

    private func testHost() -> String {
        "server-\(UUID().uuidString.lowercased()).local"
    }

    @Test("Connecting to a server without login connects")
    func connectToProfile() async throws {
        let (viewModel, _) = self.createTestViewModel()
        let host = self.testHost()
        nonisolated(unsafe) var paths: [String] = []
        MockURLProtocol.setHandler(forHost: host) { request in
            paths.append(request.url!.path)
            if request.url?.path == "/api/auth/config" {
                return try MockURLProtocol.jsonResponse(
                    for: request.url!,
                    json: ["noAuth": true, "enableSSHKeys": false, "disallowUserPassword": false])
            }
            return MockURLProtocol.successResponse(for: request.url!, data: Data("[]".utf8))
        }
        let profile = self.createTestProfile(url: "http://\(host):4020")
        try await viewModel.addProfile(profile, password: nil)

        await viewModel.initiateConnectionToProfile(profile)

        #expect(viewModel.connectionManager.isConnected)
        #expect(viewModel.errorMessage == nil)
        #expect(!viewModel.showLoginView)
        #expect(paths == ["/api/auth/config", "/api/sessions"])
    }

    @Test("A server that asks for a login and has no stored password opens the login sheet")
    func connectToProfileNeedingLogin() async throws {
        let (viewModel, _) = self.createTestViewModel()
        let host = self.testHost()
        MockURLProtocol.setHandler(forHost: host) { request in
            try MockURLProtocol.jsonResponse(
                for: request.url!,
                json: ["noAuth": false, "enableSSHKeys": false, "disallowUserPassword": false])
        }
        let profile = self.createTestProfile(url: "http://\(host):4020")
        try await viewModel.addProfile(profile, password: nil)

        await viewModel.initiateConnectionToProfile(profile)

        #expect(!viewModel.connectionManager.isConnected)
        #expect(viewModel.showLoginView)
        #expect(viewModel.currentConnectingProfile?.id == profile.id)
        // The profile learns that this server needs a login
        #expect(viewModel.profiles.first { $0.id == profile.id }?.requiresAuth == true)
    }

    @Test("A stored password logs in without asking")
    func connectToProfileWithStoredPassword() async throws {
        let (viewModel, _) = self.createTestViewModel()
        let host = self.testHost()
        nonisolated(unsafe) var sentPassword: JSONValue?
        MockURLProtocol.setHandler(forHost: host) { request in
            switch request.url!.path {
            case "/api/auth/config":
                return try MockURLProtocol.jsonResponse(
                    for: request.url!,
                    json: ["noAuth": false, "enableSSHKeys": false, "disallowUserPassword": false])
            case "/api/auth/password":
                sentPassword = MockURLProtocol.jsonBody(of: request)?["password"]
                return try MockURLProtocol.jsonResponse(
                    for: request.url!,
                    json: ["success": true, "token": "token-1", "userId": "alex", "authMethod": "password"])
            default:
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-1")
                return MockURLProtocol.successResponse(for: request.url!, data: Data("[]".utf8))
            }
        }
        let profile = self.createTestProfile(url: "http://\(host):4020", requiresAuth: true)
        try await viewModel.addProfile(profile, password: "stored-password")

        await viewModel.initiateConnectionToProfile(profile)

        #expect(sentPassword == .string("stored-password"))
        #expect(viewModel.connectionManager.isConnected)
        #expect(!viewModel.showLoginView)
    }

    @Test("A refused token logs in again on its own when the password is stored")
    func loginAgainAfterRefusedToken() async throws {
        let (viewModel, _) = self.createTestViewModel()
        let host = self.testHost()
        MockURLProtocol.setHandler(forHost: host) { request in
            switch request.url!.path {
            case "/api/auth/config":
                return try MockURLProtocol.jsonResponse(
                    for: request.url!,
                    json: ["noAuth": false, "enableSSHKeys": false, "disallowUserPassword": false])
            case "/api/auth/password":
                return try MockURLProtocol.jsonResponse(
                    for: request.url!,
                    json: ["success": true, "token": "token-2", "userId": "alex", "authMethod": "password"])
            default:
                return MockURLProtocol.successResponse(for: request.url!, data: Data("[]".utf8))
            }
        }
        let profile = self.createTestProfile(url: "http://\(host):4020", requiresAuth: true)
        try await viewModel.addProfile(profile, password: "stored-password")
        await viewModel.initiateConnectionToProfile(profile)
        #expect(viewModel.connectionManager.isConnected)

        // The socket gets close 4401, or a request gets 401
        viewModel.connectionManager.requireLogin()
        #expect(!viewModel.connectionManager.isConnected)
        #expect(viewModel.connectionManager.loginRequiredServerID == "\(host):4020")

        // What the server list does when it appears with that pending
        await viewModel.loginAgainIfRequired()

        #expect(viewModel.connectionManager.isConnected)
        #expect(viewModel.connectionManager.loginRequiredServerID == nil)
        #expect(!viewModel.showLoginView)
    }

    @Test("A Tailscale https profile whose server does not answer stays https")
    func unreachableTailscaleProfileKeepsHTTPS() async throws {
        let (viewModel, _) = self.createTestViewModel()
        let host = "\(self.testHost()).ts.net"
        MockURLProtocol.setHandler(forHost: host) { _ in throw URLError(.cannotConnectToHost) }
        let profile = ServerProfile(
            name: "Tailscale Server",
            url: "https://\(host)",
            tailscaleHostname: host,
            tailscaleIP: "100.64.0.1",
            isTailscaleEnabled: true,
            preferTailscale: true,
            httpsAvailable: true,
            isPublic: false,
            preferSSL: true)
        try await viewModel.addProfile(profile)

        await viewModel.initiateConnectionToProfile(profile)

        #expect(!viewModel.connectionManager.isConnected)
        #expect(viewModel.errorMessage != nil)
        // It used to be saved as HTTP-only and never connect again
        let saved = try #require(viewModel.profiles.first { $0.id == profile.id })
        #expect(saved.httpsAvailable)
        #expect(saved.preferSSL)
        #expect(saved.toServerConfig()?.connectionURL().host == host)
    }
}
