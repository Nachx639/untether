import AppKit
import Foundation
import Observation
import os.log
import SwiftUI

/// Terminal launch result with window/tab information.
///
/// Contains information about the launched terminal session, including
/// the terminal application used and identifiers for the created window or tab.
struct TerminalLaunchResult {
    let terminal: Terminal
    let tabReference: String?
    let tabID: String?
    let windowID: CGWindowID?
}

/// Terminal launch configuration.
///
/// Encapsulates the parameters needed to launch a terminal command,
/// including the command to execute, working directory, and target terminal application.
struct TerminalLaunchConfig {
    let command: String
    let workingDirectory: String?
    let terminal: Terminal

    var fullCommand: String {
        guard let workingDirectory else {
            return self.command
        }
        return "cd \(TerminalLauncher.shellQuote(workingDirectory)) && \(self.command)"
    }

    var appleScriptEscapedCommand: String {
        self.fullCommand
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    var keystrokeEscapedCommand: String {
        // For keystroke commands, we need to escape backslashes and quotes
        // AppleScript keystroke requires double-escaping for quotes
        self.fullCommand
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }
}

/// Terminal launch methods.
///
/// Defines the different approaches for launching terminal commands,
/// each with different trade-offs for reliability and functionality.
enum TerminalLaunchMethod {
    case appleScript(script: String)
    case processWithArgs(args: [String])
    case processWithTyping(delaySeconds: Double = 0.5)
    case urlScheme(url: String)
}

/// Supported terminal applications.
///
/// Represents terminal emulators that Untether can launch
/// with commands, including detection of installed terminals.
///
/// Note: Tabby is not included as it shows a startup screen
/// which makes it difficult to support automated command execution.
enum Terminal: String, CaseIterable {
    case terminal = "Terminal"
    case iTerm2
    case ghostty = "Ghostty"
    case warp = "Warp"
    case warpPreview = "Warp Preview"
    case alacritty = "Alacritty"
    case hyper = "Hyper"
    case wezterm = "WezTerm"
    case kitty = "Kitty"

    var bundleIdentifier: String {
        switch self {
        case .terminal:
            BundleIdentifiers.terminal
        case .iTerm2:
            BundleIdentifiers.iTerm2
        case .ghostty:
            BundleIdentifiers.ghostty
        case .warp:
            BundleIdentifiers.warp
        case .warpPreview:
            BundleIdentifiers.warpPreview
        case .alacritty:
            BundleIdentifiers.alacritty
        case .hyper:
            BundleIdentifiers.hyper
        case .wezterm:
            BundleIdentifiers.wezterm
        case .kitty:
            BundleIdentifiers.kitty
        }
    }

    /// Priority for auto-detection (higher is better, based on popularity)
    var detectionPriority: Int {
        switch self {
        case .terminal: 100 // Highest - macOS default, most popular
        case .iTerm2: 95 // Very popular among developers
        case .warp: 85 // Popular modern terminal
        case .warpPreview: 84 // Prefer stable Warp when both channels are installed
        case .ghostty: 80 // New but gaining popularity
        case .kitty: 75 // Fast GPU-based terminal
        case .alacritty: 70 // Popular among power users
        case .wezterm: 60 // Less common but powerful
        case .hyper: 50 // Less popular Electron-based
        }
    }

    var displayName: String {
        rawValue
    }

    var applicationName: String {
        switch self {
        case .terminal: "Terminal"
        case .iTerm2: "iTerm2"
        case .ghostty: "Ghostty"
        case .warp: "Warp"
        case .warpPreview: "WarpPreview"
        case .alacritty: "Alacritty"
        case .hyper: "Hyper"
        case .wezterm: "WezTerm"
        case .kitty: "kitty"
        }
    }

    var isInstalled: Bool {
        self.isInstalled { bundleIdentifier in
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
        }
    }

    func isInstalled(applicationURL: (String) -> URL?) -> Bool {
        if self == .terminal {
            return true // Terminal is always installed
        }
        return applicationURL(self.bundleIdentifier) != nil
    }

