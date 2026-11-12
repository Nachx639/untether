import Foundation
import Testing
import UIKit
@testable import Untether

/// The app's own clients (APIClient, BufferWebSocketClient over a real URLSession socket)
/// against the twin: a throwaway Untether server from this checkout (scripts/gemelo.sh),
/// never the real install. They run only when told where the twins are:
///
///     scripts/gemelo.sh start                      # with login, 127.0.0.1:4100
///     UTT_GEMELO_PORT=4101 UTT_GEMELO_HOME=/tmp/utt-gemelo-rich scripts/gemelo.sh start --rich   # --no-auth
///     TEST_RUNNER_GEMELO_AUTH_URL=http://127.0.0.1:4100 TEST_RUNNER_GEMELO_OPEN_URL=http://127.0.0.1:4101 \
///       TEST_RUNNER_GEMELO_OPEN_HOME=/private/tmp/utt-gemelo-rich \
///       xcodebuild test … -only-testing:UntetherTests/GemeloIntegrationTests
///
/// (xcodebuild hands TEST_RUNNER_X to the tests as X; the simulator shares the Mac's loopback.)
private enum Gemelo {
    private static func url(_ name: String) -> URL? {
        ProcessInfo.processInfo.environment[name].flatMap(URL.init(string:))
    }

    static let authURL = url("GEMELO_AUTH_URL")
    static let openURL = url("GEMELO_OPEN_URL")
    static let openHome = ProcessInfo.processInfo.environment["GEMELO_OPEN_HOME"]
}

@Suite("Twin server integration", .tags(.integration), .serialized)
@MainActor
struct GemeloIntegrationTests {
    private struct WaitTimeout: Error {}

    private func waitFor(seconds: Int = 20, _ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
        while ContinuousClock.now < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw WaitTimeout()
    }

    @MainActor
    private final class CountingFactory: WebSocketFactory {
        private(set) var created = 0
        func createWebSocket() -> WebSocketProtocol {
            self.created += 1
            return URLSessionWebSocket()
        }
    }

