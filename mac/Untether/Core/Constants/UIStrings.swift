import Foundation

/// Centralized UI strings for consistency.
///
/// Localization: only the constants the app shows are localized (`static var` with
/// `String(localized:)`); the remaining `static let` values are unused.
enum UIStrings {
    // MARK: - Common UI

    static var error: String { String(localized: "Error", comment: "Generic alert title for an error") }
    static var ok: String { String(localized: "OK", comment: "Generic alert button that dismisses the alert") }
    static let cancel = "Cancel"
    static let done = "Done"
    static let save = "Save"
    static let delete = "Delete"
    static let edit = "Edit"
    static let add = "Add"
    static let remove = "Remove"
    static let close = "Close"
    static let open = "Open"
    static let no = "No"

    // MARK: - Search

    // MARK: - Actions

    static let copy = "Copy"
    static let cut = "Cut"

    // MARK: - Status

    static let loading = "Loading..."
    static let saving = "Saving..."
    static let updating = "Updating..."
    static let connecting = "Connecting..."
    static let disconnected = "Disconnected"
    static let connected = "Connected"

    // MARK: - Validation

    static let required = "Required"
    static let optional = "Optional"
    static let invalid = "Invalid"
    static let valid = "Valid"

    // MARK: - App Names

    static let appName = "Untether"

    // MARK: - Session UI

    // MARK: - Terminal UI

    static let terminalApp = "Terminal App"
    static let accessibility = "Accessibility"

    // MARK: - Terminal Names

    static let terminal = "Terminal"
    static let iTerm2 = "iTerm2"
    static let ghostty = "Ghostty"
    static let wezTerm = "WezTerm"

    // MARK: - CLI Tool UI

    static let installCLITool = "Install Command Line Tool (ut)"
    static let uninstallCLITool = "Uninstall Command Line Tool (ut)"

    // MARK: - Dashboard UI

    static let openDashboard = "Open Dashboard"

    // MARK: - Welcome Screen

    static var welcomeTitle: String {
        String(localized: "Welcome to Untether", comment: "Welcome window title")
    }
}
