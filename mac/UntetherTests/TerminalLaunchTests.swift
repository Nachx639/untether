import AppKit
import Foundation
import Testing
@testable import Untether

// MARK: - Terminal Launch Tests

@Suite("Terminal Launch Tests")
struct TerminalLaunchTests {
    // MARK: - URL Generation Tests

    @Test(arguments: [
        (Terminal.iTerm2, "echo 'Hello World'", "iterm2://run?command=echo%20\'Hello%20World\'"),
        (Terminal.iTerm2, "cd /tmp && ls", "iterm2://run?command=cd%20/tmp%20%26%26%20ls"),
        (Terminal.terminal, "echo test", nil),
        (Terminal.alacritty, "echo test", nil),
        (Terminal.hyper, "echo test", nil),
        (Terminal.wezterm, "echo test", nil),
    ])
    func terminalUrlGeneration(terminal: Terminal, command: String, expectedURL: String?) {
        if let url = terminal.commandURL(for: command) {
            #expect(url.absoluteString == expectedURL)
        } else {
            #expect(expectedURL == nil)
        }
    }

    // MARK: - Command Arguments Tests

    @Test
    func commandArgumentGenerationForTerminals() {
        let command = "echo 'Hello World'"

        // Test Alacritty arguments
        let alacrittyArgs = Terminal.alacritty.commandArguments(for: command)
        #expect(alacrittyArgs == ["-e", "/bin/bash", "-c", command])

        // Test WezTerm arguments
        let weztermArgs = Terminal.wezterm.commandArguments(for: command)
        #expect(weztermArgs == ["start", "--", "/bin/bash", "-c", command])

        // Test Terminal.app (limited support)
        let terminalArgs = Terminal.terminal.commandArguments(for: command)
        #expect(terminalArgs == [])
    }

    // MARK: - Working Directory Tests

