import Foundation

/// User-facing alert content for terminal launch failures.
struct TerminalLaunchAlertContent {
    let title: String
    let message: String
    let recoveryPermission: SystemPermission?

    private init(
        title: String,
        message: String,
        recoveryPermission: SystemPermission?)
    {
        self.title = title
        self.message = message
        self.recoveryPermission = recoveryPermission
    }

    init(error: Error, terminalName: String) {
        guard let terminalError = error as? TerminalLauncherError else {
            self.title = Self.launchFailedTitle
            self.message = error.localizedDescription
            self.recoveryPermission = nil
            return
        }

        switch terminalError {
        case .appleScriptPermissionDenied:
            self = Self.automationPermissionDenied
        case .accessibilityPermissionDenied:
            self = Self.accessibilityPermissionDenied(terminalName: terminalName)
        case .terminalNotFound:
            self.title = String(localized: "Terminal Not Found", comment: "Alert title: the chosen terminal app is missing")
            self.message = String(
                localized: "The selected terminal application could not be found. Please select a different terminal.",
                comment: "Alert message: the chosen terminal app is missing")
            self.recoveryPermission = nil
        case let .appleScriptExecutionFailed(details, errorCode):
            self = Self.appleScriptExecutionFailure(
                details: details,
                errorCode: errorCode,
                terminalName: terminalName)
        case let .processLaunchFailed(details):
            self.title = String(localized: "Process Launch Failed", comment: "Alert title: the terminal process didn't start")
            self.message = String(
                localized: "Failed to start terminal process: \(details)",
                comment: "Alert message: the terminal process didn't start. Placeholder: technical details")
            self.recoveryPermission = nil
        }
    }

    private static var launchFailedTitle: String {
        String(localized: "Terminal Launch Failed", comment: "Alert title: opening a terminal failed")
    }

    private static var automationPermissionDenied: Self {
        Self(
            title: String(localized: "Permission Denied", comment: "Alert title: Automation permission missing"),
            message: String(
                localized: "Untether needs permission to control terminal applications.\n\nPlease grant Automation permission in System Settings > Privacy & Security > Automation.",
                comment: "Alert message: Automation permission missing. Use the macOS names of System Settings panes in your language"),
            recoveryPermission: .appleScript)
    }

    private static func accessibilityPermissionDenied(terminalName: String) -> Self {
        Self(
            title: String(localized: "Accessibility Permission Required", comment: "Alert title: Accessibility permission missing"),
            message: String(
                localized: "Untether needs Accessibility permission to send keystrokes to \(terminalName).\n\nPlease grant permission in System Settings > Privacy & Security > Accessibility.",
                comment: "Alert message: Accessibility permission missing. Placeholder: terminal app name. Use the macOS names of System Settings panes in your language"),
            recoveryPermission: .accessibility)
    }

    private static func appleScriptExecutionFailure(
        details: String,
        errorCode: Int?,
        terminalName: String)
        -> Self
    {
        switch errorCode {
        case -1743:
            self.automationPermissionDenied
        case 1002, -25211, -1719:
            self.accessibilityPermissionDenied(terminalName: terminalName)
        case -1728:
            Self(
                title: String(localized: "Terminal Not Available", comment: "Alert title: the terminal can't be controlled"),
                message: String(
                    localized: "The terminal application is not running or cannot be controlled.\n\nDetails: \(details)",
                    comment: "Alert message. Placeholder: technical details"),
                recoveryPermission: nil)
        case -1708:
            Self(
                title: String(localized: "Terminal Communication Error", comment: "Alert title: the terminal didn't answer"),
                message: String(
                    localized: "The terminal did not respond to the command.\n\nDetails: \(details)",
                    comment: "Alert message. Placeholder: technical details"),
                recoveryPermission: nil)
        case let code?:
            Self(
                title: Self.launchFailedTitle,
                message: String(
                    localized: "AppleScript error \(code): \(details)",
                    comment: "Alert message. First: error code, second: technical details"),
                recoveryPermission: nil)
        case nil:
            Self(
                title: Self.launchFailedTitle,
                message: String(
                    localized: "Failed to launch terminal: \(details)",
                    comment: "Alert message. Placeholder: technical details"),
                recoveryPermission: nil)
        }
    }
}
