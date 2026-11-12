import AppKit
import CryptoKit
import Foundation
import Observation
import os.log
import SwiftUI

/// Service responsible for installing the ut wrapper script with sudo authentication.
///
/// ## Overview
/// This service copies the wrapper script from the application bundle to /usr/local/bin to enable command line
/// access to Untether. It handles sudo authentication through system dialogs.
///
/// ## Usage
/// ```swift
/// let installer = CLIInstaller()
/// installer.installCLITool()
/// ```
///
/// ## Safety Considerations
/// - Always prompts user before performing operations requiring sudo
/// - Provides clear error messages and graceful failure handling
/// - Replaces existing files or symlinks at the installation path
/// - Logs all operations for debugging purposes
@MainActor
@Observable
final class CLIInstaller {
    // MARK: - Properties

    private let logger = Logger(subsystem: BundleIdentifiers.main, category: "CLIInstaller")
    private let binDirectory: String

    private var utTargetPath: String {
        URL(fileURLWithPath: self.binDirectory).appendingPathComponent("ut").path
    }

    var isInstalled = false
    var isInstalling = false
    var lastError: String?
    var isOutdated = false
    var isUninstalling = false

    // MARK: - Initialization

    /// Creates a CLI installer
    /// - Parameters:
    ///   - binDirectory: Directory for installation (defaults to /usr/local/bin)
    init(binDirectory: String = FilePathConstants.usrLocalBin) {
        self.binDirectory = binDirectory
    }

    // MARK: - Public Interface

    /// Checks if the CLI tool is installed
    func checkInstallationStatus() {
        Task { @MainActor in
            // Check if ut script exists and is configured correctly
            var isCorrectlyInstalled = false

            // Check both /usr/local/bin and Apple Silicon Homebrew path
            let pathsToCheck = [
                utTargetPath,
                "\(FilePathConstants.optHomebrewBin)/ut",
            ]

            for path in pathsToCheck where FileManager.default.fileExists(atPath: path) {
                // Check if it contains the correct app path reference
                if let content = try? String(contentsOfFile: path, encoding: .utf8) {
                    // Verify it's our wrapper script with all expected components
                    // Check for the exec command with flexible quoting and optional arguments
                    // Allow for optional variables or arguments between $UNTETHER_BIN and fwd
                    let hasValidExecCommand = content.range(
                        of: #"exec\s+["']?\$UNTETHER_BIN["']?\s+fwd"#,
                        options: .regularExpression) != nil

                    if content.contains("Untether CLI wrapper"),
                       content.contains("$TRY_PATH/Contents/Resources/untether"),
                       hasValidExecCommand
                    {
                        isCorrectlyInstalled = true
                        logger.info("CLIInstaller: Found valid ut script at \(path)")
                        break
                    }
                }
            }

            // Update state
            self.isInstalled = isCorrectlyInstalled

            self.logger.info("CLIInstaller: ut script installed: \(self.isInstalled)")

            // If installed, check if it's outdated
            if self.isInstalled {
                self.checkScriptVersion()
            } else {
                self.isOutdated = false
            }
        }
    }

    /// Installs the CLI tool (async version for WelcomeView)
    func install() async {
        await MainActor.run {
            self.installCLITool()
        }
    }

    /// Installs the ut CLI tool to /usr/local/bin
    func installCLITool() {
        self.logger.info("CLIInstaller: Starting CLI tool installation...")
        self.isInstalling = true
        self.lastError = nil

        // Verify that ut script exists in the app bundle
        guard Bundle.main.path(forResource: "ut", ofType: nil) != nil else {
            self.logger.error("CLIInstaller: Could not find ut script in app bundle")
            self.lastError = String(localized: "The ut script could not be found in the application bundle.", comment: "Command line tool installer: error")
            self.showError(String(localized: "The ut script could not be found in the application bundle.", comment: "Command line tool installer: error"))
            self.isInstalling = false
            return
        }

        // Show confirmation dialog
        let confirmAlert = NSAlert()
        confirmAlert.messageText = String(localized: "Install UT Command Line Tool", comment: "Alert: command line tool installer, title")
        confirmAlert.informativeText = String(localized: "This will install the 'ut' command that runs Untether from your Applications folder. Administrator privileges are required.", comment: "Alert: command line tool installer, message")
        confirmAlert.addButton(withTitle: String(localized: "Install", comment: "Alert: command line tool installer, button"))
        confirmAlert.addButton(withTitle: String(localized: "Cancel", comment: "Alert: command line tool installer, button"))
        confirmAlert.alertStyle = .informational
        confirmAlert.icon = NSApp.applicationIconImage

        let response = confirmAlert.runModal()
        if response != .alertFirstButtonReturn {
            self.logger.info("CLIInstaller: User cancelled installation")
            self.isInstalling = false
            return
        }

        // Perform the installation
        self.performInstallation()
    }

