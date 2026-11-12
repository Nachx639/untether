import AppKit
import CoreGraphics
import Foundation
import OSLog

/// Handles window enumeration using Accessibility APIs.
@MainActor
final class WindowEnumerator {
    private let logger = Logger(
        subsystem: BundleIdentifiers.loggerSubsystem,
        category: "WindowEnumerator")

    /// Gets all terminal windows currently visible on screen using Accessibility APIs.
    static func getAllTerminalWindows() -> [WindowInfo] {
        // Get bundle identifiers for all terminal types
        let terminalBundleIDs = Terminal.allCases.compactMap(\.bundleIdentifier)

        // Use AXElement to enumerate windows
        let axWindows = AXElement.enumerateWindows(
            bundleIdentifiers: terminalBundleIDs,
            includeMinimized: false)

        // Convert AXElement.WindowInfo to our WindowInfo
        return axWindows.compactMap { axWindow in
            // Find the matching Terminal enum
            guard let terminal = Terminal.allCases.first(where: {
                $0.bundleIdentifier == axWindow.bundleIdentifier
            }) else {
                return nil
            }

            return WindowInfo(
                windowID: axWindow.windowID,
                ownerPID: axWindow.pid,
                terminalApp: terminal,
                sessionID: "", // Will be filled by caller
                createdAt: Date(),
                tabReference: nil,
                tabID: nil,
                bounds: axWindow.bounds,
                title: axWindow.title)
        }
    }
}
