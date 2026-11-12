import CryptoKit
import Darwin
import Foundation
import OSLog

/// Server state enumeration
enum ServerState {
    case idle
    case starting
    case running
    case stopping
    case crashed
}

/// Bun untether server implementation.
///
/// Manages the Bun-based untether server as a subprocess. This implementation
/// provides JavaScript/TypeScript-based terminal multiplexing by leveraging the Bun
/// runtime. It handles process lifecycle, log streaming, and error recovery.
@MainActor
final class BunServer {
    /// Callback when the server crashes unexpectedly
    var onCrash: ((Int32) -> Void)?

    // MARK: - Properties

    /// The wrapper process; leader of the process group holding the whole server tree
    private var serverProcess: ServerProcess?
    /// Readers for the server's stdout/stderr
    private var outputSources: [DispatchSourceRead] = []

    /// Server state machine - thread-safe through MainActor
    private var state: ServerState = .idle

    /// Resource cleanup tracking
    private var isCleaningUp = false

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "BunServer")
    private let serverOutput = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "ServerOutput")

    var isRunning: Bool {
        self.state == .running
    }

    var port: String = ""

    var bindAddress: String = "127.0.0.1"

    /// The process identifier of the running server, if available
    var processIdentifier: Int32? {
        self.serverProcess?.pid
    }

    /// Local authentication token for bypassing auth on localhost
    private let localAuthToken: String = {
        // Generate a secure random token for this session
        let randomData = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        return randomData.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }()

    /// Get the local auth token for use in HTTP requests
    var localToken: String? {
        // Check if authentication is disabled
        let authConfig = AuthConfig.current()
        if authConfig.mode == "none" {
            return nil
        }
        return self.localAuthToken
    }

    /// Get the current authentication mode
    var authMode: String {
        AuthConfig.current().mode
    }

    // MARK: - Initialization

    init() {
        // No need for log streams anymore
    }

    // MARK: - Public Methods

    func start() async throws {
        // Update state atomically using MainActor
        let currentState = self.state
        if currentState == .running || currentState == .starting {
            self.logger.warning("Bun server already running or starting")
            return
        }
        if currentState == .stopping {
            self.logger.warning("Cannot start server while stopping")
            throw BunServerError.invalidState
        }
        self.state = .starting

        defer {
            // Ensure we reset state on error
            if state == .starting {
                state = .idle
            }
        }

        guard !self.port.isEmpty else {
            let error = BunServerError.invalidPort
            self.logger.error("Port not configured")
            throw error
        }

        // Check if we should use dev server
        let devConfig = DevServerConfig.current()

        if devConfig.useDevServer, !devConfig.devServerPath.isEmpty {
            self.logger.notice("🔧 Starting DEVELOPMENT SERVER with hot reload (pnpm run dev) on port \(self.port)")
            self.logger.info("Development path: \(devConfig.devServerPath)")
            self.serverOutput.notice("🔧 Untether Development Mode - Hot reload enabled")
            self.serverOutput.info("Project: \(devConfig.devServerPath)")
            try await self.startDevServer(path: devConfig.devServerPath)
        } else {
            self.logger.info("Starting production server (built-in SPA) on port \(self.port)")
            try await self.startProductionServer()
        }
    }

    private func startProductionServer() async throws {
        // Get the untether binary path (the Bun executable)
        guard let binaryPath = Bundle.main.path(forResource: "untether", ofType: nil) else {
            let error = BunServerError.binaryNotFound
            self.logger.error("untether binary not found in bundle")

            // Additional diagnostics for CI debugging
            self.logger.error("Bundle path: \(Bundle.main.bundlePath)")
            self.logger.error("Resources path: \(Bundle.main.resourcePath ?? "nil")")

            // List contents of Resources directory
            if let resourcesPath = Bundle.main.resourcePath {
                do {
                    let contents = try FileManager.default.contentsOfDirectory(atPath: resourcesPath)
                    self.logger.error("Resources directory contents: \(contents.joined(separator: ", "))")
                } catch {
                    self.logger.error("Failed to list Resources directory: \(error)")
                }
            }

            throw error
        }

        self.logger.info("Using Bun executable at: \(binaryPath)")

        // Ensure binary is executable
        do {
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binaryPath)
        } catch {
            self.logger.error("Failed to set executable permissions on binary: \(error.localizedDescription)")
            throw BunServerError.binaryNotFound
        }

        // Verify binary exists and is executable
        var isDirectory: ObjCBool = false
        let fileExists = FileManager.default.fileExists(atPath: binaryPath, isDirectory: &isDirectory)
        if fileExists, !isDirectory.boolValue {
            let attributes = try FileManager.default.attributesOfItem(atPath: binaryPath)
            if let permissions = attributes[.posixPermissions] as? NSNumber,
               let fileSize = attributes[.size] as? NSNumber
            {
                self.logger
                    .info(
                        "untether binary size: \(fileSize.intValue) bytes, permissions: \(String(permissions.intValue, radix: 8))")
            }
        } else if !fileExists {
            self.logger.error("untether binary NOT FOUND at: \(binaryPath)")
        }

        // Get the Resources directory path
        let resourcesPath = Bundle.main.resourcePath ?? Bundle.main.bundlePath

        // Set working directory to Resources/web directory where public folder is located
        let webPath = URL(fileURLWithPath: resourcesPath).appendingPathComponent("web").path
        self.logger.info("Process working directory: \(webPath)")

        // Static files are always at Resources/web/public
        let staticPath = URL(fileURLWithPath: resourcesPath).appendingPathComponent("web/public").path

        // Verify the web directory exists
        if !FileManager.default.fileExists(atPath: staticPath) {
            self.logger.error("Web directory not found at expected location: \(staticPath)")
        }

        // Build the untether command arguments as an array
        // Add Node.js V8 memory options first
        // Add authentication flags based on configuration
        let authConfig = AuthConfig.current()
        self.logger.info("Configuring authentication mode: \(authConfig.mode)")
        // No sign-in: loopback only, no Tailscale (ServerNetworkPolicy, 2026-10-20).
        let network = ServerNetworkPolicy.current(bindAddress: self.bindAddress)
        if !network.restricted.isEmpty {
            self.logger.warning(
                "Sign-in is None: server kept on 127.0.0.1, off: \(network.restricted.joined(separator: ", "))")
        }
        var untetherArgs = ["--port", String(port), "--bind", network.bindAddress]

        untetherArgs.append(contentsOf: Self.authArguments(mode: authConfig.mode))
        if authConfig.mode != "none" {
            self.logger.info("Local authentication bypass enabled for Mac app")
        }

        // Repository base path is now loaded from config.json by the server
        // No CLI argument needed

        // Add Tailscale Serve integration if enabled
        if network.tailscaleServe {
            untetherArgs.append("--enable-tailscale-serve")
            self.logger.info("Tailscale Serve integration enabled")

            self.logger.info("Tailscale Serve on: server listens on \(network.bindAddress) only")

            // Check if Public Internet access (Funnel) is enabled
            if network.tailscaleFunnel {
                untetherArgs.append("--enable-tailscale-funnel")
                self.logger.warning("Tailscale Funnel integration enabled - PUBLIC INTERNET ACCESS (Serve + Funnel)")
            } else {
                self.logger.info("Tailscale PRIVATE mode - Tailnet-only access (Serve without Funnel)")
            }
        } else {
            self.logger.info("Tailscale integration disabled")
        }

        let escapedArgs = untetherArgs.map(Self.shellQuote).joined(separator: " ")
        let wrapper = Self.wrapperScript(
            command: "\(Self.shellQuote(binaryPath)) \(escapedArgs)",
            exitMessage: "Untether server process died with exit code: $EXIT_CODE")

        self.logger.info("Executing command: /bin/zsh -l -c \"\(CommandLineRedactor.redact(wrapper))\"")
        self.logger.info("Binary location: \(resourcesPath)")
        self.logger.info("Server configuration: port=\(self.port), bindAddress=\(network.bindAddress)")

        // Set up a minimal environment for the SEA binary
        // SEA binaries can be sensitive to certain environment variables
        var environment = [String: String]()
        environment["NODE_OPTIONS"] = "--max-old-space-size=4096 --max-semi-space-size=128"

        // Copy only essential environment variables
        let essentialVars = [
            EnvironmentKeys.path,
            "HOME",
            "USER",
            "SHELL",
            EnvironmentKeys.lang,
            "LC_ALL",
            "LC_CTYPE",
            "UNTETHER_DEBUG",
        ]
        for key in essentialVars {
            if let value = ProcessInfo.processInfo.environment[key] {
                environment[key] = value
            }
        }

        // Set NODE_ENV to development in debug builds to disable caching
        #if DEBUG
        environment["NODE_ENV"] = "development"
        self.logger.info("Running in DEBUG configuration - setting NODE_ENV=development to disable caching")
        #endif

        LocalAuthTokenEnvironment.apply(token: self.localToken, to: &environment)

        // Set BUILD_PUBLIC_PATH to help the server find static files in the app bundle
        environment["BUILD_PUBLIC_PATH"] = staticPath
        self.logger.info("Setting BUILD_PUBLIC_PATH=\(staticPath)")

        do {
            let process = try self.launch(wrapper: wrapper, environment: environment, currentDirectory: webPath)
            self.logger.info("Bun server process started (pid/pgid \(process.pid))")

            // Give the process a moment to start before checking for early failures
            try await Task.sleep(for: .milliseconds(100))

            // Check if process exited immediately (indicating failure)
            if let exitCode = process.terminationStatus {
                if exitCode == 126 {
                    self.logger.error("Process exited immediately: Command not executable (exit code: 126)")
                    self.discardFailedLaunch()
                    throw BunServerError.binaryNotFound
                } else if exitCode == 9 {
                    self.logger.error("Process exited immediately: Port \(self.port) is already in use (exit code: 9)")
                } else {
                    self.logger.error("Process exited immediately with code: \(exitCode) (see ServerOutput log)")
                }
                self.discardFailedLaunch()
                throw BunServerError.processFailedToStart
            }

            // Mark server as running only after successful start
            self.state = .running
            self.logger.info("Bun server process started successfully")
            self.monitorProcessTermination(process)
        } catch {
            // Log more detailed error information
            let errorMessage: String = if let bunError = error as? BunServerError {
                bunError.localizedDescription
            } else if let posixError = error as? POSIXError {
                String(
                    localized: "System error: \(posixError.localizedDescription) (Code: \(posixError.code.rawValue))",
                    comment: "Error: starting the local server. First: reason, second: error code")
            } else {
                error.localizedDescription
            }

            self.logger.error("Failed to start Bun server: \(errorMessage)")
            throw error
        }
    }

    private func startDevServer(path: String) async throws {
        let devServerManager = DevServerManager.shared
        let expandedPath = devServerManager.expandedPath(for: path)

        // Resolve pnpm off the main actor first (cached); validation then reuses the result.
        let resolvedPnpm = await devServerManager.resolvePnpmPath()

        // Validate the path first
        let validation = devServerManager.validate(path: path)
        guard validation.isValid else {
            let error = BunServerError.devServerInvalid(validation.errorMessage
                ?? String(localized: "Invalid dev server path", comment: "Error: the development server folder is unusable"))
            self.logger.error("Dev server validation failed: \(error.localizedDescription)")
            throw error
        }

        self.logger.info("Dev server working directory: \(expandedPath)")

        // Get authentication mode
        let authConfig = AuthConfig.current()

        // Build the dev server arguments. No sign-in: loopback only, no Tailscale
        // (ServerNetworkPolicy, 2026-10-20).
        let network = ServerNetworkPolicy.current(bindAddress: self.bindAddress)
        if !network.restricted.isEmpty {
            self.logger.warning(
                "Dev mode, sign-in is None: server kept on 127.0.0.1, off: \(network.restricted.joined(separator: ", "))")
        }
        let effectiveBindAddress = network.bindAddress

        if network.tailscaleServe {
            self.logger.info("Dev mode, Tailscale Serve on: server listens on \(effectiveBindAddress) only")

            // Check if Public Internet access (Funnel) is enabled
            if network.tailscaleFunnel {
                self.logger.warning("Dev mode: Tailscale Funnel enabled - PUBLIC INTERNET ACCESS (Serve + Funnel)")
            } else {
                self.logger.info("Dev mode: Tailscale PRIVATE mode - Tailnet-only access (Serve without Funnel)")
            }
        } else {
            self.logger.info("Dev mode: Tailscale integration disabled")
        }

        let devArgs = devServerManager.buildDevServerArguments(
            port: self.port,
            bindAddress: effectiveBindAddress,
            authMode: authConfig.mode,
            localToken: self.localToken,
            network: network)

        // Find pnpm executable
        guard let pnpmPath = resolvedPnpm else {
            let error = BunServerError.devServerInvalid(String(
                localized: "pnpm executable not found",
                comment: "Error: the development server needs pnpm. pnpm is a program name"))
            self.logger.error("Failed to find pnpm executable")
            throw error
        }

        self.logger.info("Using pnpm at: \(pnpmPath)")

        let pnpmDir = URL(fileURLWithPath: pnpmPath).deletingLastPathComponent().path
        let command = """
        cd \(Self.shellQuote(expandedPath)) || exit 1
        export PATH=\(Self.shellQuote(pnpmDir)):"$PATH"
        \(([pnpmPath] + devArgs).map(Self.shellQuote).joined(separator: " "))
        """
        let wrapper = Self.wrapperScript(
            command: command,
            exitMessage: "🔴 Development server crashed with exit code: $EXIT_CODE (see 'pnpm run dev' output above)")

        self.logger.info("Executing command: /bin/zsh -l -c \"\(CommandLineRedactor.redact(wrapper))\"")
        self.logger.info("Working directory: \(expandedPath)")
        self.logger.info("Dev server configuration: port=\(self.port), bindAddress=\(effectiveBindAddress)")

        // Set up environment for dev server
        var environment = ProcessInfo.processInfo.environment
        // Add Node.js memory settings
        environment["NODE_OPTIONS"] = "--max-old-space-size=4096 --max-semi-space-size=128"
        LocalAuthTokenEnvironment.apply(token: self.localToken, to: &environment)

        // Always set NODE_ENV to development for dev server to ensure caching is disabled
        environment["NODE_ENV"] = "development"
        self.logger.info("Dev server mode - setting NODE_ENV=development to disable caching")

        // Add pnpm to PATH so that scripts can use it
        if let existingPath = environment[EnvironmentKeys.path] {
            environment[EnvironmentKeys.path] = "\(pnpmDir):\(existingPath)"
        } else {
            environment[EnvironmentKeys.path] = pnpmDir
        }
        self.logger.info("Added pnpm directory to PATH: \(pnpmDir)")

        do {
            let process = try self.launch(wrapper: wrapper, environment: environment, currentDirectory: expandedPath)
            self.logger.info("Dev server process started (pid/pgid \(process.pid))")

            // Output a clear banner in the server logs
            self.serverOutput.notice("")
            self.serverOutput.notice("==========================================")
            self.serverOutput.notice("🔧 DEVELOPMENT MODE ACTIVE")
            self.serverOutput.notice("------------------------------------------")
            self.serverOutput.notice("Hot reload enabled - changes auto-refresh")
            self.serverOutput.notice("Project: \(expandedPath, privacy: .public)")
            self.serverOutput.notice("Port: \(self.port, privacy: .public)")
            self.serverOutput.notice("==========================================")
            self.serverOutput.notice("")

            // Give the process a moment to start before checking for early failures
            try await Task.sleep(for: .milliseconds(500)) // Dev server takes longer to start

            // Check if process exited immediately (indicating failure)
            if let exitCode = process.terminationStatus {
                self.logger.error("Dev server process exited immediately with code: \(exitCode) (see ServerOutput log)")
                self.discardFailedLaunch()
                throw BunServerError.processFailedToStart
            }

            // Mark server as running only after successful start
            self.state = .running

            self.logger.notice("✅ Development server started successfully with hot reload")
            self.serverOutput.notice("🔧 Development server is running - changes will auto-reload")

            self.monitorProcessTermination(process)
        } catch {
            // Log more detailed error information
            self.logger.error("Failed to start dev server: \(error.localizedDescription)")
            throw error
        }
    }

    func stop() async {
        // Update state atomically using MainActor
        switch self.state {
        case .running, .crashed:
            break // Continue with stop
        default:
            self.logger.warning("Bun server not running (state: \(String(describing: self.state)))")
            return
        }

        // Prevent concurrent cleanup
        if self.isCleaningUp {
            self.logger.warning("Already cleaning up server")
            return
        }

        self.state = .stopping
        self.isCleaningUp = true

        defer {
            state = .idle
            isCleaningUp = false
        }

        guard let process = self.serverProcess else {
            self.logger.warning("No process to stop")
            self.performCleanup()
            return
        }

        self.logger.info("Stopping Bun server (process group \(process.pgid))")

        // SIGTERM to the wrapper (it forwards one TERM to the group), SIGKILL to the group after
        // 8 s: longer than the server's 6 s graceful shutdown (2026-10-20).
        await process.terminateGroup(grace: .seconds(ServerProcess.gracefulStopSeconds))
        if !(await process.waitForExit(timeout: .seconds(1))) {
            self.logger.warning("Server wrapper \(process.pid) has not been reaped yet")
        }

        self.performCleanup()

        self.logger.info("Bun server stopped")
    }

    /// Kills the server's process group synchronously. Used on app quit, where the main
    /// actor is blocked in `applicationWillTerminate` and can't await `stop()`.
    func terminateSynchronously(grace: TimeInterval) {
        guard let process = self.serverProcess else { return }
        self.onCrash = nil
        self.state = .stopping
        self.logger.info("App terminating: killing server process group \(process.pgid)")
        ServerProcess.terminateGroupSynchronously(pgid: process.pgid, grace: grace)
    }

    /// Whether the server's wrapper process is alive. Says nothing about whether the server
    /// answers HTTP: ServerManager's watchdog checks that.
    func checkHealth() async -> Bool {
        self.serverProcess?.isRunning ?? false
    }

    /// Get current server state
    func getState() -> ServerState {
        self.state
    }

    // MARK: - Private Methods

    /// Single-quotes a value for zsh.
    nonisolated static func shellQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    /// Wraps `command` so the whole server tree lives and dies together.
    ///
    /// The wrapper is spawned as a process group leader (see `ServerProcess`). It runs the
    /// command in the background, exits with the command's status when it dies (after
    /// killing anything it left behind in the group), forwards TERM/INT/HUP to the whole
    /// group, and kills the group when the app disappears without stopping it.
    /// 0.3 s polls the wrapper waits for the server after forwarding TERM (about 8 s).
    nonisolated static let wrapperStopPolls = Int((ServerProcess.gracefulStopSeconds / 0.3).rounded(.up))

    /// Auth flags for the embedded server. The local bypass token goes in the environment,
    /// never on the command line (LocalAuthTokenEnvironment).
    nonisolated static func authArguments(mode: String) -> [String] {
        switch mode {
        case "none":
            ["--no-auth"]
        case "ssh":
            ["--enable-ssh-keys", "--disallow-user-password", "--allow-local-bypass"]
        case "both":
            ["--enable-ssh-keys", "--allow-local-bypass"]
        default:
            // OS authentication is the default, no special flags needed
            ["--allow-local-bypass"]
        }
    }

    static func wrapperScriptForTesting(command: String) -> String {
        self.wrapperScript(command: command, exitMessage: "exit")
    }

    private static func wrapperScript(command: String, exitMessage: String) -> String {
        let parentPid = ProcessInfo.processInfo.processIdentifier
        return """
        setopt NO_MONITOR 2>/dev/null
        SERVER_PID=
        untether_stop_group() {
            trap '' TERM INT HUP
            kill -s TERM -- -$$ 2>/dev/null
            # 2026-10-20: wait \(Self.wrapperStopPolls) x 0.3 s (> the server's 6 s graceful
            # shutdown) before SIGKILL; 4.5 s cut the server's cleanup short.
            _untether_i=0
            while [ $_untether_i -lt \(Self.wrapperStopPolls) ]; do
                [ -n "$SERVER_PID" ] && kill -0 $SERVER_PID 2>/dev/null || break
                sleep 0.3
                _untether_i=$((_untether_i + 1))
            done
            kill -s KILL -- -$$ 2>/dev/null
            exit $1
        }
        trap 'untether_stop_group 143' TERM INT HUP

        {
        \(command)
        } </dev/null &
        SERVER_PID=$!

        # Watch both the app and the server
        while kill -0 \(parentPid) 2>/dev/null && kill -0 $SERVER_PID 2>/dev/null; do
            sleep 1
        done

        if ! kill -0 $SERVER_PID 2>/dev/null; then
            wait $SERVER_PID
            EXIT_CODE=$?
            echo "\(exitMessage)" >&2
            # Don't leave children of the dead server holding the port
            trap '' TERM INT HUP
            kill -s TERM -- -$$ 2>/dev/null
            exit $EXIT_CODE
        fi

        echo "🛑 Untether is gone, stopping the server..." >&2
        untether_stop_group 0
        """
    }

    /// Spawns the wrapper in its own process group and starts reading its output.
    private func launch(
        wrapper: String,
        environment: [String: String],
        currentDirectory: String)
        throws -> ServerProcess
    {
        let process = try ServerProcess.spawn(
            executable: "/bin/zsh",
            arguments: ["-l", "-c", wrapper],
            environment: Self.launchEnvironment(environment, testHost: isRunningTests),
            currentDirectory: currentDirectory)
        self.serverProcess = process
        self.startOutputMonitoring(process)
        return process
    }

    /// The environment the server is launched with.
    ///
    /// 2026-11-10: a server started from the test host (the real debug app under xcodebuild
    /// test) would open the user's ~/.untether: its sessions, config and control socket. There
    /// it gets a HOME of its own; with the test host's port (appDefaults) it cannot meet the
    /// real install.
    nonisolated static func launchEnvironment(_ environment: [String: String], testHost: Bool) -> [String: String] {
        guard testHost else { return environment }
        var environment = environment
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("untether-test-home-\(ProcessInfo.processInfo.processIdentifier)")
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        environment["HOME"] = home.path
        return environment
    }

    /// Forget a launch whose wrapper already exited during startup.
    private func discardFailedLaunch() {
        // Let the readers drain what the dying server printed, then release them.
        self.scheduleOutputMonitoringShutdown()
        self.serverProcess = nil
    }

    /// Perform cleanup of all resources
    private func performCleanup() {
        self.stopOutputMonitoring()
        self.serverProcess = nil
    }

    private func startOutputMonitoring(_ process: ServerProcess) {
        self.stopOutputMonitoring()
        let queue = DispatchQueue(label: "com.nachx639.untether.server-output", qos: .utility)
        self.outputSources = [
            Self.makeOutputSource(handle: process.stdout, isStderr: false, queue: queue),
            Self.makeOutputSource(handle: process.stderr, isStderr: true, queue: queue),
        ]
    }

    private func stopOutputMonitoring() {
        self.outputSources.forEach { $0.cancel() }
        self.outputSources.removeAll()
    }

    /// After the server exits, readers normally hit EOF on their own. A descendant that
    /// escaped the process group could keep the pipe open forever, so cancel after a grace.
    private func scheduleOutputMonitoringShutdown() {
        let sources = self.outputSources
        self.outputSources.removeAll()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2) {
            sources.forEach { $0.cancel() }
        }
    }

    private nonisolated static func makeOutputSource(
        handle: FileHandle,
        isStderr: Bool,
        queue: DispatchQueue)
        -> DispatchSourceRead
    {
        let fd = handle.fileDescriptor
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        let logHandler = LogHandler(isStderr: isStderr)
        let buffer = OutputReadBuffer()

        source.setEventHandler { [weak source] in
            let bytesRead = Darwin.read(fd, buffer.pointer, OutputReadBuffer.size)
            if bytesRead > 0 {
                logHandler.ingest(Data(bytes: buffer.pointer, count: bytesRead))
            } else if bytesRead == 0 || (errno != EAGAIN && errno != EINTR) {
                // EOF (server exited) or a read error
                logHandler.flush()
                source?.cancel()
            }
        }
        source.setCancelHandler {
            logHandler.flush()
            try? handle.close()
            _ = buffer // keep the buffer alive until the source is gone
        }
        source.activate()
        return source
    }

    private func monitorProcessTermination(_ process: ServerProcess) {
        Task { [weak self] in
            let exitCode = await process.waitForExit()
            self?.handleTermination(of: process, exitCode: exitCode)
        }
    }

    private func handleTermination(of process: ServerProcess, exitCode: Int32) {
        // Ignore a process we already replaced or cleaned up
        guard self.serverProcess === process else { return }

        let devConfig = DevServerConfig.current()

        guard self.state == .running else {
            // Normal termination (stop() in progress)
            let serverType = devConfig.useDevServer ? "Development server" : "Production server"
            self.logger.info("\(serverType) terminated normally with exit code: \(exitCode)")
            return
        }

        // Unexpected termination
        self.state = .crashed
        let serverType = devConfig.useDevServer ? "Development server (pnpm run dev)" : "Production server"
        self.logger.error("\(serverType) terminated unexpectedly with exit code: \(exitCode)")

        if devConfig.useDevServer {
            self.serverOutput.error("🔴 Development server crashed (exit code: \(exitCode))")
            self.serverOutput.error("Check the output above for error details")
        }

        // Kill anything the wrapper left behind and release the readers
        process.signalGroup(SIGKILL)
        self.scheduleOutputMonitoringShutdown()
        self.serverProcess = nil

        // Notify about the crash
        if let onCrash = self.onCrash {
            self.logger.info("Notifying ServerManager about server crash")
            onCrash(exitCode)
        }
    }
}