    /// Uninstalls the ut CLI tool (async version)
    func uninstall() async {
        await MainActor.run {
            self.uninstallCLITool()
        }
    }

    /// Uninstalls the ut CLI tool from /usr/local/bin and /opt/homebrew/bin
    func uninstallCLITool() {
        self.logger.info("CLIInstaller: Starting CLI tool uninstallation...")
        self.isInstalling = true
        self.isUninstalling = true
        self.lastError = nil

        // Show confirmation dialog
        let confirmAlert = NSAlert()
        confirmAlert.messageText = String(localized: "Uninstall UT Command Line Tool", comment: "Alert: command line tool installer, title")
        confirmAlert.informativeText = String(localized: "This will remove the 'ut' command from your system. Administrator privileges are required.", comment: "Alert: command line tool installer, message")
        confirmAlert.addButton(withTitle: String(localized: "Uninstall", comment: "Alert: command line tool installer, button"))
        confirmAlert.addButton(withTitle: String(localized: "Cancel", comment: "Alert: command line tool installer, button"))
        confirmAlert.alertStyle = .informational
        confirmAlert.icon = NSApp.applicationIconImage

        let response = confirmAlert.runModal()
        if response != .alertFirstButtonReturn {
            self.logger.info("CLIInstaller: User cancelled uninstallation")
            self.isInstalling = false
            self.isUninstalling = false
            return
        }

        // Perform the uninstallation
        self.performUninstallation()
    }

    // MARK: - Private Implementation

