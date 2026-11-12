import Foundation
import os.log
import SwiftUI

/// Protocol defining the interface for server list view model
@MainActor
protocol ServerListViewModelProtocol: Observable {
    var profiles: [ServerProfile] { get }
    var isLoading: Bool { get }
    var errorMessage: String? { get set }
    var showLoginView: Bool { get set }
    var currentConnectingProfile: ServerProfile? { get set }
    var connectionManager: ConnectionManager { get }

    func loadProfiles()
    func addProfile(_ profile: ServerProfile, password: String?) async throws
    func updateProfile(_ profile: ServerProfile, password: String?) async throws
    func deleteProfile(_ profile: ServerProfile) async throws
    func initiateConnectionToProfile(_ profile: ServerProfile) async
    func handleLoginSuccess(password: String) async throws
    func getPassword(for profile: ServerProfile) -> String?
}

/// View model for ServerListView - managing server profiles
@MainActor
@Observable
class ServerListViewModel: ServerListViewModelProtocol {
    var profiles: [ServerProfile] = []
    var isLoading = false
    var errorMessage: String?
    var showLoginView = false
    var currentConnectingProfile: ServerProfile?
    var connectionStatusMessage: String?

    let connectionManager: ConnectionManager
    private let networkMonitor: NetworkMonitoring
    private let keychainService: KeychainServiceProtocol
    private let userDefaults: UserDefaults

    // Logger instances
    private let connectionLogger = Logger(category: "ServerList.Connection")
    private let authLogger = Logger(category: "ServerList.Authentication")
    private let credentialsLogger = Logger(category: "ServerList.Credentials")

    init(
        connectionManager: ConnectionManager = ConnectionManager.shared,
        networkMonitor: NetworkMonitoring = NetworkMonitor.shared,
        keychainService: KeychainServiceProtocol = KeychainService(),
        userDefaults: UserDefaults = .standard
    ) {
        self.connectionManager = connectionManager
        self.networkMonitor = networkMonitor
        self.keychainService = keychainService
        self.userDefaults = userDefaults
        loadProfiles()
    }

    func loadProfiles() {
        profiles = ServerProfile.loadAll(from: userDefaults).sorted { profile1, profile2 in
            // Sort by last connected (most recent first), then by name
            if let date1 = profile1.lastConnected, let date2 = profile2.lastConnected {
                date1 > date2
            } else if profile1.lastConnected != nil {
                true
            } else if profile2.lastConnected != nil {
                false
            } else {
                profile1.name < profile2.name
            }
        }
    }

    func loadProfilesAndCheckHealth() {
        loadProfiles()

        // Check health of all profiles in background
        Task {
            await checkAndUpdateAllProfiles()
        }
    }

    func addProfile(_ profile: ServerProfile, password: String? = nil) async throws {
        ServerProfile.save(profile, to: userDefaults)

        // Save password to keychain if provided
        if let password, !password.isEmpty {
            try keychainService.savePassword(password, for: profile.id)
        }

        loadProfiles()
    }

    func updateProfile(_ profile: ServerProfile, password: String? = nil) async throws {
        var updatedProfile = profile
        updatedProfile.updatedAt = Date()
        ServerProfile.save(updatedProfile, to: userDefaults)

        // Handle password updates based on auth requirement
        if !profile.requiresAuth {
            // If profile doesn't require auth, remove any stored password
            try? keychainService.deletePassword(for: profile.id)
        } else if let password {
            if password.isEmpty {
                // Delete password if empty string provided
                try keychainService.deletePassword(for: profile.id)
            } else {
                // Save new password
                try keychainService.savePassword(password, for: profile.id)
            }
        }
        // If password is nil and profile requires auth, leave existing password unchanged

        loadProfiles()
    }

    func deleteProfile(_ profile: ServerProfile) async throws {
        ServerProfile.delete(profile, from: userDefaults)

        // Delete password from keychain
        try keychainService.deletePassword(for: profile.id)

        loadProfiles()
    }

    func getPassword(for profile: ServerProfile) -> String? {
        do {
            return try keychainService.getPassword(for: profile.id)
        } catch {
            // Password not found or error occurred
            return nil
        }
    }

