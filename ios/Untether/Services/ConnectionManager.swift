import Foundation
import Observation

/// Manages the server connection state and configuration.
///
/// ConnectionManager handles saving and loading server configurations,
/// tracking connection state, and providing a central point for
/// connection-related operations.
@Observable
@MainActor
final class ConnectionManager {
    static let shared = ConnectionManager()

    // MARK: - Constants

    private enum Constants {
        static let connectionRestorationWindow: TimeInterval = 3_600 // 1 hour
        static let savedServerConfigKey = "savedServerConfig"
        static let connectionStateKey = "connectionState"
        static let lastConnectionTimeKey = "lastConnectionTime"
        static let connectionTypeKey = "connectionType"
    }

    // MARK: - Connection Type

    enum ActiveConnectionType: String {
        case local
        case tailscale
        case unknown
    }

    var isConnected: Bool = false {
        didSet {
            guard oldValue != isConnected else { return }
            storage.set(isConnected, forKey: Constants.connectionStateKey)
            // Views that stayed subscribed through a login get their stream back
            if isConnected {
                webSocketClient.reconnectIfNeeded()
            }
        }
    }

    var serverConfig: ServerConfig?
    /// The server (`ServerConfig.id`) whose saved token was refused: the server list logs in
    /// to it again, silently with the stored password or with the login sheet.
    var loginRequiredServerID: String?
    var lastConnectionTime: Date?
    var activeConnectionType: ActiveConnectionType = .unknown
    private(set) var authenticationService: AuthenticationService?
    private let storage: PersistentStorage
    private let tailscaleService = TailscaleService.shared

    // What the connection talks through. The app uses the shared ones; a test gives its own,
    // so that nothing it does reaches a real server, the real keychain or the app's socket.
    let apiClient: APIClient
    private let webSocketClient: BufferWebSocketClient
    private let keychainService: KeychainServiceProtocol
    /// Session for logins and for quick "is the server there" probes.
    let urlSession: URLSession

    private init(
        storage: PersistentStorage = UserDefaultsStorage(),
        apiClient: APIClient = .shared,
        webSocketClient: BufferWebSocketClient = .shared,
        keychainService: KeychainServiceProtocol = KeychainService(),
        urlSession: URLSession = SecureRedirectDelegate.session)
    {
        self.storage = storage
        self.apiClient = apiClient
        self.webSocketClient = webSocketClient
        self.keychainService = keychainService
        self.urlSession = urlSession
        loadSavedConnection()
        restoreConnectionState()
    }

    #if DEBUG
        /// Test-only factory: mock storage, and a URLSession of the test's (MockURLProtocol)
        /// behind its own API client, socket client and keychain. 2026-11-10: tests built with
        /// this used APIClient.shared and the real keychain and connected to
        /// http://localhost:4020, the real Untether of the Mac that runs the tests.
        static func createForTesting(
            storage: PersistentStorage,
            urlSession: URLSession,
            keychainService: KeychainServiceProtocol)
            -> ConnectionManager
        {
            ConnectionManager(
                storage: storage,
                apiClient: APIClient(session: urlSession),
                webSocketClient: BufferWebSocketClient(),
                keychainService: keychainService,
                urlSession: urlSession)
        }
    #endif

    private func loadSavedConnection() {
        if let data = storage.data(forKey: Constants.savedServerConfigKey),
           let config = try? JSONDecoder().decode(ServerConfig.self, from: data)
        {
            self.serverConfig = config

            // Set up authentication service for restored connection
            authenticationService = AuthenticationService(
                apiClient: self.apiClient,
                serverConfig: config,
                keychainService: self.keychainService,
                session: self.urlSession
            )

            // Configure API client and WebSocket client with auth service
            if let authService = authenticationService {
                self.apiClient.setAuthenticationService(authService)
                self.webSocketClient.setAuthenticationService(authService)
            }
        }
    }

    private func restoreConnectionState() {
        // Restore connection state if app was terminated while connected
        let wasConnected = storage.bool(forKey: Constants.connectionStateKey)
        if let lastConnectionData = storage.object(forKey: Constants.lastConnectionTimeKey) as? Date {
            lastConnectionTime = lastConnectionData

            // Only restore connection if it was within the last hour
            let timeSinceLastConnection = Date().timeIntervalSince(lastConnectionData)
            if wasConnected && timeSinceLastConnection < Constants.connectionRestorationWindow && serverConfig != nil {
                // Attempt to restore connection
                isConnected = true
            } else {
                // Clear stale connection state
                isConnected = false
            }
        }
    }

