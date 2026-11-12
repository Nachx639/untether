import Foundation
import Testing
@testable import Untether

/// APIClient against canned HTTP answers (MockURLProtocol): what it sends and how it reads
/// what the server answers. The JSON here is what web/src/server/routes answer today.
@Suite("APIClient Tests", .tags(.critical, .networking))
@MainActor
struct APIClientTests {
    let host: String
    let client: APIClient

    init() {
        // Its own host: MockURLProtocol answers by host, so parallel suites do not mix
        self.host = "api-\(UUID().uuidString.lowercased()).local"
        self.client = APIClient(session: URLSession(configuration: .mockConfiguration))
        self.client.updateBaseURL(URL(string: "http://\(self.host):4020")!)
    }

    private func respond(_ handler: @escaping MockURLProtocol.Handler) {
        MockURLProtocol.setHandler(forHost: self.host, handler)
    }

    // MARK: - Session Management Tests

    @Test("Get sessions returns parsed sessions")
    func testGetSessions() async throws {
        self.respond { request in
            #expect(request.url?.path == "/api/sessions")
            #expect(request.httpMethod == "GET")
            return MockURLProtocol.successResponse(for: request.url!, data: Data(TestFixtures.sessionsJSON.utf8))
        }

        let sessions = try await self.client.getSessions()

        #expect(sessions.count == 2)
        #expect(sessions[0].id == "test-session-123")
        #expect(sessions[0].isRunning == true)
        #expect(sessions[1].id == "exited-session-456")
        #expect(sessions[1].isRunning == false)
    }

    @Test("Get sessions handles empty response")
    func getSessionsEmpty() async throws {
        self.respond { request in
            MockURLProtocol.successResponse(for: request.url!, data: Data("[]".utf8))
        }

        #expect(try await self.client.getSessions().isEmpty)
    }

    @Test("A transport failure is a networkError", arguments: [URLError.Code.notConnectedToInternet, .timedOut])
    func transportFailure(code: URLError.Code) async throws {
        self.respond { _ in throw URLError(code) }

        do {
            _ = try await self.client.getSessions()
            Issue.record("Expected network error")
        } catch let APIError.networkError(error) {
            #expect((error as? URLError)?.code == code)
        }
    }

    @Test("Create session sends correct request")
    func testCreateSession() async throws {
        let sessionData = SessionCreateData(
            command: "/bin/bash",
            workingDir: "/Users/test",
            name: "Test Session",
            cols: 80,
            rows: 24)

        nonisolated(unsafe) var sent: [String: JSONValue]?
        self.respond { request in
            #expect(request.url?.path == "/api/sessions")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            sent = MockURLProtocol.jsonBody(of: request)
            return MockURLProtocol.successResponse(
                for: request.url!,
                data: Data(TestFixtures.createSessionJSON.utf8))
        }

        let sessionId = try await self.client.createSession(sessionData)

        #expect(sessionId == "new-session-789")
        let body = try #require(sent)
        #expect(body["command"] == .array([.string("/bin/bash")]))
        #expect(body["workingDir"] == .string("/Users/test"))
        #expect(body["name"] == .string("Test Session"))
        #expect(body["cols"] == .number(80))
        #expect(body["rows"] == .number(24))
        #expect(body["spawn_terminal"] == .bool(false))
    }

