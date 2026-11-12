import AppKit
import Foundation
import os.log

private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "StatusBarIconController")

/// Manages the visual appearance of the status bar item's button.
///
/// This class is responsible for updating the icon and title of the status bar button
/// based on the application's state, such as server status and active sessions.
@MainActor
final class StatusBarIconController {
    private weak var button: NSStatusBarButton?

    /// Initializes the icon controller with the status bar button.
    /// - Parameter button: The `NSStatusBarButton` to manage.
    init(button: NSStatusBarButton?) {
        self.button = button
    }

    /// Needs-you count last shown, so the title is only rebuilt when it changes.
    private var shownNeedsYouCount: Int?

    /// Updates the entire visual state of the status bar button.
    ///
    /// The title shows only what asks for attention: an amber dot and the number of sessions
    /// whose agent waits for the user. Nothing when no one does (the old "3 | 2" active/idle
    /// counts flickered with every burst of output and said little).
    ///
    /// - Parameters:
    ///   - serverManager: The manager for the Untether server.
    ///   - sessionMonitor: The monitor for active terminal sessions.
    func update(serverManager: ServerManager, sessionMonitor: SessionMonitor) {
        guard let button else { return }

        // Update icon based on server status
        self.updateIcon(isServerRunning: serverManager.isRunning)

        let needsYou = serverManager.isRunning ? sessionMonitor.needsYouCount : 0
        guard needsYou != self.shownNeedsYouCount else { return }
        self.shownNeedsYouCount = needsYou
        button.attributedTitle = Self.needsYouTitle(count: needsYou)
    }

    /// " ● 2" with an amber dot, or empty.
    static func needsYouTitle(count: Int) -> NSAttributedString {
        guard count > 0 else { return NSAttributedString(string: "") }
        let font = NSFont.menuBarFont(ofSize: 0)
        let title = NSMutableAttributedString(
            string: " \u{25CF}",
            attributes: [
                .foregroundColor: NSColor.untetherNeedsYou,
                .font: NSFont.systemFont(ofSize: font.pointSize * 0.75),
                .baselineOffset: font.pointSize * 0.08,
            ])
        title.append(NSAttributedString(
            string: " \(count)",
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: font.pointSize, weight: .regular)]))
        return title
    }

    /// Updates the icon of the status bar button based on the server's running state.
    /// - Parameter isServerRunning: A boolean indicating if the server is running.
    private func updateIcon(isServerRunning: Bool) {
        guard let button else { return }

        // Always use the same icon - it's already set as a template in the asset catalog.
        // Set it once: this runs every second.
        if button.image == nil {
            guard let image = NSImage(named: "menubar") else {
                logger.warning("menubar icon not found")
                return
            }
            // The image is already configured as a template in Contents.json,
            // but we set it explicitly to be safe
            image.isTemplate = true
            button.image = image
        }

        // Use opacity to indicate server state:
        // - 1.0 (fully opaque) when server is running
        // - 0.5 (semi-transparent) when server is stopped
        button.alphaValue = isServerRunning ? 1.0 : 0.5
    }
}
