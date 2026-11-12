import Foundation

private let logger = Logger(category: "APIClient")

/// Errors that can occur during API operations.
enum APIError: LocalizedError {
    case invalidURL
    case noData
    case decodingError(Error)
    case serverError(Int, String?)
    case networkError(Error)
    case noServerConfigured
    case invalidResponse
    case resizeDisabledByServer

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .noData:
            return "No data received"
        case let .decodingError(error):
            return "Failed to decode response: \(error.localizedDescription)"
        case let .serverError(code, message):
            if let message {
                return message
            }
            switch code {
            case 400:
                return "Bad request - check your input"
            case 401:
                return "Unauthorized - authentication required"
            case 403:
                return "Forbidden - access denied"
            case 404:
                return "Not found - endpoint doesn't exist"
            case 500:
                return "Server error - internal server error"
            case 502:
                return "Bad gateway - server is down"
            case 503:
                return "Service unavailable"
            default:
                return "Server error: \(code)"
            }
        case let .networkError(error):
            if let urlError = error as? URLError {
                switch urlError.code {
                case .notConnectedToInternet:
                    return "No internet connection"
                case .cannotFindHost:
                    return "Cannot find server - check the address"
                case .cannotConnectToHost:
                    return "Cannot connect to server - is it running?"
                case .timedOut:
                    return "Connection timed out"
                case .networkConnectionLost:
                    return "Network connection lost"
                default:
                    return urlError.localizedDescription
                }
            }
            return error.localizedDescription
        case .noServerConfigured:
            return "No server configured"
        case .invalidResponse:
            return "Invalid server response"
        case .resizeDisabledByServer:
            return "Terminal resizing is disabled by the server"
        }
    }
}

/// Protocol defining the API client interface for Untether server communication.
protocol APIClientProtocol {
    func getSessions() async throws -> [Session]
    func createSession(_ data: SessionCreateData) async throws -> String
    func killSession(_ sessionId: String) async throws
    func cleanupSession(_ sessionId: String) async throws
    func cleanupAllExitedSessions() async throws -> [String]
    func killAllSessions() async throws
    func sendInput(sessionId: String, text: String) async throws
    func resizeTerminal(sessionId: String, cols: Int, rows: Int) async throws
}

/// Main API client for communicating with the Untether server.
///
/// APIClient handles all HTTP requests to the server including session management,
/// terminal I/O, and file system operations. It uses URLSession for networking
/// and provides async/await interfaces for all operations.
@MainActor
class APIClient: APIClientProtocol {
    static let shared = APIClient()
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private(set) var authenticationService: AuthenticationService?

    /// Allow dynamic base URL updates for Tailscale support
    private var overrideBaseURL: URL?

    private var baseURL: URL? {
        // Use override URL if set (for Tailscale connections)
        if let overrideURL = overrideBaseURL {
            return overrideURL
        }

        guard let config = UserDefaults.standard.data(forKey: "savedServerConfig"),
              let serverConfig = try? JSONDecoder().decode(ServerConfig.self, from: config)
        else {
            return nil
        }

        // Use the connection URL which handles Tailscale logic
        return serverConfig.connectionURL()
    }

    /// `session` is injectable so tests answer the requests themselves (MockURLProtocol)
    /// instead of reaching a real server.
    init(session: URLSession = SecureRedirectDelegate.session) {
        self.session = session
    }

    /// Updates the base URL for API requests (used for Tailscale connections)
    func updateBaseURL(_ url: URL) {
        overrideBaseURL = url
    }

    // MARK: - Session Management

    func getSessions() async throws -> [Session] {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        let url = baseURL.appendingPathComponent("api/sessions")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        self.addAuthenticationIfNeeded(&request)

        let data = try await self.send(request)


        // Debug logging
        if let jsonString = String(data: data, encoding: .utf8) {
            logger.debug("getSessions response: \(jsonString)")
        }

        do {
            return try self.decoder.decode([Session].self, from: data)
        } catch {
            logger.error("Decoding error: \(error)")
            if let decodingError = error as? DecodingError {
                logger.error("Decoding error details: \(decodingError)")
            }
            throw APIError.decodingError(error)
        }
    }