// MARK: - Errors

enum BunServerError: LocalizedError, Equatable {
    case binaryNotFound
    case processFailedToStart
    case invalidPort
    case invalidState
    case devServerInvalid(String)

    var errorDescription: String? {
        switch self {
        case .binaryNotFound:
            String(localized: "The untether binary was not found in the app bundle", comment: "Error: starting the local server")
        case .processFailedToStart:
            String(localized: "The server process failed to start", comment: "Error: starting the local server")
        case .invalidPort:
            String(localized: "Server port is not configured", comment: "Error: starting the local server")
        case .invalidState:
            String(localized: "Server is in an invalid state for this operation", comment: "Error: starting the local server")
        case let .devServerInvalid(reason):
            String(localized: "Dev server configuration invalid: \(reason)", comment: "Error: starting the local server")
        }
    }
}

// MARK: - Output reading

/// Read buffer owned by one output source (only touched on that source's serial queue).
private final class OutputReadBuffer: @unchecked Sendable {
    static let size = 65536
    let pointer = UnsafeMutableRawPointer.allocate(byteCount: OutputReadBuffer.size, alignment: 1)

    deinit {
        self.pointer.deallocate()
    }
}

// MARK: - LogHandler

/// Splits one output stream of the server into lines and logs each at the level its
/// server log prefix declares (see `ServerLogClassifier`).
private final class LogHandler: @unchecked Sendable {
    private let serverOutput = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "ServerOutput")
    private let isStderr: Bool
    private let lock = NSLock()
    private var pending = Data()
    private var previousLevel: ServerLogLevel?

    private static let maxLineLength = 4096 // Max chars per log line to avoid os.log truncation

    init(isStderr: Bool) {
        self.isStderr = isStderr
    }

    func ingest(_ data: Data) {
        let lines: [String] = self.lock.withLock {
            self.pending.append(data)
            guard let lastNewline = self.pending.lastIndex(of: UInt8(ascii: "\n")) else {
                // No complete line yet; don't buffer unbounded output
                if self.pending.count > Self.maxLineLength * 4 {
                    defer { self.pending.removeAll() }
                    return [String(decoding: self.pending, as: UTF8.self)]
                }
                return []
            }
            let complete = self.pending[self.pending.startIndex...lastNewline]
            self.pending.removeSubrange(self.pending.startIndex...lastNewline)
            return String(decoding: complete, as: UTF8.self).components(separatedBy: "\n")
        }
        lines.forEach(self.log)
    }

    func flush() {
        let rest: String? = self.lock.withLock {
            guard !self.pending.isEmpty else { return nil }
            defer { self.pending.removeAll() }
            return String(decoding: self.pending, as: UTF8.self)
        }
        if let rest {
            rest.components(separatedBy: "\n").forEach(self.log)
        }
    }

    private func log(_ rawLine: String) {
        let trimmed = rawLine.trimmingCharacters(in: .newlines.union(CharacterSet(charactersIn: "\r")))
        guard !trimmed.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        // Skip shell initialization messages
        if trimmed.contains("zsh:") || trimmed.hasPrefix("Last login:") {
            return
        }

        let line = trimmed.contains("--local-auth-token") ? CommandLineRedactor.redact(trimmed) : trimmed
        let level = self.lock.withLock {
            let level = ServerLogClassifier.level(of: line, isStderr: self.isStderr, previous: self.previousLevel)
            self.previousLevel = level
            return level
        }

        guard line.count > Self.maxLineLength else {
            self.emit(line, level: level)
            return
        }

        // Chunk long lines to avoid os.log limits
        self.emit("[Large output: \(line.count) chars, chunking...]", level: level)
        var startIndex = line.startIndex
        var chunkNumber = 1
        while startIndex < line.endIndex {
            let endIndex = line.index(startIndex, offsetBy: Self.maxLineLength, limitedBy: line.endIndex) ?? line
                .endIndex
            self.emit("[Chunk \(chunkNumber)] \(line[startIndex..<endIndex])", level: level)
            startIndex = endIndex
            chunkNumber += 1
        }
    }

    private func emit(_ line: String, level: ServerLogLevel) {
        switch level {
        case .error:
            self.serverOutput.error("\(line, privacy: .public)")
        case .warning:
            self.serverOutput.warning("\(line, privacy: .public)")
        case .debug:
            self.serverOutput.debug("\(line, privacy: .public)")
        case .info:
            self.serverOutput.info("\(line, privacy: .public)")
        }
    }
}
