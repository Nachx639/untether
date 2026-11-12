import AppKit
import Foundation
import OSLog

/// Tracks terminal windows and their associated sessions.
///
/// This class provides functionality to:
/// - Enumerate terminal windows using Core Graphics APIs
/// - Map Untether sessions to their terminal windows
/// - Focus specific terminal windows when requested
/// - Handle both windows and tabs for different terminal applications
/// - **Close terminal windows when sessions are terminated (NEW)**
///
/// ## Window Closing Feature
///
/// A key enhancement is the ability to automatically close terminal windows when
/// their associated sessions are terminated. This solves the common problem where
/// killing a long-running process (like `claude`) leaves an empty terminal window.
///
/// ### Design Principles:
/// 1. **Only close what we open**: Windows are only closed if Untether opened them
/// 2. **Track ownership at creation**: Sessions opened via AppleScript are marked at launch time
/// 3. **Respect external sessions**: Sessions attached via `ut` are never closed
///
/// ### Implementation:
/// - When spawning terminals via AppleScript, sessions are marked in `sessionsOpenedByUs`
/// - On termination the terminal itself is asked for the window that carries the session's
///   identity (the "Session <id>" title the launcher gave it, or the iTerm2 window it made);
///   a window is never picked by folder name or by the app that owns it
/// - Only windows for sessions in the set are closed, and only when the session's tab is alone
/// - Supports Terminal.app and iTerm2; in other terminals the window is left to the user
///
/// ### User Experience:
/// - Consistent behavior: All Untether-spawned windows close on termination
/// - No orphaned windows: Prevents accumulation of empty terminals
/// - External sessions preserved: `ut`-attached terminals remain open
@MainActor
final class WindowTracker {
    static let shared = WindowTracker()

    private let logger = Logger(
        subsystem: BundleIdentifiers.loggerSubsystem,
        category: "WindowTracker")

    /// Maps session IDs to their terminal window information
    private var sessionWindowMap: [String: WindowInfo] = [:]

    /// The terminal a session of ours was opened in, and what identifies its window there.
    struct OpenedSession: Equatable {
        let terminalApp: Terminal
        /// iTerm2 only: the id of the window the launch script created.
        let iTermWindowID: String?
    }

    /// The sessions we opened via AppleScript (and can close), by session ID.
    ///
    /// Only TerminalLauncher adds to it, at launch. Sessions attached via `ut`, or merely
    /// looked at in Session Details, are never here.
    private var sessionsOpenedByUs: [String: OpenedSession] = [:]

    /// Lock for thread-safe access to the session map
    private let mapLock = NSLock()

    // Component instances
    private let windowMatcher = WindowMatcher()
    private let windowFocuser = WindowFocuser()
    private let permissionChecker = PermissionChecker()
    private let processTracker = ProcessTracker()

    private init() {
        self.logger.info("WindowTracker initialized")
    }

    // MARK: - Window Registration

    /// Registers a session that was opened by Untether.
    /// Called by TerminalLauncher after it launched a terminal for the session, and by nobody
    /// else: only sessions registered here have their windows closed on termination.
    func registerSessionOpenedByUs(
        for sessionID: String,
        terminalApp: Terminal,
        iTermWindowID: String? = nil)
    {
        self.logger.info("Registering session opened by us: \(sessionID), terminal: \(terminalApp.rawValue)")

        self.mapLock.withLock {
            self.sessionsOpenedByUs[sessionID] = OpenedSession(
                terminalApp: terminalApp,
                iTermWindowID: iTermWindowID)
        }
    }

    /// Whether Untether opened the terminal of this session.
    func wasOpenedByUs(_ sessionID: String) -> Bool {
        self.mapLock.withLock { self.sessionsOpenedByUs[sessionID] != nil }
    }

    /// Unregisters a window for a session.
    func unregisterWindow(for sessionID: String) {
        self.mapLock.withLock {
            if self.sessionWindowMap.removeValue(forKey: sessionID) != nil {
                self.logger.info("Unregistered window for session: \(sessionID)")
            }
            self.sessionsOpenedByUs.removeValue(forKey: sessionID)
        }
    }