    func createSession(_ data: SessionCreateData) async throws -> String {
        guard let baseURL else {
            logger.error("No server configured")
            throw APIError.noServerConfigured
        }

        let url = baseURL.appendingPathComponent("api/sessions")
        logger.debug("Creating session at URL: \(url)")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        self.addAuthenticationIfNeeded(&request)

        do {
            request.httpBody = try self.encoder.encode(data)
            if let bodyString = String(data: request.httpBody ?? Data(), encoding: .utf8) {
                logger.debug("Request body: \(bodyString)")
            }
        } catch {
            logger.error("Failed to encode session data: \(error)")
            throw error
        }

        let responseData = try await self.send(request)

        struct CreateResponse: Codable {
            let sessionId: String
        }

        let createResponse = try decoder.decode(CreateResponse.self, from: responseData)
        logger.info("Session created with ID: \(createResponse.sessionId)")
        return createResponse.sessionId
    }

    func killSession(_ sessionId: String) async throws {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        let url = baseURL.appendingPathComponent("api/sessions/\(sessionId)")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        self.addAuthenticationIfNeeded(&request)

        _ = try await self.send(request)
    }

    func cleanupSession(_ sessionId: String) async throws {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        let url = baseURL.appendingPathComponent("api/sessions/\(sessionId)/cleanup")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        self.addAuthenticationIfNeeded(&request)

        _ = try await self.send(request)
    }

    func cleanupAllExitedSessions() async throws -> [String] {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        let url = baseURL.appendingPathComponent("api/cleanup-exited")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        self.addAuthenticationIfNeeded(&request)

        let data = try await self.send(request)

        // Handle empty response (204 No Content)
        if data.isEmpty {
            return []
        }

        struct CleanupResponse: Codable {
            let cleanedSessions: [String]
        }

        do {
            let cleanupResponse = try decoder.decode(CleanupResponse.self, from: data)
            return cleanupResponse.cleanedSessions
        } catch {
            // If decoding fails, return empty array
            return []
        }
    }

    func killAllSessions() async throws {
        // First get all sessions
        let sessions = try await getSessions()

        // Filter running sessions
        let runningSessions = sessions.filter(\.isRunning)

        // Kill each running session concurrently
        try await withThrowingTaskGroup(of: Void.self) { group in
            for session in runningSessions {
                group.addTask {
                    try await self.killSession(session.id)
                }
            }
            // Without this the group drops every child's error
            try await group.waitForAll()
        }
    }

    // MARK: - Terminal I/O

    func sendInput(sessionId: String, text: String) async throws {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        let url = baseURL.appendingPathComponent("api/sessions/\(sessionId)/input")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        self.addAuthenticationIfNeeded(&request)

        let input = TerminalInput(text: text)
        request.httpBody = try self.encoder.encode(input)

        _ = try await self.send(request)
    }

    func resizeTerminal(sessionId: String, cols: Int, rows: Int) async throws {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        let url = baseURL.appendingPathComponent("api/sessions/\(sessionId)/resize")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        self.addAuthenticationIfNeeded(&request)

        let resize = TerminalResize(cols: cols, rows: rows)
        request.httpBody = try self.encoder.encode(resize)

        _ = try await self.send(request)
    }

    // MARK: - Helpers