    var appIcon: NSImage? {
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) else {
            return nil
        }
        return NSWorkspace.shared.icon(forFile: appURL.path)
    }

    static var installed: [Self] {
        self.installed { bundleIdentifier in
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
        }
    }

    static func installed(applicationURL: (String) -> URL?) -> [Self] {
        allCases.filter { $0.isInstalled(applicationURL: applicationURL) }
    }

    /// Check if a specific terminal application is currently running
    static func isTerminalRunning(_ terminal: Self) -> Bool {
        let runningApps = NSWorkspace.shared.runningApplications
        return runningApps.contains { $0.bundleIdentifier == terminal.bundleIdentifier }
    }

    /// Generate unified AppleScript for all terminals
    func unifiedAppleScript(for config: TerminalLaunchConfig) -> String {
        // Terminal.app supports 'do script' which handles complex commands better
        if self == .terminal {
            return """
            tell application "Terminal"
                activate
                do script "\(config.appleScriptEscapedCommand)"
            end tell
            """
        }

        // For all other terminals, use clipboard approach for reliability
        // This avoids issues with special characters and long commands
        // Note: The command is already copied to clipboard before this script runs

        // Special handling for iTerm2 to ensure new window (not tab)
        if self == .iTerm2 {
            return """
            tell application "\(self.processName)"
                activate
                tell application "System Events"
                    -- Create new window (Cmd+Shift+N for iTerm2)
                    keystroke "n" using {command down, shift down}
                    delay 0.5
                    -- Paste command from clipboard
                    keystroke "v" using {command down}
                    delay 0.1
                    -- Execute the command
                    key code 36
                end tell
            end tell
            """
        }

        // Special handling for Warp terminal
        // Warp doesn't recognize standard key codes for Enter (36 or 76)
        // and requires ASCII character 13 (carriage return) to execute commands
        if self == .warp || self == .warpPreview {
            return """
            tell application "\(self.processName)"
                activate
                tell application "System Events"
                    -- Create new window
                    keystroke "n" using {command down}
                    delay 1.0
                    -- Paste command from clipboard
                    keystroke "v" using {command down}
                    delay 0.5
                    -- Warp requires ASCII character 13 instead of key code 36
                    keystroke (ASCII character 13)
                end tell
            end tell
            """
        }

        // Special handling for Ghostty with dynamic delays based on running state
        if self == .ghostty {
            let isRunning = Self.isTerminalRunning(.ghostty)
            let startupDelay = isRunning ? "0.5" : "2.0" // Longer delay for cold start

            return """
            tell application "\(self.processName)"
                activate
                -- Ghostty's AppleScript window query can hang, so use process state for startup timing.
                delay \(startupDelay)
                tell application "System Events"
                    tell process "\(self.processName)"
                        -- Create new window
                        keystroke "n" using {command down}
                        delay 0.5
                        -- Paste command from clipboard
                        keystroke "v" using {command down}
                        delay 0.1
                        -- Execute the command
                        key code 36
                    end tell
                end tell
            end tell
            """
        }

        // For other terminals, Cmd+N typically creates a new window
        return """
        tell application "\(self.processName)"
            activate
            tell application "System Events"
                -- Create new window
                keystroke "n" using {command down}
                delay 0.5
                -- Paste command from clipboard
                keystroke "v" using {command down}
                delay 0.1
                -- Execute the command
                key code 36
            end tell
        end tell
        """
    }

