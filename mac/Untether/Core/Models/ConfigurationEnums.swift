import Foundation

// Shared configuration enums used across the application

// MARK: - Authentication Mode

/// Represents the available authentication modes for dashboard access
enum AuthenticationMode: String, CaseIterable {
    case none
    case osAuth = "os"
    case sshKeys = "ssh"
    case both

    var displayName: String {
        switch self {
        case .none: String(localized: "auth.mode.none", defaultValue: "None", comment: "Settings, Remote Access: sign-in method, no sign-in")
        case .osAuth: "macOS"
        case .sshKeys: String(localized: "SSH Keys", comment: "Settings, Remote Access: sign-in method")
        case .both: String(localized: "macOS + SSH Keys", comment: "Settings, Remote Access: sign-in method. Keep macOS as is")
        }
    }

    var description: String {
        switch self {
        case .none:
            String(localized: "Anyone can access the dashboard (not recommended)", comment: "Settings, Remote Access: sign-in method caption")
        case .osAuth:
            String(localized: "Verify your macOS login password with macOS. Untether does not save it.", comment: "Settings, Remote Access: sign-in method caption")
        case .sshKeys:
            String(localized: "Use SSH keys from ~/.ssh/authorized_keys", comment: "Settings, Remote Access: sign-in method caption. Keep the path as is")
        case .both:
            String(localized: "Allow macOS password verification or SSH keys", comment: "Settings, Remote Access: sign-in method caption")
        }
    }
}

// MARK: - Title Mode

/// Represents the terminal window title display modes
enum TitleMode: String, CaseIterable {
    case none
    case filter
    case `static`

    var displayName: String {
        switch self {
        case .none: String(localized: "title.mode.none", defaultValue: "None", comment: "New session form: terminal title mode, the app doesn't change the title")
        case .filter: String(localized: "title.mode.filter", defaultValue: "Filter", comment: "New session form: terminal title mode, filters title changes")
        case .static: String(localized: "title.mode.static", defaultValue: "Static", comment: "New session form: terminal title mode, a fixed title")
        }
    }
}
