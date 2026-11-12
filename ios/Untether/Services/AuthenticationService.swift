import Foundation

/// Errors specific to authentication operations
enum AuthenticationError: LocalizedError {
    case credentialsNotFound
    case invalidCredentials
    case tokenExpired
    case insecureConnection
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .credentialsNotFound:
            "No stored credentials found"
        case .invalidCredentials:
            "Invalid password"
        case .tokenExpired:
            "Authentication token has expired"
        case .insecureConnection:
            "Refusing to send credentials over unencrypted HTTP to a host outside your local network or Tailscale. Use https."
        case let .serverError(message):
            "Server error: \(message)"
        }
    }
}

/// Authentication service for managing JWT token-based authentication.
/// Handles login, token storage, and authentication state management.
@MainActor
final class AuthenticationService: ObservableObject {
    private let logger = Logger(category: "AuthenticationService")

    // MARK: - Published Properties

    @Published private(set) var isAuthenticated = false
    @Published private(set) var currentUser: String?
    @Published private(set) var authMethod: AuthMethod?
    @Published private(set) var authToken: String?

    // MARK: - Types

    /// Supported authentication methods.
    /// Defines the different ways users can authenticate with the server.
    enum AuthMethod: String, Codable {
        case password
        case sshKey = "ssh-key"
        case noAuth = "no-auth"
    }

    /// Server authentication configuration.
    /// Describes which authentication methods are enabled on the server.
    struct AuthConfig: Codable {
        let noAuth: Bool
        let enableSSHKeys: Bool
        let disallowUserPassword: Bool
    }

    /// Authentication response from the server.
    /// Contains authentication result and optional token/error information.
    /// Error replies (400, 403, 500) carry only `error`, so nothing here is required.
    struct AuthResponse: Codable {
        let success: Bool?
        let token: String?
        let userId: String?
        let authMethod: String?
        let error: String?
    }

    /// User authentication data stored locally.
    /// Persists user information and login metadata.
    struct UserData: Codable {
        let userId: String
        let authMethod: String
        let loginTime: Date
    }

    // MARK: - Properties

    private let apiClient: APIClient
    private let serverConfig: ServerConfig
    private let keychainService: KeychainServiceProtocol
    private let session: URLSession

    /// The restore of the saved token started by `init` (tests wait for it).
    private(set) var restoreTask: Task<Void, Never>?

    private let tokenKey: String
    private let userDataKey: String

    // MARK: - Initialization

    init(
        apiClient: APIClient,
        serverConfig: ServerConfig,
        keychainService: KeychainServiceProtocol = KeychainService(),
        session: URLSession = SecureRedirectDelegate.session)
    {
        self.apiClient = apiClient
        self.serverConfig = serverConfig
        self.keychainService = keychainService
        self.session = session
        self.tokenKey = "auth_token_\(serverConfig.id)"
        self.userDataKey = "user_data_\(serverConfig.id)"

        // Check for existing authentication
        self.restoreTask = Task {
            await self.checkExistingAuth()
        }
    }

    // MARK: - Public Methods

    /// Get authentication configuration from server
    func getAuthConfig() async throws -> AuthConfig {
        let url = self.serverConfig.apiURL(path: "/api/auth/config")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        let (data, _) = try await self.session.data(for: request)
        return try JSONDecoder().decode(AuthConfig.self, from: data)
    }

    /// Authenticate with password. The server takes the user from its own account and ignores
    /// any name sent (web/src/server/routes/auth.ts), so only the password travels.
    func authenticateWithPassword(_ password: String) async throws {
        guard self.serverConfig.allowsCredentials else { throw AuthenticationError.insecureConnection }
        let url = self.serverConfig.apiURL(path: "/api/auth/password")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["password": password])

        let (data, response) = try await self.session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        // Look at the status before the body: 400/403/500 answer {error} without `success`
        let authResponse = try? JSONDecoder().decode(AuthResponse.self, from: data)
        guard httpResponse.statusCode == 200 else {
            throw APIError.serverError(httpResponse.statusCode, authResponse?.error)
        }
        guard let authResponse, authResponse.success == true, let token = authResponse.token else {
            throw APIError.invalidResponse
        }

        let userId = authResponse.userId ?? ""
        // Store token and user data
        try self.keychainService.savePassword(token, for: self.tokenKey)

        let userData = UserData(
            userId: userId,
            authMethod: authResponse.authMethod ?? "password",
            loginTime: Date())
        let userDataJson = try JSONEncoder().encode(userData)
        guard let userDataString = String(data: userDataJson, encoding: .utf8) else {
            self.logger.error("Failed to convert user data to UTF-8 string")
            throw APIError.invalidResponse
        }
        try self.keychainService.savePassword(userDataString, for: self.userDataKey)

        // Update state
        self.authToken = token
        self.currentUser = userId
        self.authMethod = AuthMethod(rawValue: authResponse.authMethod ?? "password")
        self.isAuthenticated = true