    /// Sends a request and returns its response once it is a 2xx. Every request goes through
    /// here so that failures always have the same shape: a transport failure is
    /// `networkError`, and any other status is `serverError` with the server's own message
    /// (`details` or `error` of its JSON reply) when it sent one.
    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await self.session.data(for: request)
        } catch let error as URLError {
            throw APIError.networkError(error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            logger.error("Invalid response type (not HTTP)")
            throw APIError.networkError(URLError(.badServerResponse))
        }

        guard 200..<300 ~= httpResponse.statusCode else {
            struct ErrorResponse: Decodable {
                let error: String?
                let details: String?
            }
            let reply = try? self.decoder.decode(ErrorResponse.self, from: data)
            logger.error("Server error: HTTP \(httpResponse.statusCode)")
            throw APIError.serverError(httpResponse.statusCode, reply?.details ?? reply?.error)
        }
        return data
    }

    /// Set the authentication service for this API client
    func setAuthenticationService(_ authService: AuthenticationService) {
        self.authenticationService = authService
    }

    private func addAuthenticationIfNeeded(_ request: inout URLRequest) {
        // Add authorization header from authentication service
        if let authHeaders = authenticationService?.getAuthHeader() {
            for (key, value) in authHeaders {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
    }

    // MARK: - File System Operations

    func browseDirectory(
        path: String,
        showHidden: Bool = false,
        gitFilter: String = "all")
        async throws -> DirectoryListing
    {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        guard var components = URLComponents(
            url: baseURL.appendingPathComponent("api/fs/browse"),
            resolvingAgainstBaseURL: false)
        else {
            throw APIError.invalidURL
        }
        components.queryItems = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "showHidden", value: String(showHidden)),
            URLQueryItem(name: "gitFilter", value: gitFilter),
        ]

        guard let url = components.url else {
            throw APIError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        // Add authentication header if needed
        self.addAuthenticationIfNeeded(&request)

        let data = try await self.send(request)

        // Decode the DirectoryListing response
        return try self.decoder.decode(DirectoryListing.self, from: data)
    }

    /// Creates the folder `name` inside `path` (`POST /api/fs/mkdir`).
    func createDirectory(path: String, name: String) async throws {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        let url = baseURL.appendingPathComponent("api/fs/mkdir")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        self.addAuthenticationIfNeeded(&request)

        struct CreateDirectoryRequest: Codable {
            let path: String
            let name: String
        }

        let requestBody = CreateDirectoryRequest(path: path, name: name)
        request.httpBody = try self.encoder.encode(requestBody)

        _ = try await self.send(request)
    }

    func previewFile(path: String) async throws -> FilePreview {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        guard var components = URLComponents(
            url: baseURL.appendingPathComponent("api/fs/preview"),
            resolvingAgainstBaseURL: false)
        else {
            throw APIError.invalidURL
        }
        components.queryItems = [URLQueryItem(name: "path", value: path)]

        guard let url = components.url else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        self.addAuthenticationIfNeeded(&request)

        let data = try await self.send(request)

        return try self.decoder.decode(FilePreview.self, from: data)
    }

    /// Downloads a file the server points to with a path of its own, like the `url` of an
    /// image preview (`/api/fs/raw?path=…`). It needs the same login as every other request,
    /// which is why a plain image view cannot load it.
    func downloadServerFile(at serverPath: String) async throws -> Data {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }
        // Only paths of this server: the token must not travel to another host
        guard serverPath.hasPrefix("/"), !serverPath.hasPrefix("//"),
              let url = URL(string: serverPath, relativeTo: baseURL)
        else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        self.addAuthenticationIfNeeded(&request)

        let data = try await self.send(request)
        return data
    }

    func getGitDiff(path: String) async throws -> FileDiff {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        guard var components = URLComponents(
            url: baseURL.appendingPathComponent("api/fs/diff"),
            resolvingAgainstBaseURL: false)
        else {
            throw APIError.invalidURL
        }
        components.queryItems = [URLQueryItem(name: "path", value: path)]

        guard let url = components.url else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        self.addAuthenticationIfNeeded(&request)

        let data = try await self.send(request)

        return try self.decoder.decode(FileDiff.self, from: data)
    }

    // MARK: - System Logs

    /// The server log, or with `tailBytes` only its end (from the first whole line on).
    func getLogsRaw(tailBytes: Int? = nil) async throws -> String {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        guard var components = URLComponents(
            url: baseURL.appendingPathComponent("api/logs/raw"),
            resolvingAgainstBaseURL: false)
        else {
            throw APIError.invalidURL
        }
        if let tailBytes {
            components.queryItems = [URLQueryItem(name: "tail", value: String(tailBytes))]
        }
        guard let url = components.url else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        self.addAuthenticationIfNeeded(&request)

        let data = try await self.send(request)

        guard let logContent = String(data: data, encoding: .utf8) else {
            throw APIError.invalidResponse
        }

        return logContent
    }

    func getLogsInfo() async throws -> LogsInfo {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        let url = baseURL.appendingPathComponent("api/logs/info")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        self.addAuthenticationIfNeeded(&request)

        let data = try await self.send(request)

        return try self.decoder.decode(LogsInfo.self, from: data)
    }

    func clearLogs() async throws {
        guard let baseURL else {
            throw APIError.noServerConfigured
        }

        let url = baseURL.appendingPathComponent("api/logs/clear")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        self.addAuthenticationIfNeeded(&request)

        _ = try await self.send(request)
    }
}

// MARK: - File Preview Types

/// Contains preview information for a file.
/// Includes content type, language hints, and metadata for display.
struct FilePreview: Codable {
    let type: FilePreviewType
    /// The text of a text file.
    let content: String?
    /// Where to download an image from (a path on the server, `/api/fs/raw?path=…`).
    let url: String?
    let language: String?
    let size: Int64?
    let mimeType: String?
}

/// Types of file previews supported by the system.
/// Determines how file content should be displayed.
enum FilePreviewType: String, Codable {
    case text
    case image
    case binary
}

/// Git diff information for a file.
/// Contains the diff content and file path.
struct FileDiff: Codable {
    let diff: String
    let path: String
}

/// Information about system log files.
/// Provides metadata about log size and modification time.
struct LogsInfo: Codable {
    let size: Int64
    let lastModified: String?
}
