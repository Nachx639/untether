import Foundation
import Testing
@testable import Untether

/// The saved login survives everything except the server's own refusal (2026-11-10 audit:
/// a Mac asleep or a phone without coverage at launch deleted the token).
@Suite("AuthenticationService Tests", .tags(.critical, .security))
@MainActor
struct AuthenticationServiceTests {
    let host: String
    let config: ServerConfig
    let keychain = MockKeychainService()
    let session = URLSession(configuration: .mockConfiguration)

    init() {
        // Its own host: MockURLProtocol answers by host, so parallel suites do not mix
        self.host = "auth-\(UUID().uuidString.lowercased()).local"
        self.config = ServerConfig(host: self.host, port: 4_020)
    }

    private var tokenKey: String { "auth_token_\(self.config.id)" }

    private func saveToken(_ token: String, loggedIn: Date = Date()) throws {
        try self.keychain.savePassword(token, for: self.tokenKey)
        let userData = AuthenticationService.UserData(userId: "alex", authMethod: "password", loginTime: loggedIn)
        let json = try #require(String(data: JSONEncoder().encode(userData), encoding: .utf8))
        try self.keychain.savePassword(json, for: "user_data_\(self.config.id)")
    }

    private func makeService() -> AuthenticationService {
        AuthenticationService(
            apiClient: APIClient.shared,
            serverConfig: self.config,
            keychainService: self.keychain,
            session: self.session)
    }

    private func respond(_ handler: @escaping MockURLProtocol.Handler) {
        MockURLProtocol.setHandler(forHost: self.host, handler)
    }

    private func savedToken() -> String? {
        try? self.keychain.loadPassword(for: self.tokenKey)
    }

    // MARK: - Restoring the saved token

    @Test("A network failure at launch keeps the saved token")
    func networkFailureKeepsToken() async throws {
        try self.saveToken("saved-token")
        self.respond { _ in throw URLError(.cannotConnectToHost) }

        let auth = self.makeService()
        await auth.restoreTask?.value

        #expect(self.savedToken() == "saved-token")
        #expect(auth.getAuthHeader() == ["Authorization": "Bearer saved-token"])
    }

    @Test("A server error (not 401) at launch keeps the saved token", arguments: [500, 502, 503])
    func serverErrorKeepsToken(status: Int) async throws {
        try self.saveToken("saved-token")
        self.respond { request in MockURLProtocol.errorResponse(for: request.url!, statusCode: status) }

        let auth = self.makeService()
        await auth.restoreTask?.value

        #expect(self.savedToken() == "saved-token")
        #expect(auth.getTokenForQuery() == "saved-token")
    }

    @Test("Only the server's 401 throws the saved token away, without calling logout")
    func refusedTokenIsForgotten() async throws {
        try self.saveToken("stale-token")
        nonisolated(unsafe) var paths: [String] = []
        self.respond { request in
            paths.append(request.url!.path)
            return MockURLProtocol.errorResponse(for: request.url!, statusCode: 401, message: "Invalid or expired token")
        }

        let auth = self.makeService()
        await auth.restoreTask?.value

        #expect(self.savedToken() == nil)
        #expect(auth.getAuthHeader().isEmpty)
        #expect(paths == ["/api/auth/verify"])
    }

    @Test("A valid token is restored, however old the login is")
    func validTokenRestoredWhateverItsAge() async throws {
        // The server decides how long a token lives; the app used to drop it after 24 hours
        try self.saveToken("long-lived-token", loggedIn: Date().addingTimeInterval(-10 * 24 * 3_600))
        self.respond { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer long-lived-token")
            return try MockURLProtocol.jsonResponse(for: request.url!, json: ["valid": true, "userId": "alex"])
        }

        let auth = self.makeService()
        await auth.restoreTask?.value

        #expect(auth.isAuthenticated)
        #expect(self.savedToken() == "long-lived-token")
    }

    // MARK: - Login

    @Test("Login sends only the password and stores the token")
    func loginStoresToken() async throws {
        self.respond { request in
            #expect(request.url?.path == "/api/auth/password")
            return try MockURLProtocol.jsonResponse(
                for: request.url!,
                json: ["success": true, "token": "new-token", "userId": "alex", "authMethod": "password"])
        }

        let auth = self.makeService()
        await auth.restoreTask?.value
        try await auth.authenticateWithPassword("correct horse")

        #expect(auth.isAuthenticated)
        #expect(auth.currentUser == "alex")
        #expect(self.savedToken() == "new-token")
    }

