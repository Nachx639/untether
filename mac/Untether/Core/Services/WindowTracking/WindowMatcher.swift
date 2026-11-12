import AppKit
import Foundation
import OSLog

struct WindowMatchEvidence: Comparable, CustomStringConvertible {
    let strongest: Int
    let identity: Int

    var description: String {
        "\(self.strongest) (identity \(self.identity))"
    }

    static func < (lhs: Self, rhs: Self) -> Bool {
        if lhs.strongest != rhs.strongest {
            return lhs.strongest < rhs.strongest
        }
        return lhs.identity < rhs.identity
    }
}

enum WindowMatchScore {
    static let sessionID = 500
    static let windowID = 250
    static let sessionName = 200
    static let workingDirectory = 150
    static let bounds = 100
    static let directoryName = 100
    static let storedTitle = 25

    static func combined(identity: Int, content: Int) -> WindowMatchEvidence {
        WindowMatchEvidence(strongest: max(identity, content), identity: identity)
    }
}

/// Handles window matching and session-to-window mapping algorithms.
@MainActor
final class WindowMatcher {
    struct TabMatch {
        let tab: AXElement
        let score: Int
    }

    private let logger = Logger(
        subsystem: BundleIdentifiers.loggerSubsystem,
        category: "WindowMatcher")

    private let processTracker = ProcessTracker()

    /// Find a terminal window for a session that was attached via `ut`
    func findWindowForSession(
        _ sessionID: String,
        sessionInfo: ServerSessionInfo,
        allWindows: [WindowInfo])
        -> WindowInfo?
    {
        // First try to find window by process PID traversal
        if let sessionPID = sessionInfo.pid {
            self.logger.debug("Scanning for window by process PID: \(sessionPID) for session \(sessionID)")

            // Log the process tree for debugging
            self.processTracker.logProcessTree(for: pid_t(sessionPID))

            // Try to traverse up the process tree to find a terminal window
            var currentPID = pid_t(sessionPID)
            var depth = 0
            let maxDepth = 20 // Increased depth for deeply nested sessions

            while depth < maxDepth {
                // Check if any window is owned by this PID
                if let matchingWindow = allWindows.first(where: { window in
                    window.ownerPID == currentPID
                }) {
                    self.logger.info("Found window by PID \(currentPID) at depth \(depth) for session \(sessionID)")
                    return matchingWindow
                }

                // Move up to parent process
                if let parentPID = processTracker.getParentProcessID(of: currentPID) {
                    if parentPID == 0 || parentPID == 1 {
                        // Reached root process
                        break
                    }
                    currentPID = parentPID
                    depth += 1
                } else {
                    break
                }
            }

            self.logger.debug("Process traversal completed at depth \(depth) without finding window")
        }

        // Fallback: Find by working directory
        let workingDir = sessionInfo.workingDir
        let dirName = (workingDir as NSString).lastPathComponent

        self.logger.debug("Trying to match by directory: \(dirName) or full path: \(workingDir)")

        // Look for windows whose title contains the directory name
        if let matchingWindow = allWindows.first(where: { window in
            if let title = window.title {
                let matches = title.contains(dirName) || title.contains(workingDir)
                if matches {
                    logger.debug("Window title '\(title)' matches directory")
                }
                return matches
            }
            return false
        }) {
            self.logger.info("Found window by directory match: \(dirName) for session \(sessionID)")
            return matchingWindow
        }

        self.logger.warning("Could not find window for session \(sessionID) after all attempts")
        self.logger.debug("Available windows: \(allWindows.count)")
        for (index, window) in allWindows.enumerated() {
            self.logger
                .debug(
                    "  Window \(index): PID=\(window.ownerPID), Terminal=\(window.terminalApp.rawValue), Title=\(window.title ?? "<no title>")")
        }

        return nil
    }

    /// Find matching tab using accessibility APIs
    func findMatchingTab(tabs: [AXElement], sessionInfo: ServerSessionInfo?) -> AXElement? {
        self.findBestMatchingTab(tabs: tabs, sessionInfo: sessionInfo)?.tab
    }

    /// Find the strongest matching tab and its confidence score.
    func findBestMatchingTab(tabs: [AXElement], sessionInfo: ServerSessionInfo?) -> TabMatch? {
        guard let sessionInfo else { return nil }

        self.logger.debug("Looking for tab matching session \(sessionInfo.id) in \(tabs.count) tabs")
        var bestMatch: TabMatch?

        for (index, tab) in tabs.enumerated() {
            if let title = tab.title {
                self.logger.debug("Tab \(index) title: \(title)")

                if let score = self.tabMatchScore(for: title, sessionInfo: sessionInfo),
                   bestMatch == nil || score > bestMatch?.score ?? 0
                {
                    bestMatch = TabMatch(tab: tab, score: score)
                    self.logger.info("Tab \(index) is the best match with score \(score)")
                }
            } else {
                self.logger.debug("Tab \(index): Could not get title")
            }
        }

        if bestMatch == nil {
            self.logger.warning("No matching tab found for session \(sessionInfo.id)")
        }
        return bestMatch
    }

    /// Score tab-title evidence so precise session matches can beat stale window metadata.
    func tabMatchScore(for title: String, sessionInfo: ServerSessionInfo) -> Int? {
        if !sessionInfo.id.isEmpty,
           title.contains(sessionInfo.id) || title.contains("TTY_SESSION_ID=\(sessionInfo.id)")
        {
            return WindowMatchScore.sessionID
        }

        if !sessionInfo.name.isEmpty, title.contains(sessionInfo.name) {
            return WindowMatchScore.sessionName
        }

        let titleLower = title.lowercased()
        let workingDirLower = sessionInfo.workingDir.lowercased()
        if !workingDirLower.isEmpty, titleLower.contains(workingDirLower) {
            return WindowMatchScore.workingDirectory
        }

        let dirName = (sessionInfo.workingDir as NSString).lastPathComponent
        let dirNameLower = dirName.lowercased()
        if !dirNameLower.isEmpty,
           titleLower.contains(dirNameLower) ||
           title.hasSuffix(dirName) ||
           title.hasSuffix(" - \(dirName)")
        {
            return WindowMatchScore.directoryName
        }

        return nil
    }
}