    private func serverConfig(_ url: URL) throws -> ServerConfig {
        try ServerConfig(host: #require(url.host), port: #require(url.port))
    }

    // MARK: - A server with login and a token it refuses

    /// An auth service holding a token the twin does not know, as after the token expired
    /// while the app was open (its own check at launch is answered "valid" here).
    private func serviceWithRefusedToken(for url: URL, apiClient: APIClient) async throws -> AuthenticationService {
        let config = try self.serverConfig(url)
        let keychain = MockKeychainService()
        try keychain.savePassword("a-token-the-server-never-issued", for: "auth_token_\(config.id)")
        let userData = AuthenticationService.UserData(userId: "alex", authMethod: "password", loginTime: Date())
        try keychain.savePassword(
            #require(String(data: JSONEncoder().encode(userData), encoding: .utf8)),
            for: "user_data_\(config.id)")
        MockURLProtocol.setHandler(forHost: try #require(url.host)) { request in
            try MockURLProtocol.jsonResponse(for: request.url!, json: ["valid": true])
        }
        let auth = AuthenticationService(
            apiClient: apiClient,
            serverConfig: config,
            keychainService: keychain,
            session: URLSession(configuration: .mockConfiguration))
        await auth.restoreTask?.value
        #expect(auth.getTokenForQuery() == "a-token-the-server-never-issued")
        return auth
    }

    @Test("A refused token: HTTP answers 401", .enabled(if: Gemelo.authURL != nil))
    func refusedTokenOverHTTP() async throws {
        let url = try #require(Gemelo.authURL)
        let client = APIClient()
        client.updateBaseURL(url)
        try await client.setAuthenticationService(self.serviceWithRefusedToken(for: url, apiClient: client))

        do {
            _ = try await client.getSessions()
            Issue.record("the twin must refuse the token")
        } catch let APIError.serverError(code, _) {
            #expect(code == 401)
        }
    }

    @Test("A refused token: the real socket gets close 4401, stops and asks for a login", .enabled(if: Gemelo.authURL != nil))
    func refusedTokenOverWebSocket() async throws {
        let url = try #require(Gemelo.authURL)
        let factory = CountingFactory()
        let client = BufferWebSocketClient(webSocketFactory: factory, baseURL: url)
        try await client.setAuthenticationService(self.serviceWithRefusedToken(for: url, apiClient: APIClient()))
        var loginRequests = 0
        client.onAuthenticationRequired = { loginRequests += 1 }

        client.subscribe(to: "any-session") { _ in }
        try await self.waitFor { client.authenticationRequired }

        #expect(loginRequests == 1)
        #expect(!client.isConnected)
        // Longer than the first reconnection delay: it must not try again
        try await Task.sleep(for: .seconds(3))
        #expect(factory.created == 1)
        #expect(loginRequests == 1)
    }

    @Test("Without credentials the twin with login refuses the socket and the client keeps retrying", .enabled(if: Gemelo.authURL != nil))
    func noCredentialsIsNotATokenRefusal() async throws {
        // A plain 401 before the upgrade is not 4401: nothing says the login is wrong
        let url = try #require(Gemelo.authURL)
        let factory = CountingFactory()
        let client = BufferWebSocketClient(webSocketFactory: factory, baseURL: url)
        defer { client.disconnect() }

        client.subscribe(to: "any-session") { _ in }
        try await self.waitFor { factory.created >= 2 }
        #expect(!client.authenticationRequired)
        #expect(!client.isConnected)
    }

    // MARK: - An open server (--no-auth) with sessions

    private func openClient() throws -> APIClient {
        let client = APIClient()
        try client.updateBaseURL(#require(Gemelo.openURL))
        return client
    }

    @Test("The session list of a real server decodes", .enabled(if: Gemelo.openURL != nil))
    func sessionListDecodes() async throws {
        let sessions = try await self.openClient().getSessions()
        #expect(!sessions.isEmpty)
        #expect(sessions.contains { $0.isRunning })
    }

    @Test(
        "A session created from the phone is shielded on the server; its preview and terminal run side by side",
        .enabled(if: Gemelo.openURL != nil),
        .timeLimit(.minutes(3)))
    func createdSessionLivePreviewAndTerminal() async throws {
        let url = try #require(Gemelo.openURL)
        let api = try self.openClient()

        // Point 1: created as the app creates it (spawn_terminal false, no `shielded` key)
        let sessionId = try await api.createSession(SessionCreateData(
            command: "/bin/zsh",
            workingDir: Gemelo.openHome ?? "/tmp",
            name: "zz-ios-integration"))
        var killed = false
        func kill() async {
            guard !killed else { return }
            killed = true
            try? await api.killSession(sessionId)
        }

        do {
            let (listData, _) = try await URLSession.shared.data(from: url.appendingPathComponent("api/sessions"))
            let list = try #require(JSONValue.decodeArray(from: listData))
            let created = try #require(list.compactMap(\.object).first { $0["id"] == .string(sessionId) })
            #expect(created["status"] == .string("running"))
            // In tmux on the server (survives a server restart), not in a Terminal.app window
            #expect(created["shielded"] == .bool(true))
            #expect(created["source"] != .string("terminal"))

            let client = BufferWebSocketClient(baseURL: url)
            defer { client.disconnect() }

            // Point 2: the card's preview alone connects the socket and gets snapshots
            var previewLines: [String] = []
            var previewUpdates = 0
            client.subscribe(to: sessionId) { event in
                if case let .bufferUpdate(snapshot) = event {
                    previewUpdates += 1
                    previewLines = snapshot.cells.map { $0.map(\.char).joined() }
                }
            }
            try await self.waitFor { client.isConnected && previewUpdates > 0 }

            // Point 6: the terminal joins; both receive
            var terminalOutput = ""
            let terminal = client.subscribe(to: sessionId, mode: .stdout) { event in
                if case let .output(_, data) = event { terminalOutput += data }
            }
            #expect(await client.sendInput(sessionId: sessionId, text: "echo uno-$((40+2))\r"))
            try await self.waitFor { terminalOutput.contains("uno-42") }
            try await self.waitFor { previewLines.contains { $0.contains("uno-42") } }

            // Closing the terminal leaves the preview alive
            client.unsubscribe(terminal)
            let outputAtClose = terminalOutput
            #expect(await client.sendInput(sessionId: sessionId, text: "echo dos-$((80+4))\r"))
            try await self.waitFor { previewLines.contains { $0.contains("dos-84") } }
            #expect(terminalOutput == outputAtClose)
        } catch {
            await kill()
            throw error
        }
        await kill()
    }

    @Test("An image in the file browser: preview gives its url and the image downloads", .enabled(if: Gemelo.openURL != nil && Gemelo.openHome != nil))
    func imagePreviewDownloads() async throws {
        let api = try self.openClient()
        let home = try #require(Gemelo.openHome)
        let folder = "\(home)/proyectos/faro-reservas/assets"

        let listing = try await api.browseDirectory(path: folder)
        let logo = try #require(listing.files.first { $0.name == "logo.png" })
        #expect(!logo.isDir)

        let preview = try await api.previewFile(path: logo.path)
        #expect(preview.type == .image)
        let data = try await api.downloadServerFile(at: #require(preview.url))
        let image = try #require(UIImage(data: data))
        #expect(image.size.width > 0)
    }

    @Test("A text file previews with its content", .enabled(if: Gemelo.openURL != nil && Gemelo.openHome != nil))
    func textPreview() async throws {
        let api = try self.openClient()
        let home = try #require(Gemelo.openHome)
        let listing = try await api.browseDirectory(path: "\(home)/proyectos/faro-reservas")
        let file = try #require(listing.files.first { !$0.isDir && ($0.name.hasSuffix(".md") || $0.name.hasSuffix(".json")) })

        let preview = try await api.previewFile(path: file.path)
        #expect(preview.type == .text)
        #expect(preview.content?.isEmpty == false)
    }
}