    /// Determine the launch method for this terminal
    /// The idea is that we optimize this later to use sth faster than AppleScript if available
    func launchMethod(for config: TerminalLaunchConfig) -> TerminalLaunchMethod {
        switch self {
        case .terminal:
            // Use unified AppleScript approach for consistency
            .appleScript(script: self.unifiedAppleScript(for: config))

        case .iTerm2:
            // Use unified AppleScript approach for consistency
            .appleScript(script: self.unifiedAppleScript(for: config))

        case .ghostty:
            // Use unified AppleScript approach
            .appleScript(script: self.unifiedAppleScript(for: config))

        case .alacritty:
            // Use unified AppleScript approach for consistency
            .appleScript(script: self.unifiedAppleScript(for: config))

        case .warp, .warpPreview:
            // Use unified AppleScript approach
            .appleScript(script: self.unifiedAppleScript(for: config))

        case .hyper:
            // Use unified AppleScript approach
            .appleScript(script: self.unifiedAppleScript(for: config))

        case .wezterm:
            // Use unified AppleScript approach for consistency
            .appleScript(script: self.unifiedAppleScript(for: config))

        case .kitty:
            // Use unified AppleScript approach for consistency
            .appleScript(script: self.unifiedAppleScript(for: config))
        }
    }

    /// Process name for AppleScript typing
    var processName: String {
        switch self {
        case .terminal: "Terminal"
        case .iTerm2: "iTerm"
        case .ghostty: "ghostty" // lowercase for System Events
        case .warp: "Warp"
        case .warpPreview: "WarpPreview"
        case .alacritty: "Alacritty"
        case .hyper: "Hyper"
        case .wezterm: "WezTerm"
        case .kitty: "kitty"
        }
    }
}

/// Errors that can occur when launching terminal commands.
///
/// Represents failures during terminal application launch,
/// including permission issues and missing applications.
/// Errors that can occur during terminal launching.
///
/// Covers various failure modes including missing applications,
/// permission issues, and script execution failures.
enum TerminalLauncherError: LocalizedError {
    case terminalNotFound
    case appleScriptPermissionDenied
    case accessibilityPermissionDenied
    case appleScriptExecutionFailed(String, errorCode: Int?)
    case processLaunchFailed(String)

    var errorDescription: String? {
        switch self {
        case .terminalNotFound:
            String(localized: "Selected terminal application not found", comment: "Error: launching a terminal failed")
        case .appleScriptPermissionDenied:
            String(localized: "AppleScript permission denied. Please grant permission in System Settings.", comment: "Error: launching a terminal failed")
        case .accessibilityPermissionDenied:
            String(localized: "Accessibility permission required to send keystrokes. Please grant permission in System Settings.", comment: "Error: launching a terminal failed")
        case let .appleScriptExecutionFailed(message, errorCode):
            if let code = errorCode {
                String(localized: "AppleScript error \(code): \(message)", comment: "Error: launching a terminal failed")
            } else {
                String(localized: "AppleScript error: \(message)", comment: "Error: launching a terminal failed")
            }
        case let .processLaunchFailed(message):
            String(localized: "Failed to launch process: \(message)", comment: "Error: launching a terminal failed")
        }
    }

    var failureReason: String? {
        switch self {
        case .appleScriptPermissionDenied:
            return String(localized: "Untether needs Automation permission to control terminal applications.", comment: "Error detail: why launching a terminal failed")
        case .accessibilityPermissionDenied:
            return String(localized: "Untether needs Accessibility permission to send keystrokes to terminal applications.", comment: "Error detail: why launching a terminal failed")
        case let .appleScriptExecutionFailed(_, errorCode):
            if let code = errorCode {
                switch code {
                case -1743:
                    return String(localized: "User permission is required to control other applications.", comment: "Error detail: why launching a terminal failed")
                case -1728:
                    return String(localized: "The application is not running or cannot be controlled.", comment: "Error detail: why launching a terminal failed")
                case -1708:
                    return String(localized: "The event was not handled by the target application.", comment: "Error detail: why launching a terminal failed")
                case -25211:
                    return String(localized: "Accessibility permission is required to send keystrokes.", comment: "Error detail: why launching a terminal failed")
                default:
                    return nil
                }
            }
            return nil
        default:
            return nil
        }
    }
}