    func saveConnection(_ config: ServerConfig) {
        if let data = try? JSONEncoder().encode(config) {
            // The shared socket belongs to the previous server and token: close it, the next
            // subscriber opens one for this server
            self.webSocketClient.disconnect()

            // Update API client base URL with the optimal connection URL
            // This will use HTTPS if available and preferred
            self.apiClient.updateBaseURL(config.connectionURL())

            // Create and configure authentication service BEFORE saving config
            // This prevents race conditions where other components try to use
            // the API client before authentication is properly configured
            authenticationService = AuthenticationService(
                apiClient: self.apiClient,
                serverConfig: config,
                keychainService: self.keychainService,
                session: self.urlSession
            )

            // Configure API client and WebSocket client with auth service
            if let authService = authenticationService {
                self.apiClient.setAuthenticationService(authService)
                self.webSocketClient.setAuthenticationService(authService)
            }

            // Now save the config and timestamp after auth is set up
            storage.set(data, forKey: Constants.savedServerConfigKey)
            self.serverConfig = config

            // Save connection timestamp
            lastConnectionTime = Date()
            storage.set(lastConnectionTime, forKey: Constants.lastConnectionTimeKey)

            // Determine and save connection type
            activeConnectionType = determineConnectionType(for: config)
            storage.set(activeConnectionType.rawValue, forKey: Constants.connectionTypeKey)
        }
    }

    func disconnect() async {
        self.webSocketClient.disconnect()
        loginRequiredServerID = nil
        isConnected = false
        activeConnectionType = .unknown
        storage.removeObject(forKey: Constants.connectionStateKey)
        storage.removeObject(forKey: Constants.lastConnectionTimeKey)
        storage.removeObject(forKey: Constants.connectionTypeKey)

        await authenticationService?.logout()
        authenticationService = nil
    }

    /// The server refused the saved token (HTTP 401, or WebSocket close 4401). Unlike
    /// `disconnect()` this is not the user leaving: the server stays selected and the server
    /// list is asked to log in to it again.
    func requireLogin() {
        guard let config = serverConfig else { return }
        self.webSocketClient.disconnect()
        authenticationService?.forgetToken()
        isConnected = false
        loginRequiredServerID = config.id
    }

    var currentServerConfig: ServerConfig? {
        serverConfig
    }

    // MARK: - Tailscale Support

    /// Determines the best connection type for a server config
    private func determineConnectionType(for config: ServerConfig) -> ActiveConnectionType {
        // Check if we're on the same local network
        if isOnSameLocalNetwork(config: config) {
            return .local
        }

        // Check if Tailscale is available and configured
        if config.isTailscaleEnabled && tailscaleService.isRunning {
            return .tailscale
        }

        // Default to local if nothing else matches
        return config.tailscaleHostname != nil ? .tailscale : .local
    }

    /// Checks if the device is on the same local network as the server
    private func isOnSameLocalNetwork(config: ServerConfig) -> Bool {
        // Simple check: if host is localhost or a local IP
        let host = config.host.lowercased()
        return host == "localhost" ||
            host == "127.0.0.1" ||
            host.starts(with: "192.168.") ||
            host.starts(with: "10.") ||
            host.starts(with: "172.") ||
            host.hasSuffix(".local")
    }

    /// Optimizes server config based on current network conditions
    func optimizeServerConfig(_ config: ServerConfig) async -> ServerConfig {
        var optimized = config

        // If Tailscale is available and we're not on local network, prefer it
        if !isOnSameLocalNetwork(config: config) && tailscaleService.isRunning {
            optimized.preferTailscale = true

            // Try to get Tailscale details if not already set
            if optimized.tailscaleIP == nil {
                // Could probe for the server's Tailscale IP here
                // For now, we'll rely on the hostname
            }
        }

        return optimized
    }

    /// Updates the connection URL based on current network conditions
    func updateConnectionURL() async {
        guard let config = serverConfig else { return }

        // Re-evaluate the best connection method
        let optimized = await optimizeServerConfig(config)
        if optimized != config {
            serverConfig = optimized
            activeConnectionType = determineConnectionType(for: optimized)

            // Update stored config
            if let data = try? JSONEncoder().encode(optimized) {
                storage.set(data, forKey: Constants.savedServerConfigKey)
            }

            // Update API client base URL if needed
            self.apiClient.updateBaseURL(optimized.connectionURL())
        }
    }
}