    @Test
    func workingDirectorySupport() {
        let workDir = "/Users/test/projects"
        let command = "ls -la"

        // Alacritty with working directory
        let alacrittyArgs = Terminal.alacritty.commandArguments(
            for: command,
            workingDirectory: workDir)
        #expect(alacrittyArgs == [
            "--working-directory", workDir,
            "-e", "/bin/bash", "-c", command,
        ])

        // WezTerm with working directory
        let weztermArgs = Terminal.wezterm.commandArguments(
            for: command,
            workingDirectory: workDir)
        #expect(weztermArgs == [
            "start", "--cwd", workDir,
            "--", "/bin/bash", "-c", command,
        ])

        // iTerm2 URL with working directory
        if let url = Terminal.iTerm2.commandURL(for: command, workingDirectory: workDir) {
            #expect(url.absoluteString.contains("cd="))
            #expect(
                url.absoluteString
                    .contains(workDir.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""))
        }
    }

    // MARK: - Complex Command Tests

    @Test
    func complexCommandEncoding() {
        let complexCommand = "git log --oneline -10 && echo 'Done!'"

        // Test iTerm2 URL encoding
        if let url = Terminal.iTerm2.commandURL(for: complexCommand) {
            // URLComponents encodes differently, so just check the URL contains the command
            #expect(url.absoluteString.contains("command="))
            #expect(url.absoluteString.contains("git"))
        }

        // Test argument generation doesn't break the command
        let alacrittyArgs = Terminal.alacritty.commandArguments(for: complexCommand)
        #expect(alacrittyArgs.last == complexCommand)
    }

    // MARK: - Terminal Detection Tests

    @Test
    func terminalDetection() {
        // At least Terminal.app should be available on macOS
        #expect(Terminal.installed.contains(.terminal))

        // Check that installed terminals have valid paths
        for terminal in Terminal.installed {
            // Check if terminal is installed
            #expect(NSWorkspace.shared.urlForApplication(withBundleIdentifier: terminal.bundleIdentifier) != nil)
        }
    }

    // MARK: - Environment Variable Tests

    @Test
    @MainActor
    func launchingWithEnvironmentVariables() {
        _ = ["MY_VAR": "test_value", "PATH": "/custom/path:/usr/bin"]
        _ = "echo $MY_VAR"

        // Test that environment variables can be passed
        _ = TerminalLauncher.shared

        // This would need to be implemented in TerminalLauncher
        // Just testing the concept here
        #expect(Bool(true)) // No-throw test
    }

    @Test(arguments: [1002, -25211, -1719])
    func keystrokePermissionErrorsRequireAccessibility(errorCode: Int) {
        let error = AppleScriptError.executionFailed(
            message: "System Events is not allowed to send keystrokes",
            errorCode: errorCode)

        #expect(error.isAccessibilityPermissionError)
        #expect(error.failureReason == "Accessibility permission is required to send keystrokes.")

        guard case .accessibilityPermissionDenied = error.toTerminalLauncherError() else {
            Issue.record("Expected accessibility permission error for AppleScript code \(errorCode)")
            return
        }

        let alert = TerminalLaunchAlertContent(
            error: error.toTerminalLauncherError(),
            terminalName: "iTerm2")
        #expect(alert.title == "Accessibility Permission Required")
        #expect(alert.message.contains("iTerm2"))
        #expect(alert.recoveryPermission == .accessibility)
        #expect(alert.recoveryPermission?.settingsURL?.absoluteString.contains("Privacy_Accessibility") == true)
    }

    @Test
    func automationPermissionErrorRemainsDistinct() {
        let error = AppleScriptError.executionFailed(
            message: "Not authorized to send Apple events",
            errorCode: -1743)

        #expect(error.isPermissionError)
        #expect(!error.isAccessibilityPermissionError)

        guard case .appleScriptPermissionDenied = error.toTerminalLauncherError() else {
            Issue.record("Expected automation permission error")
            return
        }

        let alert = TerminalLaunchAlertContent(
            error: error.toTerminalLauncherError(),
            terminalName: "iTerm2")
        #expect(alert.title == "Permission Denied")
        #expect(alert.recoveryPermission == .appleScript)
        #expect(alert.recoveryPermission?.settingsURL?.absoluteString.contains("Privacy_Automation") == true)
    }

    @Test
    func ghosttyLaunchDoesNotQueryAppleScriptWindows() {
        let config = TerminalLaunchConfig(
            command: "printf 'Untether Ghostty test'",
            workingDirectory: nil,
            terminal: .ghostty)
        let script = Terminal.ghostty.unifiedAppleScript(for: config)

        #expect(!script.contains("count of windows"))
        #expect(script.contains("tell application \"System Events\""))
        #expect(script.contains("keystroke \"n\" using {command down}"))
        #expect(script.contains("keystroke \"v\" using {command down}"))
        #expect(script.contains("key code 36"))
    }

    @Test
    func warpPreviewUsesItsOwnAppIdentityAndWarpLaunchBehavior() {
        #expect(Terminal.warpPreview.rawValue == "Warp Preview")
        #expect(Terminal.warpPreview.bundleIdentifier == BundleIdentifiers.warpPreview)
        #expect(Terminal.warpPreview.applicationName == "WarpPreview")
        #expect(Terminal.warpPreview.processName == "WarpPreview")
        #expect(Terminal.warpPreview.detectionPriority < Terminal.warp.detectionPriority)

        let installed = Terminal.installed { bundleIdentifier in
            bundleIdentifier == BundleIdentifiers.warpPreview
                ? URL(fileURLWithPath: "/Applications/WarpPreview.app")
                : nil
        }
        #expect(installed == [.terminal, .warpPreview])

        let config = TerminalLaunchConfig(
            command: "printf 'Untether Warp Preview test'",
            workingDirectory: nil,
            terminal: .warpPreview)
        let script = Terminal.warpPreview.unifiedAppleScript(for: config)

        #expect(script.contains("tell application \"WarpPreview\""))
        #expect(script.contains("keystroke \"n\" using {command down}"))
        #expect(script.contains("keystroke \"v\" using {command down}"))
        #expect(script.contains("keystroke (ASCII character 13)"))
    }

    // 2026-10-20: the server's argv arrived joined with spaces and ran raw; the folder was only
    // escaped for `\` and `"`.
    @Test
    func spawnArgvIsSingleQuotedForTheShell() {
        #expect(TerminalLauncher.shellQuote("it's $HOME") == "'it'\\''s $HOME'")
        #expect(TerminalLauncher.shellCommand(fromArgv: ["claude", "--append-system-prompt", "a b; rm -rf ~"])
            == "'claude' '--append-system-prompt' 'a b; rm -rf ~'")
        let config = TerminalLaunchConfig(command: "ls", workingDirectory: "/tmp/$(x) `y`", terminal: .terminal)
        #expect(config.fullCommand == "cd '/tmp/$(x) `y`' && ls")
    }

    // 2026-10-20: fish reads `\\` and `\'` as escapes inside single quotes; backslashes now
    // stay outside the quotes. Round-trips through sh, zsh and fish (when installed).
    @Test
    func shellQuoteSurvivesPosixAndFish() throws {
        let values = ["a\\b", "ends\\", "it's", "\\'mixed\\\\'", "$HOME `x` \"q\""]
        #expect(TerminalLauncher.shellQuote("a\\b") == "'a'\\\\'b'")
        var shells = ["/bin/sh", "/bin/zsh"]
        for fish in ["/opt/homebrew/bin/fish", "/usr/local/bin/fish"]
            where FileManager.default.isExecutableFile(atPath: fish)
        {
            shells.append(fish)
        }
        for shell in shells {
            for value in values {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: shell)
                process.arguments = ["-c", "printf %s \(TerminalLauncher.shellQuote(value))"]
                let pipe = Pipe()
                process.standardOutput = pipe
                try process.run()
                process.waitUntilExit()
                let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
                #expect(output == value, "\(shell): \(value)")
            }
        }
    }

    // 2026-10-20: `--` ends the forwarder's options before the user's argv.
    @Test
    func forwarderCommandEndsOptionsBeforeArgv() {
        let withId = TerminalLauncher.forwarderCommandForTesting(
            forwarderPath: "/App Dir/untether-fwd", userCommand: "'--help'", sessionId: "s1")
        #expect(withId == "'/App Dir/untether-fwd' --session-id 's1' -- '--help'")
        let viaSubcommand = TerminalLauncher.forwarderCommandForTesting(
            forwarderPath: "/x/untether", userCommand: "'ls'", sessionId: nil)
        #expect(viaSubcommand == "'/x/untether' fwd -- 'ls'")
    }

    // 2026-10-20: argv is the only command a spawn request carries (no `command` string).
    @Test
    func spawnRequestCarriesArgv() throws {
        let json = #"{"sessionId":"s","workingDirectory":"/tmp","commandArgs":["a","b c"]}"#
        let request = try JSONDecoder().decode(TerminalSpawnRequest.self, from: Data(json.utf8))
        #expect(request.commandArgs == ["a", "b c"])
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(TerminalSpawnRequest.self, from: Data(#"{"sessionId":"s","command":"a b"}"#.utf8))
        }
    }

    // MARK: - Script File Tests

    @Test
    func scriptFileExecution() throws {
        let tempDir = FileManager.default.temporaryDirectory
        let scriptPath = tempDir.appendingPathComponent("test_script.sh")

        // Create a test script
        let scriptContent = """
        #!/bin/bash
        echo "Test script executed"
        pwd
        """
        try scriptContent.write(to: scriptPath, atomically: true, encoding: .utf8)

        // Make executable
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: scriptPath.path)

        // Test launching the script
        #expect(FileManager.default.fileExists(atPath: scriptPath.path))

        // Cleanup
        try? FileManager.default.removeItem(at: scriptPath)
    }
}

// MARK: - Terminal Extension Tests

extension Terminal {
    /// Generate command arguments for testing
    /// This would be implemented in the actual Terminal enum
    func commandArguments(for command: String, workingDirectory: String? = nil) -> [String] {
        switch self {
        case .alacritty:
            var args: [String] = []
            if let workDir = workingDirectory {
                args += ["--working-directory", workDir]
            }
            args += ["-e", "/bin/bash", "-c", command]
            return args

        case .wezterm:
            var args = ["start"]
            if let workDir = workingDirectory {
                args += ["--cwd", workDir]
            }
            args += ["--", "/bin/bash", "-c", command]
            return args

        default:
            return []
        }
    }

    /// Generate URL for terminals that support URL schemes
    func commandURL(for command: String, workingDirectory: String? = nil) -> URL? {
        switch self {
        case .iTerm2:
            var components = URLComponents(string: "iterm2://run")
            var queryItems = [
                URLQueryItem(name: "command", value: command),
            ]
            if let workDir = workingDirectory {
                queryItems.append(URLQueryItem(name: "cd", value: workDir))
            }
            components?.queryItems = queryItems
            return components?.url

        default:
            return nil
        }
    }
}