    @Test("Create session reports the server's reason")
    func createSessionError() async throws {
        self.respond { request in
            MockURLProtocol.successResponse(
                for: request.url!,
                statusCode: 400,
                data: Data(#"{"error":"Failed to create session","details":"Working directory does not exist"}"#.utf8))
        }

        do {
            _ = try await self.client.createSession(SessionCreateData(workingDir: "/nowhere"))
            Issue.record("Expected error to be thrown")
        } catch let APIError.serverError(code, message) {
            #expect(code == 400)
            #expect(message == "Working directory does not exist")
        }
    }

    @Test("Kill session sends DELETE request")
    func testKillSession() async throws {
        let sessionId = "test-session-123"
        self.respond { request in
            #expect(request.url?.path == "/api/sessions/\(sessionId)")
            #expect(request.httpMethod == "DELETE")
            return MockURLProtocol.successResponse(for: request.url!, data: Data(#"{"success":true}"#.utf8))
        }

        try await self.client.killSession(sessionId)
    }

    @Test("Send input posts the text under the key the server reads")
    func testSendInput() async throws {
        let sessionId = "test-session-123"
        nonisolated(unsafe) var sent: [String: JSONValue]?
        self.respond { request in
            #expect(request.url?.path == "/api/sessions/\(sessionId)/input")
            #expect(request.httpMethod == "POST")
            sent = MockURLProtocol.jsonBody(of: request)
            return MockURLProtocol.successResponse(for: request.url!, data: Data(#"{"success":true}"#.utf8))
        }

        try await self.client.sendInput(sessionId: sessionId, text: "ls -la\n")

        // routes/sessions.ts: the body must carry `text` (or `key`)
        #expect(sent?["text"] == .string("ls -la\n"))
    }

    @Test("Resize terminal sends correct dimensions")
    func testResizeTerminal() async throws {
        let sessionId = "test-session-123"
        nonisolated(unsafe) var sent: [String: JSONValue]?
        self.respond { request in
            #expect(request.url?.path == "/api/sessions/\(sessionId)/resize")
            #expect(request.httpMethod == "POST")
            sent = MockURLProtocol.jsonBody(of: request)
            return MockURLProtocol.successResponse(for: request.url!, data: Data(#"{"success":true}"#.utf8))
        }

        try await self.client.resizeTerminal(sessionId: sessionId, cols: 120, rows: 40)

        #expect(sent?["cols"] == .number(120))
        #expect(sent?["rows"] == .number(40))
    }

    // MARK: - Error Handling Tests

    @Test("An error status carries the server's message")
    func handle404Error() async throws {
        self.respond { request in
            MockURLProtocol.errorResponse(for: request.url!, statusCode: 404, message: "Session not found")
        }

        do {
            try await self.client.killSession("nonexistent")
            Issue.record("Expected error to be thrown")
        } catch let APIError.serverError(code, message) {
            #expect(code == 404)
            #expect(message == "Session not found")
        }
    }

    @Test("Handles 401 unauthorized error")
    func handle401Error() async throws {
        self.respond { request in
            MockURLProtocol.errorResponse(for: request.url!, statusCode: 401, message: "Authentication required")
        }

        do {
            _ = try await self.client.getSessions()
            Issue.record("Expected error to be thrown")
        } catch let APIError.serverError(code, _) {
            #expect(code == 401)
        }
    }

    @Test("Handles invalid JSON response")
    func handleInvalidJSON() async throws {
        self.respond { request in
            MockURLProtocol.successResponse(for: request.url!, data: Data("not json".utf8))
        }

        do {
            _ = try await self.client.getSessions()
            Issue.record("Expected decoding error")
        } catch APIError.decodingError {
        }
    }

    // MARK: - File browser

    @Test("Browse sends the path and filters and reads the server's listing")
    func browseDirectory() async throws {
        self.respond { request in
            #expect(request.url?.path == "/api/fs/browse")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            #expect(query.contains(URLQueryItem(name: "path", value: "/Users/test/project")))
            #expect(query.contains(URLQueryItem(name: "showHidden", value: "true")))
            #expect(query.contains(URLQueryItem(name: "gitFilter", value: "all")))
            // What routes/filesystem.ts answers
            let listing = #"""
            {"path":"/Users/test/project","fullPath":"/Users/test/project","gitStatus":null,"files":[
              {"name":"src","path":"/Users/test/project/src","type":"directory","size":96,
               "modified":"2026-11-09T10:00:00.000Z","permissions":"755","isGitTracked":true},
              {"name":"logo.png","path":"/Users/test/project/logo.png","type":"file","size":2048,
               "modified":"2026-11-09T10:00:00.000Z","permissions":"644","isGitTracked":true}
            ]}
            """#
            return MockURLProtocol.successResponse(for: request.url!, data: Data(listing.utf8))
        }

        let listing = try await self.client.browseDirectory(path: "/Users/test/project", showHidden: true)

        #expect(listing.files.map(\.name) == ["src", "logo.png"])
        #expect(listing.files[0].isDir)
        #expect(!listing.files[1].isDir)
    }

    @Test("An image preview is its url; the image is downloaded from it with the login")
    func imagePreviewDownload() async throws {
        let imagePath = "/Users/test/project/logo with space.png"
        let rawPath = "/api/fs/raw?path=%2FUsers%2Ftest%2Fproject%2Flogo%20with%20space.png"
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        nonisolated(unsafe) var rawRequest: URLRequest?
        self.respond { request in
            if request.url?.path == "/api/fs/preview" {
                // What routes/filesystem.ts answers for an image: no content, a url
                let json = #"{"type":"image","mimeType":"image/png","url":"\#(rawPath)","size":8}"#
                return MockURLProtocol.successResponse(for: request.url!, data: Data(json.utf8))
            }
            rawRequest = request
            return MockURLProtocol.successResponse(for: request.url!, data: png)
        }
        let config = ServerConfig(host: self.host, port: 4_020)
        let keychain = MockKeychainService()
        try keychain.savePassword("the-token", for: "auth_token_\(config.id)")
        let userData = AuthenticationService.UserData(userId: "alex", authMethod: "password", loginTime: Date())
        try keychain.savePassword(
            #require(String(data: JSONEncoder().encode(userData), encoding: .utf8)),
            for: "user_data_\(config.id)")
        let auth = AuthenticationService(
            apiClient: self.client,
            serverConfig: config,
            keychainService: keychain,
            session: URLSession(configuration: .mockConfiguration))
        // The restore asks /api/auth/verify, which this handler answers with 200
        await auth.restoreTask?.value
        self.client.setAuthenticationService(auth)

        let preview = try await self.client.previewFile(path: imagePath)
        #expect(preview.type == .image)
        #expect(preview.content == nil)
        let url = try #require(preview.url)
        let data = try await self.client.downloadServerFile(at: url)

        #expect(data == png)
        let sent = try #require(rawRequest)
        #expect(sent.url?.host == self.host)
        #expect(sent.url?.path == "/api/fs/raw")
        #expect(URLComponents(url: sent.url!, resolvingAgainstBaseURL: false)?.queryItems
            == [URLQueryItem(name: "path", value: imagePath)])
        #expect(sent.value(forHTTPHeaderField: "Authorization") == "Bearer the-token")
    }

    @Test("A file url that leaves the server is refused", arguments: [
        "https://evil.example/steal", "//evil.example/steal", "api/fs/raw?path=x",
    ])
    func foreignFileURLRefused(url: String) async throws {
        self.respond { request in
            Issue.record("no request may go out, got \(request.url!)")
            return MockURLProtocol.successResponse(for: request.url!)
        }

        do {
            _ = try await self.client.downloadServerFile(at: url)
            Issue.record("Expected invalidURL")
        } catch APIError.invalidURL {
        }
    }

    @Test("Create folder posts path and name")
    func createDirectory() async throws {
        nonisolated(unsafe) var sent: [String: JSONValue]?
        self.respond { request in
            #expect(request.url?.path == "/api/fs/mkdir")
            #expect(request.httpMethod == "POST")
            sent = MockURLProtocol.jsonBody(of: request)
            return MockURLProtocol.successResponse(for: request.url!, data: Data(#"{"success":true}"#.utf8))
        }

        try await self.client.createDirectory(path: "/Users/test", name: "new-folder")

        #expect(sent?["path"] == .string("/Users/test"))
        #expect(sent?["name"] == .string("new-folder"))
    }
}