    /// Performs the actual installation with sudo privileges
    private func performInstallation() {
        self.logger.info("CLIInstaller: Installing ut script")

        guard let utScriptPath = Bundle.main.path(forResource: "ut", ofType: nil) else {
            self.logger.error("CLIInstaller: Could not find ut script in app bundle")
            self.lastError = String(localized: "The ut script could not be found in the application bundle.", comment: "Command line tool installer: error")
            self.showError(String(localized: "The ut script could not be found in the application bundle.", comment: "Command line tool installer: error"))
            self.isInstalling = false
            return
        }

        // Create the installation script
        let script = """
        #!/bin/bash
        set -e

        # Create /usr/local/bin if it doesn't exist
        if [ ! -d "\(binDirectory)" ]; then
            mkdir -p "\(binDirectory)"
            echo "Created directory \(binDirectory)"
        fi

        # Remove existing ut if it exists
        if [ -L "\(utTargetPath)" ] || [ -f "\(utTargetPath)" ]; then
            rm -f "\(utTargetPath)"
            echo "Removed existing file at \(utTargetPath)"
        fi

        # Copy ut script from app bundle
        cp "\(utScriptPath)" "\(utTargetPath)"
        chmod +x "\(utTargetPath)"
        echo "Installed ut script at \(utTargetPath)"
        """

        // 2026-11-10: both scripts also ran `rm -f /usr/local/bin/untether` as root ("old
        // untether binary"). That path is where `npm install -g untether` puts its command:
        // installing or removing `ut` deleted something this app never put there.

        // Write the script to a temporary file
        let tempDir = FileManager.default.temporaryDirectory
        let scriptURL = tempDir.appendingPathComponent("install_ut_cli.sh")

        do {
            try script.write(to: scriptURL, atomically: true, encoding: .utf8)

            // Make the script executable
            let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o755]
            try FileManager.default.setAttributes(attributes, ofItemAtPath: scriptURL.path)

            self.logger.info("CLIInstaller: Created installation script at \(scriptURL.path)")

            // Execute with osascript to get sudo dialog
            let appleScript = """
            do shell script "bash '\(scriptURL.path)'" with administrator privileges
            """

            let task = Process()
            task.launchPath = "/usr/bin/osascript"
            task.arguments = ["-e", appleScript]

            let pipe = Pipe()
            let errorPipe = Pipe()
            task.standardOutput = pipe
            task.standardError = errorPipe

            try task.run()
            task.waitUntilExit()

            // Clean up the temporary script
            try? FileManager.default.removeItem(at: scriptURL)

            if task.terminationStatus == 0 {
                self.logger.info("CLIInstaller: Installation completed successfully")
                self.isInstalled = true
                self.isOutdated = false
                self.isInstalling = false
                self.showSuccess()
                // Refresh installation status
                self.checkInstallationStatus()
            } else {
                let errorString: String
                do {
                    if let errorData = try errorPipe.fileHandleForReading.readToEnd() {
                        errorString = String(data: errorData, encoding: .utf8) ?? String(localized: "Unknown error", comment: "Error with no details")
                    } else {
                        errorString = String(localized: "Unknown error", comment: "Error with no details")
                    }
                } catch {
                    self.logger.debug("Could not read error output: \(error.localizedDescription)")
                    errorString = String(localized: "Unknown error (could not read stderr)", comment: "Error with no details")
                }
                self.logger
                    .error("CLIInstaller: Installation failed with status \(task.terminationStatus): \(errorString)")
                self.lastError = String(localized: "Installation failed: \(errorString)", comment: "Command line tool install error. Placeholder: reason")
                self.isInstalling = false
                self.showError(String(localized: "Installation failed: \(errorString)", comment: "Command line tool install error. Placeholder: reason"))
            }
        } catch {
            self.logger.error("CLIInstaller: Installation failed with error: \(error)")
            self.lastError = String(localized: "Installation failed: \(error.localizedDescription)", comment: "Command line tool install error. Placeholder: reason")
            self.isInstalling = false
            self.showError(String(localized: "Installation failed: \(error.localizedDescription)", comment: "Command line tool install error. Placeholder: reason"))
        }
    }

    /// Performs the actual uninstallation with sudo privileges
    private func performUninstallation() {
        self.logger.info("CLIInstaller: Uninstalling ut script")

        // Create the uninstallation script
        let script = """
        #!/bin/bash
        set -e

        # Remove ut script from /usr/local/bin
        if [ -L "/usr/local/bin/ut" ] || [ -f "/usr/local/bin/ut" ]; then
            rm -f "/usr/local/bin/ut"
            echo "Removed ut from /usr/local/bin"
        fi

        # Remove ut script from /opt/homebrew/bin (Apple Silicon Homebrew path)
        if [ -L "/opt/homebrew/bin/ut" ] || [ -f "/opt/homebrew/bin/ut" ]; then
            rm -f "/opt/homebrew/bin/ut"
            echo "Removed ut from /opt/homebrew/bin"
        fi
        """

        // Write the script to a temporary file
        let tempDir = FileManager.default.temporaryDirectory
        let scriptURL = tempDir.appendingPathComponent("uninstall_ut_cli.sh")

        do {
            try script.write(to: scriptURL, atomically: true, encoding: .utf8)

            // Make the script executable
            let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o755]
            try FileManager.default.setAttributes(attributes, ofItemAtPath: scriptURL.path)

            self.logger.info("CLIInstaller: Created uninstallation script at \(scriptURL.path)")

            // Execute with osascript to get sudo dialog
            let appleScript = """
            do shell script "bash '\(scriptURL.path)'" with administrator privileges
            """

            let task = Process()
            task.launchPath = "/usr/bin/osascript"
            task.arguments = ["-e", appleScript]

            let pipe = Pipe()
            let errorPipe = Pipe()
            task.standardOutput = pipe
            task.standardError = errorPipe

            try task.run()
            task.waitUntilExit()

            // Clean up the temporary script
            try? FileManager.default.removeItem(at: scriptURL)

            if task.terminationStatus == 0 {
                self.logger.info("CLIInstaller: Uninstallation completed successfully")
                self.isInstalled = false
                self.isInstalling = false
                self.isUninstalling = false
                self.showUninstallSuccess()
                // Refresh installation status
                self.checkInstallationStatus()
            } else {
                let errorString: String
                do {
                    if let errorData = try errorPipe.fileHandleForReading.readToEnd() {
                        errorString = String(data: errorData, encoding: .utf8) ?? String(localized: "Unknown error", comment: "Error with no details")
                    } else {
                        errorString = String(localized: "Unknown error", comment: "Error with no details")
                    }
                } catch {
                    self.logger.debug("Could not read error output: \(error.localizedDescription)")
                    errorString = String(localized: "Unknown error (could not read stderr)", comment: "Error with no details")
                }
                self.logger
                    .error("CLIInstaller: Uninstallation failed with status \(task.terminationStatus): \(errorString)")
                self.lastError = String(localized: "Uninstallation failed: \(errorString)", comment: "Command line tool uninstall error. Placeholder: reason")
                self.isInstalling = false
                self.isUninstalling = false
                self.showError(String(localized: "Uninstallation failed: \(errorString)", comment: "Command line tool uninstall error. Placeholder: reason"))
            }
        } catch {
            self.logger.error("CLIInstaller: Uninstallation failed with error: \(error)")
            self.lastError = String(localized: "Uninstallation failed: \(error.localizedDescription)", comment: "Command line tool uninstall error. Placeholder: reason")
            self.isInstalling = false
            self.isUninstalling = false
            self.showError(String(localized: "Uninstallation failed: \(error.localizedDescription)", comment: "Command line tool uninstall error. Placeholder: reason"))
        }
    }

    /// Shows success message after installation
    private func showSuccess() {
        let alert = NSAlert()
        alert.messageText = String(localized: "CLI Tools Installed Successfully", comment: "Alert: command line tool installer, title")
        alert.informativeText = String(localized: "The 'ut' command has been installed. You can now use 'ut' from the terminal to run Untether.", comment: "Alert: command line tool installer, message")
        alert.addButton(withTitle: UIStrings.ok)
        alert.alertStyle = .informational
        alert.icon = NSApp.applicationIconImage
        alert.runModal()
    }

    /// Shows success message after uninstallation
    private func showUninstallSuccess() {
        let alert = NSAlert()
        alert.messageText = String(localized: "CLI Tools Uninstalled Successfully", comment: "Alert: command line tool installer, title")
        alert.informativeText = String(localized: "The 'ut' command has been removed from your system.", comment: "Alert: command line tool installer, message")
        alert.addButton(withTitle: UIStrings.ok)
        alert.alertStyle = .informational
        alert.icon = NSApp.applicationIconImage
        alert.runModal()
    }

    /// Shows error message for installation failures
    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = String(localized: "CLI Tool Installation Failed", comment: "Alert: command line tool installer, title")
        alert.informativeText = message
        alert.addButton(withTitle: UIStrings.ok)
        alert.alertStyle = .critical
        alert.runModal()
    }

    // MARK: - Script Version Detection

    /// Calculates SHA256 hash of a file
    private func calculateHash(for filePath: String) -> String? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: filePath)) else {
            return nil
        }

        let hash = SHA256.hash(data: data)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }

    /// Gets the hash of the bundled ut script
    private func getBundledScriptHash() -> String? {
        guard let scriptPath = Bundle.main.path(forResource: "ut", ofType: nil) else {
            self.logger.error("CLIInstaller: Bundled ut script not found")
            return nil
        }

        return self.calculateHash(for: scriptPath)
    }

    /// Checks if the installed script is outdated compared to bundled version
    func checkScriptVersion() {
        Task { @MainActor in
            guard let bundledHash = getBundledScriptHash() else {
                self.logger.error("CLIInstaller: Failed to get bundled script hash")
                self.isOutdated = false
                return
            }

            // Check both possible installation paths
            let pathsToCheck = [
                utTargetPath,
                "\(FilePathConstants.optHomebrewBin)/ut",
            ]

            var installedHash: String?
            for path in pathsToCheck where FileManager.default.fileExists(atPath: path) {
                if let hash = calculateHash(for: path) {
                    installedHash = hash
                    break
                }
            }

            // Update outdated status
            if let installedHash {
                self.isOutdated = (installedHash != bundledHash)
                self.logger.info("CLIInstaller: Script version check - outdated: \(self.isOutdated)")
                self.logger.debug("CLIInstaller: Bundled hash: \(bundledHash), Installed hash: \(installedHash)")
            } else {
                // Script not installed
                self.isOutdated = false
            }
        }
    }
}