    func connectToProfile(_ profile: ServerProfile) async throws {
        // connectionLogger.info("🔗 Starting connection to profile: \(profile.name) (id: \(profile.id))")
        connectionLogger.debug("🔗 Profile details: requiresAuth=\(profile.requiresAuth)")

        // Log profile URL and connection details
        // connectionLogger.info("🔗 Profile URL: \(profile.url)")
        // connectionLogger.info("🔗 HTTPS Available: \(profile.httpsAvailable), Prefer SSL: \(profile.preferSSL)")
        // connectionLogger.info("🔗 Tailscale Hostname: \(profile.tailscaleHostname ?? "nil")")

        isLoading = true
        errorMessage = nil
        showLoginView = false
        defer { isLoading = false }

        // Create server config
        guard var config = profile.toServerConfig() else {
            connectionLogger.error("🔗 ❌ Failed to create server config")
            throw APIError.invalidURL
        }
        // connectionLogger.info("🔗 ✅ Created server config:")
        // connectionLogger.info("🔗   - baseURL: \(config.baseURL)")
        // connectionLogger.info("🔗   - connectionURL: \(config.connectionURL())")
        // connectionLogger.info("🔗   - httpsAvailable: \(config.httpsAvailable)")
        // connectionLogger.info("🔗   - preferSSL: \(config.preferSSL)")
        // connectionLogger.info("🔗   - isPublic: \(config.isPublic)")
        // connectionLogger.info("🔗   - host: \(config.host)")
        // connectionLogger.info("🔗   - port: \(config.port)")

        // Try connection with current settings first
        var fallbackAttempted = false

        do {
            // Save connection - this sets up the AuthenticationService
            connectionManager.saveConnection(config)
            connectionLogger.debug("🔗 ✅ Saved connection to manager")

            // Get auth service
            guard let authService = connectionManager.authenticationService else {
                connectionLogger.error("🔗 ❌ No authentication service available")
                throw APIError.noServerConfigured
            }
            connectionLogger.debug("🔗 ✅ Got authentication service")

            // Check if server requires authentication
            let authConfig = try await authService.getAuthConfig()
            connectionLogger.debug("🔗 Auth config: noAuth=\(authConfig.noAuth)")

            if authConfig.noAuth {
                // No auth required, test connection directly
                // connectionLogger.info("🔗 No auth required, testing connection directly")
                _ = try await connectionManager.apiClient.getSessions()
                connectionManager.isConnected = true
                ServerProfile.updateLastConnected(for: profile.id, in: userDefaults)
                loadProfiles()
                // connectionLogger.info("🔗 ✅ Connection successful (no auth)")
                return
            }

            // Authentication required - attempt auto-login
            // connectionLogger.info("🔗 Authentication required, attempting auto-login")
            try await authService.attemptAutoLogin(profile: profile)
            // connectionLogger.info("🔗 ✅ Auto-login successful")

            // Auto-login successful, test connection
            _ = try await connectionManager.apiClient.getSessions()
            connectionManager.isConnected = true
            ServerProfile.updateLastConnected(for: profile.id, in: userDefaults)
            loadProfiles()
            // connectionLogger.info("🔗 ✅ Connection fully established")
            connectionLogger.debug(
                "🔗 📊 ConnectionManager state: isConnected=\(connectionManager.isConnected), serverConfig=\(connectionManager.serverConfig != nil ? "✅" : "❌")"
            )
        } catch let authError as AuthenticationError {
            // Handle authentication errors first
            connectionLogger.error("🔗 ❌ Authentication error: \(authError)")
            // connectionLogger.info("🔗 🔐 Authentication error detected, showing login view")

            // Auto-login failed, show login view
            authLogger.warning("🔗 ⚠️ Auto-login failed: \(authError.localizedDescription)")

            // If profile says no auth required but server requires it, update profile
            if !profile.requiresAuth {
                switch authError {
                case .credentialsNotFound:
                    authLogger.info("🔗 📝 Updating profile to require authentication")
                    var updatedProfile = profile
                    updatedProfile.requiresAuth = true
                    ServerProfile.replaceExisting(updatedProfile, in: userDefaults)
                    loadProfiles()
                default:
                    break
                }
            }

            // Show login screen with the connecting profile
            currentConnectingProfile = profile
            showLoginView = true

            // Throw the error to be caught in initiateConnectionToProfile
            throw authError
        } catch {
            connectionLogger.error("🔗 ❌ Initial connection failed: \(error)")
            // connectionLogger.info("🔗 Error type: \(String(describing: type(of: error)))")

            // Explicit HTTPS profiles must never retry authentication over HTTP.
            if config.scheme == .http, profile.isTailscaleEnabled, config.httpsAvailable, config.preferSSL,
               !fallbackAttempted
            {
                connectionLogger.warning("🔗 ⚠️ HTTPS connection failed, trying HTTP fallback")
                // connectionLogger.info("🔗 Error type: \(String(describing: type(of: error)))")

                connectionStatusMessage = "HTTPS unavailable, switching to HTTP..."
                fallbackAttempted = true

                // First, do a health check to get current server state
                if let healthProfile = await checkServerHealth(for: profile) {
                    connectionLogger
                        .info(
                            "🔗 Health check result - HTTPS: \(healthProfile.httpsAvailable), Public: \(healthProfile.isPublic)"
                        )

                    // Save the updated profile from health check
                    ServerProfile.replaceExisting(healthProfile, in: userDefaults)

                    // Create new config from health check results
                    guard var newConfig = healthProfile.toServerConfig() else {
                        connectionLogger.error("🔗 ❌ Failed to create config from health check")
                        throw APIError.invalidURL
                    }

                    // Force HTTP for this attempt
                    newConfig.httpsAvailable = false
                    newConfig.preferSSL = false

                    // connectionLogger.info("🔗 Retrying with HTTP: \(newConfig.connectionURL())")

                    // Save and retry with HTTP config
                    connectionManager.saveConnection(newConfig)

                    // Try connection again with updated config
                    do {
                        guard let authService = connectionManager.authenticationService else {
                            throw APIError.noServerConfigured
                        }

                        let authConfig = try await authService.getAuthConfig()

                        if authConfig.noAuth {
                            _ = try await connectionManager.apiClient.getSessions()
                            connectionManager.isConnected = true
                            ServerProfile.updateLastConnected(for: healthProfile.id, in: userDefaults)
                            loadProfiles()
                            // connectionLogger.info("🔗 ✅ HTTP fallback successful (no auth)")
                            connectionStatusMessage = nil
                            return
                        } else {
                            try await authService.attemptAutoLogin(profile: healthProfile)
                            _ = try await connectionManager.apiClient.getSessions()
                            connectionManager.isConnected = true
                            ServerProfile.updateLastConnected(for: healthProfile.id, in: userDefaults)
                            loadProfiles()
                            // connectionLogger.info("🔗 ✅ HTTP fallback successful (with auth)")
                            connectionStatusMessage = nil
                            return
                        }
                    } catch {
                        connectionLogger.error("🔗 ❌ HTTP fallback also failed: \(error)")
                    }
                } else {
                    connectionLogger.warning("🔗 ⚠️ Health check failed, trying blind HTTP fallback")

                    // Blind fallback without health check
                    config.httpsAvailable = false
                    config.preferSSL = false
                    config.isPublic = false

                    var updatedProfile = profile
                    updatedProfile.httpsAvailable = false
                    updatedProfile.preferSSL = false
                    updatedProfile.isPublic = false
                    ServerProfile.replaceExisting(updatedProfile, in: userDefaults)

                    connectionManager.saveConnection(config)

                    // Try one more time with HTTP
                    do {
                        guard let authService = connectionManager.authenticationService else {
                            throw APIError.noServerConfigured
                        }

                        let authConfig = try await authService.getAuthConfig()

                        if authConfig.noAuth {
                            _ = try await connectionManager.apiClient.getSessions()
                            connectionManager.isConnected = true
                            ServerProfile.updateLastConnected(for: updatedProfile.id, in: userDefaults)
                            loadProfiles()
                            // connectionLogger.info("🔗 ✅ Blind HTTP fallback successful")
                            connectionStatusMessage = nil
                            return
                        } else {
                            try await authService.attemptAutoLogin(profile: updatedProfile)
                            _ = try await connectionManager.apiClient.getSessions()
                            connectionManager.isConnected = true
                            ServerProfile.updateLastConnected(for: updatedProfile.id, in: userDefaults)
                            loadProfiles()
                            // connectionLogger.info("🔗 ✅ Blind HTTP fallback successful (with auth)")
                            connectionStatusMessage = nil
                            return
                        }
                    } catch {
                        connectionLogger.error("🔗 ❌ Blind HTTP fallback also failed: \(error)")
                    }
                }
            }

            // Only update Tailscale servers after failure (they might have switched modes)
            if profile.isTailscaleEnabled {
                // connectionLogger.info("🔗 📊 Updating Tailscale server UI after connection failure")
                if let healthProfile = await checkServerHealth(for: profile) {
                    connectionLogger
                        .info(
                            "🔗 📊 Server actual state - HTTPS: \(healthProfile.httpsAvailable), Public: \(healthProfile.isPublic)"
                        )
                    connectionLogger
                        .info("🔗 📊 Profile was - HTTPS: \(profile.httpsAvailable), Public: \(profile.isPublic)")

                    // Save the actual server state to update UI
                    ServerProfile.replaceExisting(healthProfile, in: userDefaults)

                    // Force UI refresh to show correct lock/unlock icons
                    await MainActor.run {
                        loadProfiles()
                    }

                    // connectionLogger.info("🔗 ✅ UI updated to reflect server state change")
                } else {
                    // Nothing is known about a server that does not answer: the profile stays
                    // as it is. 2026-11-10: it was rewritten as HTTP-only, and an https
                    // Tailscale profile never connected again (https to the 100.x address).
                    connectionLogger.warning("🔗 ⚠️ Could not determine server state, profile left unchanged")
                }
            }

            // Clear status message
            connectionStatusMessage = nil

            // Handle specific error types for user feedback
            if let apiError = error as? APIError {
                switch apiError {
                case .serverError(401, _):
                    // Authentication required but no auto-login available
                    showLoginView = true
                    return
                case .networkError:
                    errorMessage = "Cannot connect to server. Please check the server is running and accessible."
                    connectionLogger.error("🔗 ❌ Network error: Server not accessible")
                    // Don't throw - let user see error but don't block UI
                    return
                default:
                    errorMessage = "Connection failed. The server may have switched between public and private mode. Please tap refresh and try again."
                    // Don't throw - let user see error but don't block UI
                    return
                }
            } else {
                errorMessage = "Connection failed: \(error.localizedDescription)"
                // Don't throw - let user see error but don't block UI
                return
            }
        }
    }

