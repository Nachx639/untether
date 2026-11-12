import Foundation
import OSLog

/// Manages development server configuration and validation
@MainActor
final class DevServerManager: ObservableObject {
    static let shared = DevServerManager()

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "DevServerManager")

    /// Validates a development server path
    func validate(path: String) -> DevServerValidation {
        guard !path.isEmpty else {
            return .notValidated
        }

        // Expand tilde in path
        let expandedPath = NSString(string: path).expandingTildeInPath
        let projectURL = URL(fileURLWithPath: expandedPath)

        // Check if directory exists
        guard FileManager.default.fileExists(atPath: expandedPath) else {
            return .invalid(String(localized: "Directory does not exist", comment: "Settings, Debug: development server folder check"))
        }

        // Check if package.json exists
        let packageJsonPath = projectURL.appendingPathComponent("package.json").path
        guard FileManager.default.fileExists(atPath: packageJsonPath) else {
            return .invalid(String(localized: "No package.json found in directory", comment: "Settings, Debug: development server folder check"))
        }

        // Check if pnpm is installed
        guard self.isPnpmInstalled() else {
            return .invalid(String(localized: "pnpm is not installed. Install it with: npm install -g pnpm", comment: "Settings, Debug: development server folder check. Keep the command as is"))
        }

        // Check if dev script exists
        guard self.hasDevScript(at: packageJsonPath) else {
            return .invalid(String(localized: "No 'dev' script found in package.json", comment: "Settings, Debug: development server folder check"))
        }

        self.logger.info("Dev server path validated successfully: \(expandedPath)")
        return .valid
    }

    /// Checks if pnpm is installed on the system
    private func isPnpmInstalled() -> Bool {
        if self.knownPnpmPath() != nil {
            return true
        }
        // Not found yet: one synchronous login-shell lookup (cached on success). Async callers
        // use resolvePnpmPath() first, so this only runs for the Settings validation.
        guard let path = Self.lookUpPnpmViaShell() else { return false }
        self.cachedPnpmPath = path
        return true
    }

    /// pnpm path found earlier via the login shell (shell startup is slow, so cache it)
    private var cachedPnpmPath: String?

    private static let commonPnpmPaths = [
        "/usr/local/bin/pnpm",
        "/opt/homebrew/bin/pnpm",
        "/usr/bin/pnpm",
        NSString("~/Library/pnpm/pnpm").expandingTildeInPath,
        NSString("~/.local/share/pnpm/pnpm").expandingTildeInPath,
    ]

    /// pnpm from the well-known locations or the cache, without spawning anything
    private func knownPnpmPath() -> String? {
        if let path = Self.commonPnpmPaths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return path
        }
        if let cached = self.cachedPnpmPath, FileManager.default.isExecutableFile(atPath: cached) {
            return cached
        }
        self.cachedPnpmPath = nil
        return nil
    }

    /// Finds pnpm, running the login-shell lookup off the main actor when needed.
    func resolvePnpmPath() async -> String? {
        if let path = self.knownPnpmPath() {
            return path
        }
        let path = await Task.detached(priority: .userInitiated) {
            Self.lookUpPnpmViaShell()
        }.value
        if let path {
            self.cachedPnpmPath = path
            self.logger.debug("Found pnpm via shell at: \(path)")
        }
        return path
    }

    /// Runs `zsh -l -c "command -v pnpm"` (blocking: call off the main actor when possible)
    private nonisolated static func lookUpPnpmViaShell() -> String? {
        let findPnpm = Process()
        findPnpm.executableURL = URL(fileURLWithPath: "/bin/zsh")
        findPnpm.arguments = ["-l", "-c", "command -v pnpm"]
        let outputPipe = Pipe()
        findPnpm.standardOutput = outputPipe
        findPnpm.standardError = FileHandle.nullDevice

        // Set up environment with common PATH additions
        var environment = ProcessInfo.processInfo.environment
        let homePath = NSHomeDirectory()
        let additionalPaths = [
            "\(homePath)/Library/pnpm",
            "\(homePath)/.local/share/pnpm",
            "/usr/local/bin",
            "/opt/homebrew/bin",
        ].joined(separator: ":")

        if let existingPath = environment["PATH"] {
            environment["PATH"] = "\(existingPath):\(additionalPaths)"
        } else {
            environment["PATH"] = additionalPaths
        }
        findPnpm.environment = environment

        do {
            try findPnpm.run()
            let data = outputPipe.fileHandleForReading.readDataToEndOfFile()
            findPnpm.waitUntilExit()
            guard findPnpm.terminationStatus == 0,
                  let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !output.isEmpty,
                  output.hasPrefix("/")
            else { return nil }
            return output
        } catch {
            Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "DevServerManager")
                .error("Failed to find pnpm path: \(error.localizedDescription)")
            return nil
        }
    }

    /// Checks if package.json has a dev script
    private func hasDevScript(at packageJsonPath: String) -> Bool {
        struct PackageJSON: Decodable {
            let scripts: [String: String]?
        }

        guard let data = try? Data(contentsOf: URL(fileURLWithPath: packageJsonPath)),
              let package = try? JSONDecoder().decode(PackageJSON.self, from: data)
        else {
            return false
        }

        return package.scripts?["dev"] != nil
    }

    /// Gets the expanded path for a given path string
    func expandedPath(for path: String) -> String {
        NSString(string: path).expandingTildeInPath
    }

    /// Builds the command arguments for running the dev server
    /// `network` defaults to ServerNetworkPolicy for these settings: with no sign-in, loopback
    /// and no Tailscale (2026-10-20: the server refuses --no-auth on the network).
    func buildDevServerArguments(
        port: String,
        bindAddress: String,
        authMode: String,
        localToken: String?,
        network: ServerNetworkPolicy? = nil)
        -> [String]
    {
        let network = network ?? ServerNetworkPolicy.resolve(
            authMode: authMode,
            bindAddress: bindAddress,
            tailscaleServe: appDefaults.bool(forKey: AppConstants.UserDefaultsKeys.tailscaleServeEnabled),
            tailscaleFunnel: appDefaults.bool(forKey: AppConstants.UserDefaultsKeys.tailscaleFunnelEnabled))
        var args = ["run", "dev", "--"]

        // Add the same arguments as the production server
        args.append(contentsOf: ["--port", port, "--bind", network.bindAddress])

        // Add authentication flags based on configuration
        switch authMode {
        case "none":
            args.append("--no-auth")
        case "ssh":
            args.append(contentsOf: ["--enable-ssh-keys", "--disallow-user-password"])
        case "both":
            args.append("--enable-ssh-keys")
        default:
            // OS authentication is the default
            break
        }

        // Add local bypass authentication for the Mac app. The token itself goes in the
        // server's environment, never here (LocalAuthTokenEnvironment).
        if authMode != "none", localToken != nil {
            args.append("--allow-local-bypass")
        }

        // Add Tailscale Serve integration if enabled
        if network.tailscaleServe {
            args.append("--enable-tailscale-serve")
            self.logger.info("Tailscale Serve integration enabled")
        }

        // Add Tailscale Funnel integration if enabled
        if network.tailscaleFunnel {
            args.append("--enable-tailscale-funnel")
            self.logger.warning("Tailscale Funnel integration enabled - PUBLIC INTERNET ACCESS")
        }

        return args
    }
}
