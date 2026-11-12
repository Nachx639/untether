import Foundation

/// Central location for app-wide constants and configuration values.
///
/// Provides a single source of truth for application constants, UserDefaults keys,
/// and default values. This helps maintain consistency across the app and makes
/// configuration changes easier to manage.
enum AppConstants {
    /// Current version of the welcome dialog
    /// Increment this when significant changes require re-showing the welcome flow
    static let currentWelcomeVersion = 5

    /// UserDefaults keys
    enum UserDefaultsKeys {
        static let welcomeVersion = "welcomeVersion"
        static let preventSleepWhenRunning = "preventSleepWhenRunning"

        // Server Configuration
        static let serverPort = "serverPort"
        static let dashboardAccessMode = "dashboardAccessMode"
        static let customBindAddress = "customBindAddress"
        static let cleanupOnStartup = "cleanupOnStartup"
        static let authenticationMode = "authenticationMode"

        // Development Settings
        static let debugMode = "debugMode"
        static let useDevServer = "useDevServer"
        static let devServerPath = "devServerPath"

        // Application Preferences
        static let preferredGitApp = "preferredGitApp"
        static let preferredTerminal = "preferredTerminal"
        static let showInDock = "showInDock"
        static let launchAtLogin = "autostart"
        static let remoteAccessProvider = "remoteAccessProvider"

        /// Remote Access Settings
        static let tailscaleServeEnabled = "tailscaleServeEnabled"
        static let tailscaleFunnelEnabled = "tailscaleFunnelEnabled"

        // New Session keys
        static let newSessionCommand = "NewSession.command"
        static let newSessionWorkingDirectory = "NewSession.workingDirectory"
        static let newSessionSpawnWindow = "NewSession.spawnWindow"
        static let newSessionTitleMode = "NewSession.titleMode"

        /// Quick Start Commands
        static let quickStartCommands = "quickStartCommands"
    }

    /// Raw string values for DashboardAccessMode
    enum DashboardAccessModeRawValues {
        static let localhost = "localhost"
        static let network = "network"
        static let custom = "custom"
    }

    /// Default values for UserDefaults
    enum Defaults {
        /// Sleep prevention is enabled by default for better user experience
        static let preventSleepWhenRunning = true

        // Server Configuration
        static let serverPort = 4020
        static let dashboardAccessMode = DashboardAccessModeRawValues.network
        /// 2026-10-20: off by default. Cleaning on every server start (crash restarts included)
        /// deleted exited sessions that still offered "Resume Claude" and task sessions.
        static let cleanupOnStartup = false
        static let authenticationMode = "os"

        // Development Settings
        static let debugMode = false
        static let useDevServer = false
        static let devServerPath = ""

        // Application Preferences
        /// One default for the Dock icon: shown. 2026-11-11: this said false while the app
        /// registered true and the settings toggle started at true.
        static let showInDock = true

        /// Tailscale Settings
        static let tailscaleServeEnabled: Bool? = nil // Use existing UserDefaults value if set
        static let tailscaleFunnelEnabled = false // Default to OFF for security
    }

    /// Helper to get boolean value with proper default
    static func boolValue(for key: String) -> Bool {
        // If the key doesn't exist in UserDefaults, return our default
        if appDefaults.object(forKey: key) == nil {
            switch key {
            case UserDefaultsKeys.preventSleepWhenRunning:
                return Defaults.preventSleepWhenRunning
            case UserDefaultsKeys.cleanupOnStartup:
                return Defaults.cleanupOnStartup
            case UserDefaultsKeys.debugMode:
                return Defaults.debugMode
            case UserDefaultsKeys.useDevServer:
                return Defaults.useDevServer
            case UserDefaultsKeys.showInDock:
                return Defaults.showInDock
            case UserDefaultsKeys.tailscaleServeEnabled:
                return Defaults.tailscaleServeEnabled ?? false
            case UserDefaultsKeys.tailscaleFunnelEnabled:
                return Defaults.tailscaleFunnelEnabled
            default:
                return false
            }
        }
        return appDefaults.bool(forKey: key)
    }

    /// Helper to get string value with proper default
    static func stringValue(for key: String) -> String {
        // First check if we have a string value
        if let value = appDefaults.string(forKey: key) {
            return value
        }

        // If the key doesn't exist at all, return our default
        if appDefaults.object(forKey: key) == nil {
            switch key {
            case UserDefaultsKeys.dashboardAccessMode:
                return Defaults.dashboardAccessMode
            case UserDefaultsKeys.authenticationMode:
                return Defaults.authenticationMode
            case UserDefaultsKeys.devServerPath:
                return Defaults.devServerPath
            default:
                return ""
            }
        }

        // Key exists but contains non-string value, return empty string
        return ""
    }

    /// Helper to get integer value with proper default
    static func intValue(for key: String) -> Int {
        // If the key doesn't exist in UserDefaults, return our default
        if appDefaults.object(forKey: key) == nil {
            switch key {
            case UserDefaultsKeys.serverPort:
                return Defaults.serverPort
            default:
                return 0
            }
        }
        return appDefaults.integer(forKey: key)
    }
}

// MARK: - Convenience Methods

extension AppConstants {

    /// Get development status for UI display
    static func getDevelopmentStatus() -> (debugMode: Bool, useDevServer: Bool) {
        let debug = DebugConfig.current()
        let devServer = DevServerConfig.current()
        return (debug.debugMode, devServer.useDevServer)
    }

    /// Preference helpers
    static func getPreferredGitApp() -> String? {
        appDefaults.string(forKey: UserDefaultsKeys.preferredGitApp)
    }

    static func setPreferredGitApp(_ app: String?) {
        if let app {
            appDefaults.set(app, forKey: UserDefaultsKeys.preferredGitApp)
        } else {
            appDefaults.removeObject(forKey: UserDefaultsKeys.preferredGitApp)
        }
    }

    static func getPreferredTerminal() -> String? {
        appDefaults.string(forKey: UserDefaultsKeys.preferredTerminal)
    }

    static func setPreferredTerminal(_ terminal: String?) {
        if let terminal {
            appDefaults.set(terminal, forKey: UserDefaultsKeys.preferredTerminal)
        } else {
            appDefaults.removeObject(forKey: UserDefaultsKeys.preferredTerminal)
        }
    }
}
