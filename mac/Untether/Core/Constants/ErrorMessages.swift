import Foundation

/// Centralized error messages and user-facing strings.
///
/// Localization: constants the app shows are `static var` with `String(localized:)`;
/// the remaining ones are unused.
enum ErrorMessages {
    // MARK: - Notification Errors

    // MARK: - Session Errors

    static var sessionNotFound: String {
        String(localized: "Session not found", comment: "Error: the session no longer exists")
    }
    static var operationTimeout: String {
        String(localized: "Operation timed out", comment: "Error: an operation took too long")
    }
    static var invalidRequest: String {
        String(localized: "Invalid request", comment: "Error: a request to a terminal was invalid")
    }
    static var sessionNameEmpty: String {
        String(localized: "Session name cannot be empty", comment: "Error: a session needs a name")
    }

    // MARK: - Launch/Login Errors

    // MARK: - Process Errors

    // MARK: - Keychain Errors

    // MARK: - Server Errors

    static var serverNotRunning: String {
        String(localized: "Server is not running", comment: "Error: the local server is not running")
    }
    static var invalidServerURL: String {
        String(localized: "Invalid server URL", comment: "Error: the local server address is invalid")
    }
    static var invalidServerResponse: String {
        String(localized: "Invalid server response", comment: "Error: the local server replied with something unexpected")
    }

    // MARK: - URL Scheme Errors

    // MARK: - Tunnel Errors

    static var ngrokPublicURLNotFound: String {
        String(localized: "Could not find public URL in ngrok output", comment: "Error: ngrok started but printed no public address")
    }

    static var ngrokNotInstalled: String {
        String(localized: "ngrok is not installed. Please install it using 'brew install ngrok' or download from ngrok.com", comment: "Error: ngrok is missing. brew install ngrok is a command, keep as is")
    }
    static var ngrokAuthTokenMissing: String {
        String(localized: "ngrok auth token is missing. Please add it in Settings", comment: "Error: ngrok needs an auth token, set in Settings")
    }
    static var invalidNgrokConfiguration: String {
        String(localized: "Invalid ngrok configuration", comment: "Error: ngrok settings are invalid")
    }

    // MARK: - Permission Errors

    static let permissionDenied = "Permission Denied"

    // MARK: - Terminal Errors

    static let terminalNotFound = "Terminal Not Found"

    // MARK: - CLI Tool Errors

}
