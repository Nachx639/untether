import Foundation

/// Centralized file path constants
enum FilePathConstants {
    // MARK: - System Paths

    static let usrBin = "/usr/bin"
    static let bin = "/bin"
    static let usrLocalBin = "/usr/local/bin"
    static let optHomebrewBin = "/opt/homebrew/bin"

    // MARK: - Command Paths

    static let which = "/usr/bin/which"
    static let git = "/usr/bin/git"

    // MARK: - Shell Paths

    static let defaultShell = "/bin/zsh"
    static let bash = "/bin/bash"
    static let zsh = "/bin/zsh"
    static let sh = "/bin/sh"

    // MARK: - Application Paths

    // MARK: - Temporary Directory

    // MARK: - Default Paths

    static let defaultRepositoryBasePath = "~/Documents"

    // MARK: - Common Repository Base Paths

    static let sourcePath = "~/Source"
    static let desktopPath = "~/Desktop"
    static let documentsPath = "~/Documents"
    static let downloadsPath = "~/Downloads"
    static let homePath = "~/"

    // MARK: - Resource Names

    // MARK: - Configuration Files

    static let entitlements = "Untether.entitlements"

    // MARK: - Helper Functions
}
