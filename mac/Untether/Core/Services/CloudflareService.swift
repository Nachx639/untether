import AppKit
import Darwin
import Foundation
import Observation
import os

/// Manages Cloudflare tunnel integration and status checking.
///
/// `CloudflareService` provides functionality to check if cloudflared CLI is installed
/// and running on the system, and manages Quick Tunnels for exposing the local
/// Untether server. Unlike ngrok, cloudflared Quick Tunnels don't require auth tokens.
@Observable
@MainActor
final class CloudflareService {
    static let shared = CloudflareService()

    /// Standard paths to check for cloudflared binary
    private static let cloudflaredPaths = [
        "/usr/local/bin/cloudflared",
        "/opt/homebrew/bin/cloudflared",
        "/usr/bin/cloudflared",
        "/etc/profiles/per-user/\(NSUserName())/bin/cloudflared",
    ]
    static var cloudflaredSearchPaths: [String] {
        cloudflaredPaths
    }

    // MARK: - Constants

    /// Periodic status check interval in seconds
    private static let statusCheckInterval: TimeInterval = 5.0

    /// Timeout for stopping tunnel in seconds
    private static let stopTimeoutSeconds: UInt64 = 500_000_000 // 0.5 seconds in nanoseconds

    /// Timeout for process termination in seconds
    private static let processTerminationTimeout: UInt64 = 2_000_000_000 // 2 seconds in nanoseconds