    // MARK: - Window Information

    /// Gets the window information for a specific session.
    func windowInfo(for sessionID: String) -> WindowInfo? {
        self.mapLock.withLock {
            self.sessionWindowMap[sessionID]
        }
    }

    // MARK: - Window Focusing

    /// Focuses the terminal window for a specific session.
    func focusWindow(for sessionID: String) {
        guard let windowInfo = windowInfo(for: sessionID) else {
            self.logger.warning("No window registered for session: \(sessionID)")
            return
        }

        self.logger.info("Focusing window for session: \(sessionID), terminal: \(windowInfo.terminalApp.rawValue)")

        // Check permissions before attempting to focus
        guard self.permissionChecker.checkPermissions() else {
            return
        }

        // Delegate to the window focuser
        self.windowFocuser.focusWindow(windowInfo)
    }

    // MARK: - Window Closing

    /// Closes the terminal window for a specific session if it was opened by Untether.
    ///
    /// This method implements a key feature where terminal windows are automatically closed
    /// when their associated sessions are terminated, but ONLY if Untether opened them.
    /// This prevents the common issue where killing a process leaves empty terminal windows.
    ///
    /// 2026-11-10: the window used to be looked up again at close time, by walking up the
    /// process tree to "a window of that app" (the first window of Terminal.app, whichever it
    /// was) and then by "a window whose title contains the folder name". With two sessions in
    /// one project, or the user's own terminal in that folder, the wrong window was closed,
    /// with all its tabs. Now the terminal is asked for the window that carries this session's
    /// identity and nothing else is ever closed.
    ///
    /// - Parameter sessionID: The ID of the session whose window should be closed
    /// - Returns: `true` if the close was asked of the terminal, `false` otherwise
    ///
    /// - Note: This is called automatically by `SessionService.terminateSession()`
    ///         after the server confirms the process has been killed.
    ///
    /// Example scenarios:
    /// - ✅ User runs `claude` command via UI → Window closes when session killed
    /// - ❌ The session's tab shares its window with other tabs → Window NOT closed
    /// - ❌ User attaches existing terminal via `ut` → Window NOT closed
    /// - ❌ User manually opens terminal → Window NOT closed
    @discardableResult
    func closeWindowIfOpenedByUs(for sessionID: String) -> Bool {
        let opened = self.mapLock.withLock { self.sessionsOpenedByUs[sessionID] }

        guard let opened else {
            self.logger.info("Session \(sessionID) was not opened by Untether, not closing window")
            return false
        }

        // One try per session, whatever comes of it.
        self.unregisterWindow(for: sessionID)

        guard let closeScript = Self.closeWindowScript(sessionID: sessionID, opened: opened) else {
            self.logger.info(
                "No way to tell the window of session \(sessionID) apart in \(opened.terminalApp.rawValue), leaving it open")
            return false
        }

        do {
            try AppleScriptExecutor.shared.execute(closeScript)
            self.logger.info("Asked \(opened.terminalApp.rawValue) to close the window of session \(sessionID)")
            return true
        } catch {
            self.logger.error("Failed to close window for session \(sessionID): \(error)")
            return false
        }
    }

    /// AppleScript that closes the window of one session, found by that session's identity.
    ///
    /// - **Terminal.app**: the window whose only tab has the custom title "Session <id>" that
    ///   the launcher set (TerminalLauncher.generateEnhancedScript).
    /// - **iTerm2**: the window the launch script created (its id), while it holds one tab.
    /// - **Other terminals**: nil. Nothing in them names the session, so nothing is closed.
    ///
    /// A window with more tabs is left alone: the other tabs are not ours to close.
    nonisolated static func closeWindowScript(sessionID: String, opened: OpenedSession) -> String? {
        // The id goes into a script: only what a session id is made of.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        guard !sessionID.isEmpty, sessionID.unicodeScalars.allSatisfy(allowed.contains) else { return nil }

        switch opened.terminalApp {
        case .terminal:
            return """
            tell application "Terminal"
                repeat with w in windows
                    try
                        if (count of tabs of w) is 1 and (custom title of tab 1 of w) is "Session \(sessionID)" then
                            close w saving no
                            exit repeat
                        end if
                    end try
                end repeat
            end tell
            """

        case .iTerm2:
            guard let windowID = opened.iTermWindowID, !windowID.isEmpty,
                  windowID.unicodeScalars.allSatisfy(CharacterSet.decimalDigits.contains)
            else {
                return nil
            }
            return """
            tell application "iTerm2"
                repeat with w in windows
                    try
                        if (id of w) is \(windowID) and (count of tabs of w) is 1 then
                            close w
                            exit repeat
                        end if
                    end try
                end repeat
            end tell
            """

        default:
            return nil
        }
    }

