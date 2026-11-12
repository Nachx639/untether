import AppKit
import Foundation
import OSLog

/// Handles accessibility permission checks and requests.
@MainActor
final class PermissionChecker {
    private let logger = Logger(
        subsystem: BundleIdentifiers.loggerSubsystem,
        category: "PermissionChecker")

    /// Check if we have the required permissions.
    func checkPermissions() -> Bool {
        if !self.checkPermissionsDirectly() {
            self.logger.warning("Untether needs accessibility permissions to focus terminal windows")

            let alert = NSAlert()
            alert.messageText = String(
                localized: "Accessibility Permission Required",
                comment: "Alert title: Accessibility permission missing")
            alert.informativeText = String(
                localized: "Untether needs accessibility permissions to focus terminal windows when you click on sessions.\n\nPlease grant permission in System Settings > Privacy & Security > Accessibility.",
                comment: "Alert message: Accessibility permission missing. Use the macOS names of System Settings panes in your language")
            alert.alertStyle = .informational
            alert.addButton(withTitle: String(localized: "Open System Settings", comment: "Alert button: opens System Settings"))
            alert.addButton(withTitle: String(localized: "Later", comment: "Alert button: ask again later"))

            if alert.runModal() == .alertFirstButtonReturn {
                self.requestPermissions()
            }

            return false
        }
        return true
    }

    /// Request accessibility permissions.
    func requestPermissions() {
        // Open System Settings directly to the right pane
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Check permissions without prompting.
    private func checkPermissionsDirectly() -> Bool {
        AXIsProcessTrusted()
    }
}