    @Test("Login errors keep the server's status and message", arguments: [
        // What web/src/server/routes/auth.ts answers: only 401 and 429 carry `success`
        (401, #"{"success":false,"error":"Invalid username or password"}"#, "Invalid username or password"),
        (429, #"{"success":false,"error":"Too many failed attempts. Try again in 8 s.","retryAfter":8}"#,
         "Too many failed attempts. Try again in 8 s."),
        (403, #"{"error":"Password authentication is disabled"}"#, "Password authentication is disabled"),
        (500, #"{"error":"Password authentication failed"}"#, "Password authentication failed"),
    ])
    func loginErrorsKeepStatusAndMessage(status: Int, body: String, message: String) async throws {
        self.respond { request in
            MockURLProtocol.successResponse(for: request.url!, statusCode: status, data: Data(body.utf8))
        }

        let auth = self.makeService()
        await auth.restoreTask?.value
        do {
            try await auth.authenticateWithPassword("whatever")
            Issue.record("login must fail with HTTP \(status)")
        } catch let APIError.serverError(code, text) {
            #expect(code == status)
            #expect(text == message)
        }
        #expect(!auth.isAuthenticated)
        #expect(self.savedToken() == nil)
    }

    // MARK: - Automatic login with the stored password

    private func profileWithStoredPassword() throws -> ServerProfile {
        let profile = ServerProfile(name: "Mac", url: "http://\(self.host):4020", requiresAuth: true)
        try self.keychain.savePassword("stored-password", for: profile.id)
        return profile
    }

    @Test("Auto-login: a refused token is replaced silently with the stored password")
    func autoLoginReplacesRefusedToken() async throws {
        try self.saveToken("stale-token")
        self.respond { request in
            if request.url?.path == "/api/auth/verify" {
                return MockURLProtocol.errorResponse(for: request.url!, statusCode: 401)
            }
            return try MockURLProtocol.jsonResponse(
                for: request.url!,
                json: ["success": true, "token": "fresh-token", "userId": "alex", "authMethod": "password"])
        }

        let auth = self.makeService()
        try await auth.attemptAutoLogin(profile: self.profileWithStoredPassword())

        #expect(auth.isAuthenticated)
        #expect(self.savedToken() == "fresh-token")
    }

    @Test("Auto-login: only a 401 means the stored password is wrong")
    func autoLoginClassifiesErrors() async throws {
        nonisolated(unsafe) var status = 401
        self.respond { request in
            MockURLProtocol.successResponse(
                for: request.url!,
                statusCode: status,
                data: Data(#"{"success":false,"error":"Too many failed attempts. Try again in 8 s."}"#.utf8))
        }
        let auth = self.makeService()
        await auth.restoreTask?.value
        let profile = try self.profileWithStoredPassword()

        await #expect(throws: AuthenticationError.self) {
            try await auth.attemptAutoLogin(profile: profile)
        }
        do {
            try await auth.attemptAutoLogin(profile: profile)
        } catch AuthenticationError.invalidCredentials {
        } catch {
            Issue.record("401 must be invalidCredentials, got \(error)")
        }

        status = 429
        do {
            try await auth.attemptAutoLogin(profile: profile)
            Issue.record("429 must fail")
        } catch let AuthenticationError.serverError(message) {
            #expect(message == "Too many failed attempts. Try again in 8 s.")
        } catch {
            Issue.record("429 must keep the server's message, got \(error)")
        }
    }

    @Test("Auto-login: without network the error is the network's, not a wrong password")
    func autoLoginWithoutNetwork() async throws {
        self.respond { _ in throw URLError(.notConnectedToInternet) }
        let auth = self.makeService()
        await auth.restoreTask?.value

        do {
            try await auth.attemptAutoLogin(profile: self.profileWithStoredPassword())
            Issue.record("must fail without network")
        } catch is AuthenticationError {
            Issue.record("a network failure must not ask for the password again")
        } catch {
            #expect((error as? URLError)?.code == .notConnectedToInternet)
        }
    }
}
