import Foundation

/// Centralized environment variable names
enum EnvironmentKeys {
    // MARK: - System Environment

    static let path = "PATH"
    static let lang = "LANG"

    // MARK: - Test Environment

    static let xcTestConfigurationFilePath = "XCTestConfigurationFilePath"

    // MARK: - Untether Environment

    static let parentPID = "PARENT_PID"
    static let useDevelopmentServer = "USE_DEVELOPMENT_SERVER"
    static let authenticationMode = "AUTHENTICATION_MODE"
    static let authToken = "AUTH_TOKEN"

    // MARK: - Third-party Tunnels

    /// ngrok reads the account authtoken from this variable, so it never has to
    /// appear on the process command line (readable by any local `ps -ww`).
    static let ngrokAuthToken = "NGROK_AUTHTOKEN"
}