    // MARK: - Permission Management

    /// Check if we have the required permissions.
    func checkPermissions() -> Bool {
        self.permissionChecker.checkPermissions()
    }

    /// Request accessibility permissions.
    func requestPermissions() {
        self.permissionChecker.requestPermissions()
    }

    // MARK: - Session Updates

    /// Updates window tracking based on current sessions.
    /// This method is called periodically to:
    /// 1. Remove windows for sessions that no longer exist
    /// 2. Try to find windows for ALL sessions without registered windows
    func updateFromSessions(_ sessions: [ServerSessionInfo]) {
        let sessionIDs = Set(sessions.map(\.id))

        // Remove windows for sessions that no longer exist
        self.mapLock.withLock {
            let trackedSessions = Set(sessionWindowMap.keys)
            let sessionsToRemove = trackedSessions.subtracting(sessionIDs)

            for sessionID in sessionsToRemove {
                if self.sessionWindowMap.removeValue(forKey: sessionID) != nil {
                    self.logger.info("Removed window tracking for terminated session: \(sessionID)")
                }
                // Also clean up the opened-by-us tracking
                self.sessionsOpenedByUs.removeValue(forKey: sessionID)
            }
        }

        // Check for sessions that have exited and close their windows if we opened them
        for session in sessions where session.status == "exited" {
            // Only close windows that we opened (not external ut attachments)
            if self.wasOpenedByUs(session.id) {
                logger.info("Session \(session.id) has exited naturally, closing its window")
                _ = closeWindowIfOpenedByUs(for: session.id)
            }
        }

        // For ALL sessions without registered windows, try to find them
        // This handles:
        // 1. Sessions attached via `ut` command
        // 2. Sessions spawned through the app but window registration failed
        // 3. Any other session that has a terminal window
        // The terminal windows are listed once per update and only if a session needs them:
        // it used to be one full Accessibility listing per session without a window (every
        // web-only session, every two seconds, on the main thread).
        var listedWindows: [WindowInfo]?
        for session in sessions where session.isRunning {
            if windowInfo(for: session.id) == nil {
                logger.debug("Session \(session.id) has no window registered, attempting to find it...")
                let allWindows = listedWindows ?? WindowEnumerator.getAllTerminalWindows()
                listedWindows = allWindows

                // Try to find the window for this session
                if let foundWindow = findWindowForSession(session.id, sessionInfo: session, allWindows: allWindows) {
                    mapLock.withLock {
                        sessionWindowMap[session.id] = foundWindow
                    }
                    logger
                        .info(
                            "Found and registered window for session: \(session.id)")
                } else {
                    logger.debug("Could not find window for session: \(session.id)")
                }
            }
        }
    }

    // MARK: - Private Methods

    /// Finds a terminal window for a session that was attached via `ut`.
    private func findWindowForSession(
        _ sessionID: String,
        sessionInfo: ServerSessionInfo,
        allWindows: [WindowInfo])
        -> WindowInfo?
    {
        if let window = windowMatcher
            .findWindowForSession(sessionID, sessionInfo: sessionInfo, allWindows: allWindows)
        {
            return WindowInfo(
                windowID: window.windowID,
                ownerPID: window.ownerPID,
                terminalApp: window.terminalApp,
                sessionID: sessionID,
                createdAt: Date(),
                tabReference: nil,
                tabID: nil,
                bounds: window.bounds,
                title: window.title)
        }

        return nil
    }
}