        self.logger.info("Successfully authenticated user: \(userId)")
    }

    /// What the server says about a token.
    enum TokenCheck {
        /// 200: the token is good.
        case valid
        /// 401: the server refuses it (expired, revoked, secret changed). Log in again.
        case refused
        /// No answer worth trusting (no network, Mac asleep, proxy error): nothing is known,
        /// so nothing may be thrown away.
        case unknown
    }

    /// Ask the server whether the current token is still valid.
    func verifyToken() async -> TokenCheck {
        guard let token = authToken, self.serverConfig.allowsCredentials else { return .refused }

        let url = self.serverConfig.apiURL(path: "/api/auth/verify")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (_, response) = try await self.session.data(for: request)
            switch (response as? HTTPURLResponse)?.statusCode {
            case 200: return .valid
            case 401: return .refused
            default: return .unknown
            }
        } catch {
            self.logger.error("Token verification failed: \(error)")
            return .unknown
        }
    }

    /// Logout and clear authentication
    func logout() async {
        // Call logout endpoint if authenticated
        if let token = authToken, self.serverConfig.allowsCredentials {
            let url = self.serverConfig.apiURL(path: "/api/auth/logout")
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

            do {
                _ = try await self.session.data(for: request)
            } catch {
                self.logger.error("Logout request failed: \(error)")
            }
        }

        self.forgetToken()
    }

    /// Drops the token on this device only, without telling the server: for a token the
    /// server has already refused.
    func forgetToken() {
        try? self.keychainService.deletePassword(for: self.tokenKey)
        try? self.keychainService.deletePassword(for: self.userDataKey)

        self.authToken = nil
        self.currentUser = nil
        self.authMethod = nil
        self.isAuthenticated = false
    }

    /// Get authentication header for API requests
    func getAuthHeader() -> [String: String] {
        guard let token = authToken, self.serverConfig.allowsCredentials else { return [:] }
        return ["Authorization": "Bearer \(token)"]
    }

    /// Get token for query parameters (used for WebSocket auth)
    func getTokenForQuery() -> String? {
        self.serverConfig.allowsCredentials ? self.authToken : nil
    }

    /// Attempt automatic login using stored credentials for a server profile
    func attemptAutoLogin(profile: ServerProfile) async throws {
        self.logger
            .debug(
                "attemptAutoLogin called for profile: \(profile.name) (id: \(profile.id)), isAuthenticated: \(self.isAuthenticated)")
        self.logger.debug("Profile requiresAuth: \(profile.requiresAuth)")

        // Check if we already have valid authentication
        if self.authToken != nil {
            switch await self.verifyToken() {
            case .valid:
                self.isAuthenticated = true
                self.logger.info("Already authenticated with valid token for user: \(self.currentUser ?? "unknown")")
                return
            case .refused:
                self.logger.warning("Token refused by the server, will attempt fresh login")
                self.forgetToken()
            case .unknown:
                self.logger.warning("Token could not be verified, will attempt fresh login")
            }
        }

        // Check if profile requires authentication
        if !profile.requiresAuth {
            self.logger
                .debug(
                    "Profile does not require authentication, but server requires it - treating as credentials not found")
            throw AuthenticationError.credentialsNotFound
        }

        // Get stored password from keychain
        let password: String
        do {
            password = try self.keychainService.getPassword(for: profile.id)
        } catch {
            self.logger
                .error(
                    "Failed to retrieve password from keychain for profile: \(profile.name), error: \(error)")
            throw AuthenticationError.credentialsNotFound
        }

        // Attempt authentication with stored credentials
        do {
            try await self.authenticateWithPassword(password)
            self.logger.info("Auto-login successful")
        } catch let APIError.serverError(code, message) {
            self.logger.error("Auto-login refused: HTTP \(code)")
            // Only a 401 means the stored password is wrong; 429 (too many attempts), 403
            // (password login disabled) and the rest say why in their message
            throw code == 401
                ? AuthenticationError.invalidCredentials
                : AuthenticationError.serverError(message ?? "HTTP \(code)")
        }
        // Anything else (no network, TLS) goes up as it is: it says nothing about the password
    }

    // MARK: - Private Methods

    /// Restores the saved token when the app starts. Only the server's refusal (401) throws it
    /// away: 2026-11-10, any failure to reach the server at launch (Mac asleep, no coverage)
    /// deleted the token and forced a new login. Its lifetime is the server's business too
    /// (it used to be dropped here after 24 hours whatever the server said).
    private func checkExistingAuth() async {
        guard let token = try? keychainService.loadPassword(for: tokenKey),
              let userDataJson = try? keychainService.loadPassword(for: userDataKey),
              let userDataData = userDataJson.data(using: .utf8),
              let userData = try? JSONDecoder().decode(UserData.self, from: userDataData)
        else { return }
        // A login that finished while the keychain was read wins
        guard self.authToken == nil else { return }

        self.authToken = token
        self.currentUser = userData.userId
        self.authMethod = AuthMethod(rawValue: userData.authMethod)

        let check = await self.verifyToken()
        // A login may have replaced the token while the server was asked about the old one
        guard self.authToken == token else { return }
        switch check {
        case .valid:
            self.isAuthenticated = true
            self.logger.info("Restored authentication for user: \(userData.userId)")
        case .refused:
            self.forgetToken()
        case .unknown:
            // Kept unverified: the first request the server answers with 401 asks for a login
            self.logger.warning("Could not verify the saved token now, keeping it")
        }
    }
}