    /// Check and update all saved profiles with current server state
    func checkAndUpdateAllProfiles() async {
        var hasChanges = false

        // Only Tailscale-enabled servers are checked
        for profile in profiles where profile.isTailscaleEnabled {
            guard let checked = await checkServerHealth(for: profile) else { continue }

            if checked.httpsAvailable != profile.httpsAvailable ||
                checked.isPublic != profile.isPublic ||
                checked.preferSSL != profile.preferSSL
            {
                connectionLogger
                    .info(
                        "🔍 Profile \(profile.name) updated - HTTPS: \(checked.httpsAvailable), Public: \(checked.isPublic), PreferSSL: \(checked.preferSSL)"
                    )
                // Only what the check found, on the profile as it is saved now: saving the
                // copies read before the waits brought back a profile deleted meanwhile and
                // undid any other change
                ServerProfile.update(id: profile.id, in: userDefaults) {
                    $0.httpsAvailable = checked.httpsAvailable
                    $0.isPublic = checked.isPublic
                    $0.preferSSL = checked.preferSSL
                }
                hasChanges = true
            }
        }

        if hasChanges {
            loadProfiles()
        }
    }

    /// Check server health and return updated profile
    private func checkServerHealth(for profile: ServerProfile) async -> ServerProfile? {
        let probeHost = profile.host ?? URL(string: profile.url)?.host
        guard let probeHost else {
            connectionLogger.error("🔍 No host found for profile \(profile.name)")
            return nil
        }

        let healthURL: URL? = if let config = profile.toServerConfig(), config.scheme == .https {
            config.apiURL(path: "/api/health")
        } else {
            // The port the connection uses (one source for both)
            URL(string: "http://\(probeHost):\(profile.toServerConfig()?.port ?? 4_020)/api/health")
        }
        var updatedProfile = profile

        // connectionLogger.info("🔍 Probing health at: \(healthURL)")

        do {
            if let url = healthURL {
                // Quick timeout: this only asks whether the server is there
                var request = URLRequest(url: url)
                request.timeoutInterval = 2.0
                let (data, response) = try await connectionManager.urlSession.data(for: request)

                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                    // connectionLogger.info("🔍 Health endpoint responded with 200")

                    // Parse health response
                    if let health = try? JSONDecoder().decode(HealthResponse.self, from: data),
                       let connections = health.connections
                    {
                        // connectionLogger.info("🔍 Health data connections: \(connections)")

                        // Check for Tailscale info
                        if let tailscale = connections.tailscale {
                            let httpsAvailable = tailscale.httpsAvailable ?? false
                            let isPublic = tailscale.isPublic ?? false

                            // connectionLogger.info("🔍 Tailscale data - HTTPS: \(httpsAvailable), Public: \(isPublic)")

                            updatedProfile.httpsAvailable = httpsAvailable
                            updatedProfile.isPublic = isPublic
                            updatedProfile.preferSSL = httpsAvailable

                            return updatedProfile
                        }

                        // Fallback to general connection info
                        let httpsAvailable = connections.sslAvailable ?? false
                        let isPublic = connections.isPublic ?? false

                        connectionLogger
                            .info("🔍 General connection data - HTTPS: \(httpsAvailable), Public: \(isPublic)")

                        updatedProfile.httpsAvailable = httpsAvailable
                        updatedProfile.isPublic = isPublic
                        updatedProfile.preferSSL = httpsAvailable

                        return updatedProfile
                    }
                }
            }
        } catch {
            connectionLogger.debug("🔍 Health check failed for \(profile.name): \(error.localizedDescription)")
        }