/// Manages launching terminal commands in the user's preferred terminal.
///
/// Handles terminal application detection, preference management,
/// and command execution through AppleScript or direct process launching.
/// Supports Terminal, iTerm2, and Ghostty with automatic fallback.
@MainActor
@Observable
final class TerminalLauncher {
    static let shared = TerminalLauncher()
    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "TerminalLauncher")

    private init() {
        self.performFirstRunAutoDetection()
    }

    func launchCommand(_ command: String) throws {
        let terminal = self.getValidTerminal()
        let config = TerminalLaunchConfig(command: command, workingDirectory: nil, terminal: terminal)
        _ = try self.launchWithConfig(config)
    }

    func verifyPreferredTerminal() {
        let currentPreference = AppConstants.getPreferredTerminal() ?? Terminal.terminal.rawValue
        let terminal = Terminal(rawValue: currentPreference) ?? .terminal
        if !terminal.isInstalled {
            AppConstants.setPreferredTerminal(Terminal.terminal.rawValue)
        }
    }

    // MARK: - Private Methods

    private func performFirstRunAutoDetection() {
        // Check if terminal preference has already been set
        let hasSetPreference = AppConstants.getPreferredTerminal() != nil

        if !hasSetPreference {
            self.logger.info("First run detected, auto-detecting preferred terminal from running processes")

            if let detectedTerminal = detectRunningTerminals() {
                AppConstants.setPreferredTerminal(detectedTerminal.rawValue)
                self.logger.info("Auto-detected and set preferred terminal to: \(detectedTerminal.rawValue)")
            } else {
                // No terminals detected in running processes, check installed terminals
                let installedTerminals = Terminal.installed.filter { $0 != .terminal }
                if let bestTerminal = installedTerminals.max(by: { $0.detectionPriority < $1.detectionPriority }) {
                    AppConstants.setPreferredTerminal(bestTerminal.rawValue)
                    self.logger
                        .info(
                            "No running terminals found, set preferred terminal to most popular installed: \(bestTerminal.rawValue)")
                }
            }
        }
    }

    private func detectRunningTerminals() -> Terminal? {
        // Get all running applications
        let runningApps = NSWorkspace.shared.runningApplications

        // Find all terminals that are currently running
        var runningTerminals: [Terminal] = []

        for terminal in Terminal.allCases
            where runningApps.contains(where: { $0.bundleIdentifier == terminal.bundleIdentifier })
        {
            runningTerminals.append(terminal)
            logger.debug("Detected running terminal: \(terminal.rawValue)")
        }

        // Return the terminal with highest priority
        return runningTerminals.max { $0.detectionPriority < $1.detectionPriority }
    }

    private func getValidTerminal() -> Terminal {
        // Read the current preference using helper method
        // @AppStorage doesn't work properly in non-View contexts
        let currentPreference = AppConstants.getPreferredTerminal() ?? Terminal.terminal.rawValue
        let terminal = Terminal(rawValue: currentPreference) ?? .terminal
        let actualTerminal = terminal.isInstalled ? terminal : .terminal

        if actualTerminal != terminal {
            // Update preference to fallback
            AppConstants.setPreferredTerminal(actualTerminal.rawValue)
            self.logger
                .warning(
                    "Preferred terminal \(terminal.rawValue) not installed, falling back to \(actualTerminal.rawValue)")
        }

        return actualTerminal
    }

    private func launchWithConfig(
        _ config: TerminalLaunchConfig,
        sessionId: String? = nil)
        throws -> TerminalLaunchResult
    {
        self.logger.debug("Launch config - command: \(config.command)")
        self.logger.debug("Launch config - fullCommand: \(config.fullCommand)")
        self.logger.debug("Launch config - keystrokeEscapedCommand: \(config.keystrokeEscapedCommand)")

        let method = config.terminal.launchMethod(for: config)
        var tabReference: String?
        var tabID: String?
        var windowID: CGWindowID?

        switch method {
        case let .appleScript(script):
            self.logger.debug("Generated AppleScript:\n\(script)")

            // For Terminal.app and iTerm2, use enhanced scripts to get tab info
            if let sessionId, config.terminal == .terminal || config.terminal == .iTerm2 {
                let enhancedScript = self.generateEnhancedScript(for: config, sessionId: sessionId)
                let result = try executeAppleScriptWithResult(enhancedScript)

                self.logger.debug("Enhanced script result for \(config.terminal.rawValue): '\(result)'")

                // Parse the result to extract tab/window info
                if config.terminal == .terminal {
                    // Terminal.app returns "windowID|tabID"
                    let components = result.split(separator: "|").map(String.init)
                    self.logger.debug("Terminal.app components: \(components)")
                    if components.count >= 2 {
                        if let windowIDValue = UInt32(components[0]) {
                            windowID = CGWindowID(windowIDValue)
                            tabReference = "tab id \(components[1]) of window id \(components[0])"
                            self.logger
                                .info("Terminal.app window ID: \(windowID ?? 0), tab reference: \(tabReference ?? "")")
                        } else {
                            self.logger.warning("Failed to parse window ID from components[0]: '\(components[0])'")
                        }
                    } else {
                        self.logger
                            .warning(
                                "Unexpected AppleScript result format for Terminal.app. Expected 'windowID|tabID', got: '\(result)'. Components: \(components)")
                    }
                } else if config.terminal == .iTerm2 {
                    // iTerm2 returns window ID
                    let windowIDString = result.trimmingCharacters(in: .whitespacesAndNewlines)
                    // For iTerm2, we store the window ID as tabID for consistency
                    tabID = windowIDString
                    self.logger.info("iTerm2 window ID: \(windowIDString)")
                }
            } else {
                // For non-Terminal.app terminals, copy command to clipboard first
                if config.terminal != .terminal {
                    self.copyToClipboard(config.fullCommand)
                }
                try self.executeAppleScript(script)
            }

        case let .processWithArgs(args):
            try self.launchProcess(bundleIdentifier: config.terminal.bundleIdentifier, args: args)

        case let .processWithTyping(delay):
            try self.launchProcess(bundleIdentifier: config.terminal.bundleIdentifier, args: [])

            // Give the terminal time to start
            Thread.sleep(forTimeInterval: delay)

            // Use the same keystroke pattern as other terminals
            try self.executeAppleScript(config.terminal.unifiedAppleScript(for: config))

        case let .urlScheme(url):
            // Open URL schemes using NSWorkspace
            guard let nsUrl = URL(string: url) else {
                throw TerminalLauncherError.processLaunchFailed(String(
                    localized: "Invalid URL: \(url)",
                    comment: "Error: launching a terminal. Placeholder: the address"))
            }

            if !NSWorkspace.shared.open(nsUrl) {
                // Fallback to using 'open' command if NSWorkspace fails
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                process.arguments = [url]

                do {
                    try process.run()
                    process.waitUntilExit()

                    if process.terminationStatus != 0 {
                        throw TerminalLauncherError.processLaunchFailed(String(
                            localized: "Failed to open URL scheme",
                            comment: "Error: launching a terminal through its URL scheme"))
                    }
                } catch {
                    throw TerminalLauncherError.processLaunchFailed(error.localizedDescription)
                }
            }
        }

        return TerminalLaunchResult(
            terminal: config.terminal,
            tabReference: tabReference,
            tabID: tabID,
            windowID: windowID)
    }

    private func launchProcess(bundleIdentifier: String, args: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-b", bundleIdentifier] + args

        do {
            try process.run()
            process.waitUntilExit()

            if process.terminationStatus != 0 {
                throw TerminalLauncherError
                    .processLaunchFailed(String(
                        localized: "Process exited with status \(process.terminationStatus)",
                        comment: "Error: launching a terminal. Placeholder: exit status"))
            }
        } catch {
            self.logger.error("Failed to launch terminal: \(error.localizedDescription)")
            throw TerminalLauncherError.processLaunchFailed(error.localizedDescription)
        }
    }

    /// AppleScript timeout for one terminal launch.
    ///
    /// 2026-10-20: the server gave up on `terminal.spawn` after 10 s while this script could
    /// still run for 15 s, then started the session a second time (web fallback). The server
    /// (control-unix-handler) now waits 20 s, which must stay above this timeout plus the
    /// 0.5 s typing delay of `processWithTyping`. Keep the two in step.
    nonisolated static let appleScriptLaunchTimeout: TimeInterval = 15

    private func copyToClipboard(_ text: String) {
        let pasteboard = appPasteboard
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    private func executeAppleScript(_ script: String) throws {
        do {
            // Use a longer timeout (15 seconds) for terminal launch operations
            // as some terminals (like Ghostty) can take longer to start up
            try AppleScriptExecutor.shared.execute(script, timeout: Self.appleScriptLaunchTimeout)
        } catch let error as AppleScriptError {
            // Check if this is a permission error
            if case let .executionFailed(_, errorCode) = error,
               let code = errorCode
            {
                switch code {
                case -25211, -1719:
                    // These error codes indicate accessibility permission issues
                    throw TerminalLauncherError.accessibilityPermissionDenied
                case -2741:
                    // This is a syntax error: "Expected end of line but found identifier"
                    // It usually means the AppleScript has unescaped quotes or other syntax issues
                    throw TerminalLauncherError.appleScriptExecutionFailed(
                        "AppleScript syntax error - likely unescaped quotes in command",
                        errorCode: code)
                default:
                    break
                }
            }
            // Convert AppleScriptError to TerminalLauncherError
            throw error.toTerminalLauncherError()
        } catch {
            // Handle any unexpected errors
            throw TerminalLauncherError.appleScriptExecutionFailed(error.localizedDescription, errorCode: nil)
        }
    }

    private func executeAppleScriptWithResult(_ script: String) throws -> String {
        do {
            // Use a longer timeout (15 seconds) for terminal launch operations
            return try AppleScriptExecutor.shared.executeWithResult(script, timeout: Self.appleScriptLaunchTimeout)
        } catch let error as AppleScriptError {
            // Check if this is a permission error
            if case let .executionFailed(_, errorCode) = error,
               let code = errorCode
            {
                switch code {
                case -25211, -1719:
                    throw TerminalLauncherError.accessibilityPermissionDenied
                case -2741:
                    throw TerminalLauncherError.appleScriptExecutionFailed(
                        "AppleScript syntax error - likely unescaped quotes in command",
                        errorCode: code)
                default:
                    break
                }
            }
            throw error.toTerminalLauncherError()
        } catch {
            throw TerminalLauncherError.appleScriptExecutionFailed(error.localizedDescription, errorCode: nil)
        }
    }

    private func generateEnhancedScript(for config: TerminalLaunchConfig, sessionId: String) -> String {
        switch config.terminal {
        case .terminal:
            // Terminal.app script that returns window and tab info
            """
            tell application "Terminal"
                activate
                set newTab to do script "\(config.appleScriptEscapedCommand)"

                -- Set custom title that includes session ID for easier matching
                set custom title of newTab to "Session \(AppleScriptSecurity.escapeString(sessionId))"

                -- newTab is already a tab reference, get its window's ID
                set tabWindows to windows whose tabs contains newTab
                if (count of tabWindows) > 0 then
                    set windowID to id of item 1 of tabWindows
                else
                    set windowID to id of front window
                end if
                set tabID to id of newTab
                return (windowID as string) & "|" & (tabID as string)
            end tell
            """

        case .iTerm2:
            // iTerm2 script that returns window info
            """
            tell application "iTerm2"
                activate
                set newWindow to (create window with default profile)
                tell current session of newWindow
                    -- Set session name to include session ID for easier matching
                    set name to "Session \(AppleScriptSecurity.escapeString(sessionId))"
                    write text "\(config.appleScriptEscapedCommand)"
                end tell
                return id of newWindow
            end tell
            """

        default:
            // For other terminals, use the standard script
            config.terminal.unifiedAppleScript(for: config)
        }
    }

    // MARK: - Terminal Session Launching

    func launchTerminalSession(workingDirectory: String, command: String, sessionId: String) throws {
        // Expand tilde in working directory path
        let expandedWorkingDir = (workingDirectory as NSString).expandingTildeInPath

        // Single-quote the working directory for the shell (2026-10-20: escaping only `"`
        // left `$`, backticks and `\` live in folder names)
        let quotedWorkingDir = Self.shellQuote(expandedWorkingDir)

        // Construct the full command for forwarder
        self.logger.info("Using forwarder session creation")
        let forwarderPath = self.findForwarderBinary() ?? self.findBunExecutable()
        let bunCommand = self.buildForwarderCommand(
            forwarderPath: forwarderPath,
            userCommand: command,
            workingDir: quotedWorkingDir,
            sessionId: sessionId)
        let fullCommand = "cd \(quotedWorkingDir) && \(bunCommand) && exit"

        // Get the preferred terminal or fallback
        let terminal = self.getValidTerminal()

        // Launch with configuration - no working directory since we handle it in the command
        let config = TerminalLaunchConfig(
            command: fullCommand,
            workingDirectory: nil,
            terminal: terminal)

        // Launch the terminal and get tab/window info
        let launchResult = try launchWithConfig(config, sessionId: sessionId)

        // Register the window with WindowTracker
        WindowTracker.shared.registerSessionOpenedByUs(
            for: sessionId,
            terminalApp: launchResult.terminal,
            iTermWindowID: launchResult.terminal == .iTerm2 ? launchResult.tabID : nil)
    }

    /// Launches a session the server asked for (control `terminal.spawn`): its argv, each
    /// element single-quoted, runs under the forwarder in a new terminal window.
    /// 2026-10-20: the server's `command` string (argv joined with spaces) ran raw, so an
    /// argument with a space, a quote or `;` split or ran as shell syntax; the folder was only
    /// escaped for `\` and `"`. The string and its "pre-formatted by the Go server"
    /// (`TTY_SESSION_ID=`) heuristics are gone: argv is all there is.
    func launchOptimizedTerminalSession(
        workingDirectory: String,
        commandArgs: [String],
        sessionId: String,
        untetherPath: String? = nil)
        throws
    {
        guard !commandArgs.isEmpty else {
            throw TerminalLauncherError.processLaunchFailed("No command to run")
        }
        // Expand tilde in working directory path
        let expandedWorkingDir = (workingDirectory as NSString).expandingTildeInPath
        let quotedDir = Self.shellQuote(expandedWorkingDir)
        let command = Self.shellCommand(fromArgv: commandArgs)

        let fullCommand: String
        // The bundled server (Bun) runs sessions through the forwarder.
        if Bundle.main.path(forResource: "untether", ofType: nil) != nil {
            self.logger.info("Using forwarder session creation via fwd")
            let forwarderPath = self.findForwarderBinary() ?? self.findBunExecutable()
            let bunCommand = self.buildForwarderCommand(
                forwarderPath: forwarderPath,
                userCommand: command,
                workingDir: quotedDir,
                sessionId: sessionId)
            fullCommand = "cd \(quotedDir) && \(bunCommand) && exit"
        } else if let forwarderPath = self.findForwarderBinary() {
            let forwarderCommand = self.buildForwarderCommand(
                forwarderPath: forwarderPath,
                userCommand: command,
                workingDir: quotedDir,
                sessionId: sessionId)
            fullCommand = "cd \(quotedDir) && \(forwarderCommand) && exit"
        } else {
            let untether = untetherPath ?? self.findUntetherBinary()
            fullCommand =
                "cd \(quotedDir) && TTY_SESSION_ID=\(Self.shellQuote(sessionId)) \(untether) \(command) && exit"
        }

        // Get the preferred terminal or fallback
        let terminal = self.getValidTerminal()

        // Launch with configuration
        let config = TerminalLaunchConfig(
            command: fullCommand,
            workingDirectory: nil,
            terminal: terminal)

        // Launch the terminal and get tab/window info
        let launchResult = try launchWithConfig(config, sessionId: sessionId)

        // Register the window with WindowTracker
        WindowTracker.shared.registerSessionOpenedByUs(
            for: sessionId,
            terminalApp: launchResult.terminal,
            iTermWindowID: launchResult.terminal == .iTerm2 ? launchResult.tabID : nil)
    }

    private func findUntetherBinary() -> String {
        // Look for bundled untether binary (shipped with the app)
        if let bundledUntether = Bundle.main.path(forResource: "untether", ofType: nil) {
            self.logger.info("Using bundled untether at: \(bundledUntether)")
            return bundledUntether
        }

        self.logger.error("No untether binary found in app bundle, command will fail")
        return "echo 'Untether: untether binary not found in app bundle'; false"
    }

    private func findForwarderBinary() -> String? {
        if let bundledForwarder = Bundle.main.path(forResource: "untether-fwd", ofType: nil) {
            if FileManager.default.fileExists(atPath: bundledForwarder) {
                self.logger.info("Using bundled untether-fwd at: \(bundledForwarder)")
                return bundledForwarder
            }
        }
        return nil
    }

    private func findBunExecutable() -> String {
        // Look for Bun executable in Resources
        if let bundledPath = Bundle.main.path(forResource: "untether", ofType: nil) {
            if FileManager.default.fileExists(atPath: bundledPath) {
                self.logger.info("Using Bun executable at: \(bundledPath)")
                return bundledPath
            }
        }

        self.logger.error("No Bun executable found in app bundle, command will fail")
        return "echo 'Untether: Bun executable not found in app bundle'; false"
    }

    /// Single-quotes `value` so POSIX shells and fish read it back unchanged.
    ///
    /// `'` becomes `'\''` and `\` becomes `'\\'` (both outside the quotes).
    /// 2026-10-20: inside single quotes fish treats `\\` and `\'` as escapes, so for a fish
    /// login shell a value with backslashes changed (`a\\b` became `a\b`) and one ending in `\`
    /// swallowed the closing quote. Backslashes now never sit inside the quotes.
    nonisolated static func shellQuote(_ value: String) -> String {
        var quoted = "'"
        for character in value {
            switch character {
            case "'": quoted += "'\\''"
            case "\\": quoted += "'\\\\'"
            default: quoted.append(character)
            }
        }
        return quoted + "'"
    }

    /// A shell command line that runs exactly `argv`: every element single-quoted.
    nonisolated static func shellCommand(fromArgv argv: [String]) -> String {
        argv.map { self.shellQuote($0) }.joined(separator: " ")
    }

    nonisolated static func forwarderCommandForTesting(
        forwarderPath: String, userCommand: String, sessionId: String?) -> String
    {
        self.forwarderCommand(forwarderPath: forwarderPath, userCommand: userCommand, sessionId: sessionId)
    }

    private func buildForwarderCommand(
        forwarderPath: String,
        userCommand: String,
        workingDir: String,
        sessionId: String? = nil)
        -> String
    {
        Self.forwarderCommand(forwarderPath: forwarderPath, userCommand: userCommand, sessionId: sessionId)
    }

    private nonisolated static func forwarderCommand(
        forwarderPath: String,
        userCommand: String,
        sessionId: String?)
        -> String
    {
        let forwarderName = (forwarderPath as NSString).lastPathComponent
        let usesSubcommand = forwarderName != "untether-fwd"
        let quotedPath = Self.shellQuote(forwarderPath)
        let baseCommand = usesSubcommand ? "\(quotedPath) fwd" : quotedPath
        // 2026-10-20: `--` ends the forwarder's options, so a command whose first word starts
        // with `--` is never parsed as a forwarder flag.
        if let sessionId {
            // Pass the pre-generated session ID to fwd
            return "\(baseCommand) --session-id \(Self.shellQuote(sessionId)) -- \(userCommand)"
        } else {
            return "\(baseCommand) -- \(userCommand)"
        }
    }
}