    /// Logger instance for debugging
    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "CloudflareService")

    /// Indicates if cloudflared CLI is installed on the system
    private(set) var isInstalled = false

    /// Indicates if a Cloudflare tunnel is currently running
    private(set) var isRunning = false

    /// The public URL for the active tunnel (e.g., "https://random-words.trycloudflare.com")
    private(set) var publicUrl: String?

    /// Error message if status check fails
    private(set) var statusError: String?

    /// Path to the cloudflared binary if found
    private(set) var cloudflaredPath: String?

    /// Flag to disable URL opening in tests
    static var isTestMode = false

    /// Currently running cloudflared process
    private var cloudflaredProcess: Process?

    /// Task for monitoring tunnel status
    private var statusMonitoringTask: Task<Void, Never>?

    /// Background tasks for monitoring output
    private var outputMonitoringTasks: [Task<Void, Never>] = []

    private init() {
        Task {
            self.endTunnelLeftByAPreviousRun()
            await self.checkCloudflaredStatus()
        }
    }

    // MARK: - Only our own tunnel

    // 2026-11-10: "is a tunnel running" was `pgrep -f "cloudflared.*tunnel.*--url"` and
    // stopping (and every app quit) ran `pkill` with the same pattern. A quick tunnel the user
    // had started for something else showed here as Untether's, blocked starting ours, and
    // was killed on Stop and whenever the app quit. This service now knows one tunnel: the
    // process it started. Its pid is kept in the preferences so that a tunnel that outlived a
    // crash of the app is ended at the next launch, and nothing else ever is.

    private static let ownedProcessKey = "cloudflaredOwnedProcessID"

    private func rememberOwnedProcess(_ process: Process?) {
        if let process {
            appDefaults.set(Int(process.processIdentifier), forKey: Self.ownedProcessKey)
        } else {
            appDefaults.removeObject(forKey: Self.ownedProcessKey)
        }
    }

    /// Whether a command line is a cloudflared quick tunnel (what this service starts).
    nonisolated static func isQuickTunnel(commandLine: String?) -> Bool {
        guard let commandLine else { return false }
        let words = commandLine.split(separator: " ")
        guard let executable = words.first, executable.hasSuffix("cloudflared") else { return false }
        return words.dropFirst().starts(with: ["tunnel", "--url"])
    }

    private nonisolated static func commandLine(ofProcess pid: Int32) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-p", String(pid), "-o", "command="]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        } catch {
            return nil
        }
    }

    /// Ends the tunnel this app started in a run that did not get to stop it.
    private func endTunnelLeftByAPreviousRun() {
        let pid = Int32(clamping: appDefaults.integer(forKey: Self.ownedProcessKey))
        guard pid > 1, self.cloudflaredProcess == nil else { return }
        self.rememberOwnedProcess(nil)
        guard Self.isQuickTunnel(commandLine: Self.commandLine(ofProcess: pid)) else { return }
        self.logger.notice("Ending the cloudflared tunnel a previous run left behind (pid \(pid))")
        kill(pid, SIGTERM)
    }

    /// Checks if cloudflared CLI is installed
    func checkCLIInstallation() -> Bool {
        // Check standard paths first
        for path in Self.cloudflaredPaths where FileManager.default.fileExists(atPath: path) {
            cloudflaredPath = path
            logger.info("Found cloudflared at: \(path)")
            return true
        }

        // Try using 'which' command as fallback
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        process.arguments = ["cloudflared"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()

        do {
            try process.run()
            process.waitUntilExit()

            if process.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !path.isEmpty
                {
                    self.cloudflaredPath = path
                    self.logger.info("Found cloudflared via 'which' at: \(path)")
                    return true
                }
            }
        } catch {
            self.logger.debug("Failed to run 'which cloudflared': \(error)")
        }

        self.logger.info("cloudflared CLI not found")
        return false
    }

    /// Checks the current cloudflared status and updates properties
    func checkCloudflaredStatus() async {
        // First check if CLI is installed
        self.isInstalled = self.checkCLIInstallation()

        guard self.isInstalled else {
            self.isRunning = false
            self.publicUrl = nil
            self.statusError = String(localized: "cloudflared is not installed", comment: "Settings, Remote Access: Cloudflare status error. cloudflared is a command name")
            return
        }

        // Check if there's a running process
        let wasRunning = self.isRunning
        self.isRunning = self.cloudflaredProcess?.isRunning == true

        if self.isRunning {
            self.statusError = nil
            self.logger.info("cloudflared tunnel is running")

            // Don't clear publicUrl if we already have it
            // Only clear it if we're transitioning from running to not running
            if !wasRunning {
                // Tunnel just started, URL will be set by startQuickTunnel
                self.logger.info("Tunnel detected as running, preserving existing URL: \(self.publicUrl ?? "none")")
            }
        } else {
            // Only clear URL when tunnel is not running
            self.publicUrl = nil
            self.statusError = String(localized: "No active cloudflared tunnel", comment: "Settings, Remote Access: Cloudflare status error. cloudflared is a command name")
            self.logger.info("No active cloudflared tunnel found")
        }
    }

    /// Starts a Quick Tunnel using cloudflared
    func startQuickTunnel(port: Int) async throws {
        guard self.isInstalled, let binaryPath = cloudflaredPath else {
            throw CloudflareError.notInstalled
        }

        guard !self.isRunning else {
            throw CloudflareError.tunnelAlreadyRunning
        }
        // 2026-10-20: no tunnel to a server without sign-in (ServerNetworkPolicy).
        guard !ServerNetworkPolicy.tunnelsBlockedByNoAuth else {
            throw CloudflareError.tunnelCreationFailed(ServerNetworkPolicy.tunnelBlockedMessage)
        }

        self.logger.info("Starting cloudflared Quick Tunnel on port \(port)")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binaryPath)
        process.arguments = ["tunnel", "--url", "http://localhost:\(port)"]

        // Create pipes for monitoring
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        do {
            try process.run()
            self.cloudflaredProcess = process
            self.rememberOwnedProcess(process)

            // Immediately mark as running since process started successfully
            self.isRunning = true
            self.statusError = nil

            // Start background monitoring for URL extraction
            self.startTunnelURLMonitoring(outputPipe: outputPipe, errorPipe: errorPipe)

            // Start periodic monitoring
            self.startPeriodicMonitoring()

            self.logger.info("Cloudflare tunnel process started successfully, URL will be available shortly")
        } catch {
            // Clean up on failure
            if let process = cloudflaredProcess {
                process.terminate()
                self.cloudflaredProcess = nil
            }

            self.logger.error("Failed to start cloudflared process: \(error)")
            throw CloudflareError.tunnelCreationFailed(error.localizedDescription)
        }
    }

    /// Sends a termination signal to the cloudflared process without waiting
    /// This is used during app termination for quick cleanup
    func sendTerminationSignal() {
        self.logger.info("🚀 Quick termination signal requested")

        // Cancel monitoring tasks immediately
        self.statusMonitoringTask?.cancel()
        self.statusMonitoringTask = nil
        self.outputMonitoringTasks.forEach { $0.cancel() }
        self.outputMonitoringTasks.removeAll()

        // Send termination signal to our process if we have one
        if let process = cloudflaredProcess {
            self.logger.info("🚀 Sending SIGTERM to cloudflared process PID \(process.processIdentifier)")
            process.terminate()
            // Don't wait - let it clean up asynchronously
        }

        self.rememberOwnedProcess(nil)

        // Update state immediately
        self.isRunning = false
        self.publicUrl = nil
        self.cloudflaredProcess = nil

        self.logger.info("🚀 Quick termination signal sent")
    }

    /// Stops the running Quick Tunnel
    func stopQuickTunnel() async {
        self.logger.info("🛑 Starting cloudflared Quick Tunnel stop process")

        // Cancel monitoring tasks first
        self.statusMonitoringTask?.cancel()
        self.statusMonitoringTask = nil
        self.outputMonitoringTasks.forEach { $0.cancel() }
        self.outputMonitoringTasks.removeAll()

        // Try to terminate the process we spawned first
        if let process = cloudflaredProcess {
            self.logger.info("🛑 Found cloudflared process to terminate: PID \(process.processIdentifier)")

            // Send terminate signal
            process.terminate()

            // For normal stops, we can wait a bit
            try? await Task.sleep(nanoseconds: Self.stopTimeoutSeconds)

            // Check if it's still running and force kill if needed
            if process.isRunning {
                self.logger.warning("🛑 Process didn't terminate gracefully, sending SIGINT")
                process.interrupt()

                // Wait for exit with timeout
                await withTaskGroup(of: Void.self) { group in
                    group.addTask {
                        process.waitUntilExit()
                    }

                    group.addTask {
                        try? await Task.sleep(nanoseconds: Self.processTerminationTimeout)
                    }

                    // Cancel remaining tasks after first one completes
                    await group.next()
                    group.cancelAll()
                }
            }
        }

        // Clean up state
        self.rememberOwnedProcess(nil)
        self.cloudflaredProcess = nil
        self.isRunning = false
        self.publicUrl = nil
        self.statusError = nil

        self.logger.info("🛑 Cloudflared Quick Tunnel stop completed")
    }

    /// Start background monitoring for tunnel URL extraction
    private func startTunnelURLMonitoring(outputPipe: Pipe, errorPipe: Pipe) {
        // Cancel any existing monitoring tasks
        self.outputMonitoringTasks.forEach { $0.cancel() }
        self.outputMonitoringTasks.removeAll()

        // Monitor stdout using readabilityHandler
        let stdoutHandle = outputPipe.fileHandleForReading
        stdoutHandle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty {
                if let output = String(data: data, encoding: .utf8) {
                    Task { @MainActor in
                        await self?.processOutput(output, isError: false)
                    }
                }
            } else {
                // No more data, stop monitoring
                handle.readabilityHandler = nil
            }
        }

        // Monitor stderr using readabilityHandler
        let stderrHandle = errorPipe.fileHandleForReading
        stderrHandle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty {
                if let output = String(data: data, encoding: .utf8) {
                    Task { @MainActor in
                        await self?.processOutput(output, isError: true)
                    }
                }
            } else {
                // No more data, stop monitoring
                handle.readabilityHandler = nil
            }
        }

        // Store cleanup task for proper handler removal
        let cleanupTask = Task.detached { @Sendable [weak self] in
            // Wait for cancellation
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
            }

            // Clean up handlers when cancelled
            await MainActor.run {
                stdoutHandle.readabilityHandler = nil
                stderrHandle.readabilityHandler = nil
                self?.logger.info("🔍 Cleaned up file handle readability handlers")
            }
        }

        self.outputMonitoringTasks = [cleanupTask]
    }

    /// Process output from cloudflared (called on MainActor)
    private func processOutput(_ output: String, isError: Bool) async {
        let prefix = isError ? "cloudflared stderr" : "cloudflared output"
        self.logger.debug("\(prefix): \(output)")

        if let url = extractTunnelURL(from: output) {
            self.logger.info("🔗 Setting publicUrl to: \(url)")
            self.publicUrl = url
            self.logger.info("🔗 publicUrl is now: \(self.publicUrl ?? "nil")")
        }
    }

    /// Start periodic monitoring to check if tunnel is still running
    private func startPeriodicMonitoring() {
        self.statusMonitoringTask?.cancel()

        self.statusMonitoringTask = Task.detached { @Sendable in
            while !Task.isCancelled {
                // Check periodically if the process is still running
                try? await Task.sleep(nanoseconds: UInt64(Self.statusCheckInterval * 1_000_000_000))

                await Self.shared.checkProcessStatus()
            }
        }
    }

    /// Check if the tunnel process is still running (called on MainActor)
    private func checkProcessStatus() async {
        guard let process = cloudflaredProcess else {
            // Process is gone, update status
            self.isRunning = false
            self.publicUrl = nil
            self.statusError = String(localized: "Tunnel process terminated", comment: "Settings, Remote Access: Cloudflare status error")
            return
        }

        if !process.isRunning {
            // Process died, update status
            self.isRunning = false
            self.publicUrl = nil
            self.statusError = String(localized: "Tunnel process terminated unexpectedly", comment: "Settings, Remote Access: Cloudflare status error")
            self.cloudflaredProcess = nil
            self.rememberOwnedProcess(nil)
            return
        }
    }

    /// Extracts tunnel URL from cloudflared output
    private func extractTunnelURL(from output: String) -> String? {
        // More specific regex to match exactly the cloudflare tunnel URL format
        // Matches: https://subdomain.trycloudflare.com with optional trailing slash
        let pattern = #"https://[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.trycloudflare\.com/?(?:\s|$)"#

        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            self.logger.error("Failed to create regex for URL extraction")
            return nil
        }

        let range = NSRange(location: 0, length: output.utf16.count)

        if let match = regex.firstMatch(in: output, options: [], range: range) {
            let urlRange = Range(match.range, in: output)
            if let urlRange {
                var url = String(output[urlRange]).trimmingCharacters(in: .whitespacesAndNewlines)
                // Remove trailing slash if present
                if url.hasSuffix("/") {
                    url = String(url.dropLast())
                }
                self.logger.info("Extracted tunnel URL: \(url)")
                return url
            }
        }

        return nil
    }

    /// Opens the Homebrew installation command
    func openHomebrewInstall() {
        let command = "brew install cloudflared"
        let pasteboard = appPasteboard
        pasteboard.declareTypes([.string], owner: nil)
        pasteboard.setString(command, forType: .string)

        self.logger.info("Copied Homebrew install command to clipboard: \(command)")

        // Optionally open Terminal to run the command
        if !Self.isTestMode, let url = URL(string: "https://formulae.brew.sh/formula/cloudflared") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Opens the direct download page
    func openDownloadPage() {
        if !Self.isTestMode, let url = URL(string: "https://github.com/cloudflare/cloudflared/releases/latest") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Opens the setup guide
    func openSetupGuide() {
        if !Self.isTestMode,
           let url =
           URL(string: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/")
        {
            NSWorkspace.shared.open(url)
        }
    }
}

/// Cloudflare-specific errors
enum CloudflareError: LocalizedError, Equatable {
    case notInstalled
    case tunnelAlreadyRunning
    case tunnelCreationFailed(String)
    case networkError(String)
    case invalidOutput
    case processTerminated

    var errorDescription: String? {
        switch self {
        case .notInstalled:
            String(localized: "cloudflared is not installed", comment: "Error: Cloudflare remote access")
        case .tunnelAlreadyRunning:
            String(localized: "A tunnel is already running", comment: "Error: Cloudflare remote access")
        case let .tunnelCreationFailed(message):
            String(localized: "Failed to create tunnel: \(message)", comment: "Error: Cloudflare remote access")
        case let .networkError(message):
            String(localized: "Network error: \(message)", comment: "Error: Cloudflare remote access")
        case .invalidOutput:
            String(localized: "Invalid output from cloudflared", comment: "Error: Cloudflare remote access")
        case .processTerminated:
            String(localized: "cloudflared process terminated unexpectedly", comment: "Error: Cloudflare remote access")
        }
    }
}