        return nil
    }

    /// Connects again to the server whose token was refused (`ConnectionManager.requireLogin`):
    /// with the stored password nobody sees anything; without it the login sheet opens.
    func loginAgainIfRequired() async {
        guard let serverID = connectionManager.loginRequiredServerID else { return }
        connectionManager.loginRequiredServerID = nil
        let profile = ServerProfile.loadAll(from: userDefaults)
            .first { $0.toServerConfig()?.id == serverID }
        guard let profile else { return }
        await initiateConnectionToProfile(profile)
    }

    /// Initiate connection to a profile (replaces View logic)
    func initiateConnectionToProfile(_ profile: ServerProfile) async {
        // connectionLogger.info("🔗 initiateConnectionToProfile called for: \(profile.name)")
        connectionLogger
            .info("🔗 Profile details - URL: \(profile.url), HTTPS: \(profile.httpsAvailable), SSL: \(profile.preferSSL)"
            )

        guard networkMonitor.isConnected else {
            connectionLogger.error("🔗 ❌ No network connection")
            errorMessage = "No internet connection available"
            return
        }
        // connectionLogger.info("🔗 Network connection available")

        // Store the current profile for potential login callback
        currentConnectingProfile = profile

        // Try to connect with the current profile settings
        // connectionLogger.info("🔗 Attempting connection with current profile settings")

        do {
            // connectionLogger.info("🔗 Calling connectToProfile...")
            try await connectToProfile(profile)
            // connectToProfile reports most failures through errorMessage without
            // throwing: clearing it here would hide them from the user
        } catch {
            connectionLogger.error("🔗 ❌ Connection failed: \(error)")

            // If it was an auth error, show login view
            // Otherwise, show error to user
            if error is AuthenticationError {
                // connectionLogger.info("🔗 🔐 Authentication error detected, showing login view")
                showLoginView = true
                currentConnectingProfile = profile
            } else {
                errorMessage = "Failed to connect to \(profile.name). The server may have changed its connection mode. Please tap the refresh button and try again."
            }
        }
    }

    /// Handle successful login and save credentials
    func handleLoginSuccess(password: String) async throws {
        guard let profile = currentConnectingProfile else {
            credentialsLogger.warning("⚠️ No current connecting profile found")
            throw AuthenticationError.invalidCredentials
        }

        credentialsLogger.info("💾 Saving credentials after successful login for profile: \(profile.name)")

        // Save password to keychain with profile ID
        if !password.isEmpty {
            try keychainService.savePassword(password, for: profile.id)
            credentialsLogger.info("💾 Password saved to keychain successfully")
        }

        // The profile needs a login from now on
        var updatedProfile = profile
        updatedProfile.requiresAuth = true
        ServerProfile.replaceExisting(updatedProfile, in: userDefaults)

        // Mark connection as successful
        connectionManager.isConnected = true

        // Reload profiles to reflect changes
        loadProfiles()
    }
}
