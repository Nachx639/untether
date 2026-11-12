import Foundation
import Observation
import OSLog
import SwiftUI
import UserNotifications

/// Errors that can occur during server operations
enum ServerError: LocalizedError {
    case repeatedCrashes(count: Int)
    case portInUse(port: Int)
    case startupFailed(String)

    var errorDescription: String? {
        switch self {
        case .repeatedCrashes:
            String(localized: "Server keeps crashing", comment: "Error: starting the local server")
        case let .portInUse(port):
            String(localized: "Port \(port) is already in use", comment: "Error: starting the local server")
        case let .startupFailed(reason):
            String(localized: "Server startup failed: \(reason)", comment: "Error: starting the local server")
        }
    }

    var failureReason: String? {
        switch self {
        case let .repeatedCrashes(count):
            String(localized: "The server crashed \(count) times in a row", comment: "Error detail: starting the local server")
        case let .portInUse(port):
            String(localized: "Another process is using port \(port)", comment: "Error detail: starting the local server")
        case .startupFailed:
            nil
        }
    }

    var recoverySuggestion: String? {
        switch self {
        case .repeatedCrashes:
            String(localized: "Check the logs for errors or try a different port", comment: "Error suggestion: starting the local server")
        case .portInUse:
            String(localized: "Stop the other process or choose a different port", comment: "Error suggestion: starting the local server")
        case .startupFailed:
            String(localized: "Check the server configuration and try again", comment: "Error suggestion: starting the local server")
        }
    }
}

/// Manages the Untether server lifecycle.
///
/// `ServerManager` is the central coordinator for server lifecycle management in Untether.
/// It handles starting, stopping, and restarting the Go server, manages server configuration,
/// and provides logging capabilities.
@MainActor
@Observable
class ServerManager {
    static let shared = ServerManager()

    var port: String {
        get { appDefaults.string(forKey: UserDefaultsKeys.serverPort) ?? String(NetworkConstants.defaultPort)
        }
        set { appDefaults.set(newValue, forKey: UserDefaultsKeys.serverPort) }
    }

    /// The local authentication token for the current server instance
    var localAuthToken: String? {
        self.bunServer?.localToken
    }

    /// The current authentication mode of the server
    var authMode: String {
        self.bunServer?.authMode ?? "os"
    }

    var dashboardAccessMode: DashboardAccessMode {
        let rawValue = appDefaults.string(forKey: UserDefaultsKeys.dashboardAccessMode) ?? AppConstants
            .Defaults
            .dashboardAccessMode
        return DashboardAccessMode(rawValue: rawValue) ?? .network
    }

    var customBindAddress: String? {
        appDefaults.string(forKey: UserDefaultsKeys.customBindAddress)
    }

    var bindAddress: String {
        get {
            self.dashboardAccessMode.resolvedBindAddress(customAddress: self.customBindAddress).value
        }
        set {
            _ = self.updateBindConfiguration(address: newValue)
        }
    }

    @discardableResult
    func updateBindConfiguration(address: String) -> Bool {
        guard let bindAddress = ServerBindAddress(address) else {
            return false
        }

        let mode: DashboardAccessMode = switch bindAddress.value {
        case "127.0.0.1": .localhost
        case "0.0.0.0": .network
        default: .custom
        }

        return self.updateBindConfiguration(mode: mode, customAddress: bindAddress.value)
    }

    @discardableResult
    func updateBindConfiguration(mode: DashboardAccessMode, customAddress: String? = nil) -> Bool {
        if mode == .custom {
            guard let customAddress, let bindAddress = ServerBindAddress(customAddress) else {
                return false
            }
            appDefaults.set(bindAddress.value, forKey: UserDefaultsKeys.customBindAddress)
        }

        appDefaults.set(mode.rawValue, forKey: UserDefaultsKeys.dashboardAccessMode)
        self.logger.debug("Updated bind configuration: mode=\(mode.rawValue), address=\(self.bindAddress)")
        return true
    }

    /// The address the server really listens on: the configured one, after ServerNetworkPolicy.
    ///
    /// 2026-11-10: with sign-in "None" the server is started on 127.0.0.1 whatever the access
    /// mode says, but this app kept talking to the configured address. With a custom address
    /// every request and the health probe went to an address nobody listened on, so the
    /// watchdog declared the server dead, killed it and restarted it, forever. Everything that
    /// reaches or shows the server's address goes through here.
    nonisolated static func listeningAddress(
        mode: DashboardAccessMode,
        customAddress: String?,
        authMode: String,
        tailscaleServe: Bool)
        -> ServerBindAddress
    {
        let configured = mode.resolvedBindAddress(customAddress: customAddress)
        let policy = ServerNetworkPolicy.resolve(
            authMode: authMode,
            bindAddress: configured.value,
            tailscaleServe: tailscaleServe,
            tailscaleFunnel: false)
        return ServerBindAddress(policy.bindAddress) ?? configured
    }

    var listeningAddress: ServerBindAddress {
        Self.listeningAddress(
            mode: self.dashboardAccessMode,
            customAddress: self.customBindAddress,
            authMode: AuthConfig.current().mode,
            tailscaleServe: appDefaults.bool(forKey: AppConstants.UserDefaultsKeys.tailscaleServeEnabled))
    }

    var dashboardAddress: ServerBindAddress {
        let listening = self.listeningAddress
        if listening.value == "0.0.0.0",
           let localAddress = NetworkUtility.getLocalIPAddress().flatMap(ServerBindAddress.init)
        {
            return localAddress
        }

        return listening.connectableAddress
    }

    var dashboardEndpoint: String {
        self.dashboardAddress.endpoint(port: self.port)
    }

    func dashboardURL(endpoint: String = "/") -> URL? {
        self.dashboardAddress.url(port: self.port, endpoint: endpoint)
    }

    private var cleanupOnStartup: Bool {
        AppConstants.boolValue(for: AppConstants.UserDefaultsKeys.cleanupOnStartup)
    }

    /// 2026-10-20: the startup cleanup ran on every server start, crash and manual restarts
    /// included, deleting exited sessions (Resume Claude, task sessions) the user still needed.
    /// It now runs at most once per app launch, on the first server start.
    private var initialCleanupConsidered = false

    private(set) var bunServer: BunServer?
    private(set) var isRunning = false
    private(set) var isRestarting = false
    private(set) var lastError: Error?

    /// The process ID of the running server, if available
    var serverProcessId: Int32? {
        self.bunServer?.processIdentifier
    }

    /// Track if we're in the middle of handling a crash to prevent multiple restarts
    private var isHandlingCrash = false
    /// Consecutive crashes and restart backoff. Resets only after 5 minutes of passing health
    /// checks (2026-10-12: it used to reset on every start, so a crash loop never gave up).
    private var crashPolicy = ServerCrashPolicy()
    /// Bumped by stop() and app termination so in-flight crash recovery stands down
    private var lifecycleGeneration = 0
    /// The single in-flight start; concurrent start() calls await it instead of spawning a
    /// second server
    private var startTask: Task<Void, Never>?
    /// Retries a start that failed (port held, process didn't come up). Without it a failed
    /// first start left the menu on "Stopped" for good (2026-10-12: a crashed instance's dev
    /// server still held 4020 when the app relaunched).
    private var startRetryTask: Task<Void, Never>?
    private var startRetryAttempt = 0
    /// HTTP health bookkeeping for the current server (nil while no server runs)
    private var healthPolicy: ServerHealthWatchdogPolicy?
    private var healthMonitorTask: Task<Void, Never>?

    private let logger = Logger(subsystem: BundleIdentifiers.main, category: "ServerManager")
    private let powerManager = PowerManagementService.shared

    /// Health probe session: short timeouts, no caching, no shared connection state
    private let healthSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        configuration.timeoutIntervalForResource = 3
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    private init() {
        // Skip observer setup and monitoring during tests
        let isRunningInTests = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil ||
            ProcessInfo.processInfo.environment["XCTestBundlePath"] != nil ||
            ProcessInfo.processInfo.environment["XCTestSessionIdentifier"] != nil ||
            ProcessInfo.processInfo.arguments.contains("-XCTest") ||
            NSClassFromString("XCTestCase") != nil

        if !isRunningInTests {
            self.setupObservers()
            // Start health monitoring
            self.startHealthMonitoring()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private func setupObservers() {
        // Watch for UserDefaults changes (e.g., sleep prevention setting)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(self.userDefaultsDidChange),
            name: UserDefaults.didChangeNotification,
            object: nil)
    }

    @objc
    private nonisolated func userDefaultsDidChange() {
        Task { @MainActor in
            // Only update sleep prevention if server is running
            guard self.isRunning else { return }

            // UserDefaults posts this for every key: act only when this setting changed.
            let preventSleep = AppConstants.boolValue(for: AppConstants.UserDefaultsKeys.preventSleepWhenRunning)
            guard preventSleep != self.powerManager.isSleepPrevented else { return }
            self.powerManager.updateSleepPrevention(enabled: preventSleep, serverRunning: true)

            self.logger.info("Updated sleep prevention setting: \(preventSleep ? "enabled" : "disabled")")
        }
    }

    /// Start the server with current configuration.
    ///
    /// Concurrent callers share one in-flight start, so two servers can never be spawned.
    func start() async {
        if let startTask {
            await startTask.value
            return
        }
        let generation = self.lifecycleGeneration
        let task = Task { await self.performStart() }
        self.startTask = task
        await task.value
        if self.startTask == task {
            self.startTask = nil
        }
        // stop() bumps the generation: a start that raced a stop must not schedule retries.
        guard generation == self.lifecycleGeneration else { return }
        if self.isRunning {
            self.startRetryAttempt = 0
        } else if self.lastError != nil {
            self.scheduleStartRetry(generation: generation)
        }
    }

    /// Tries again after 5, 10, 20 and 40 s, then every minute, until a start succeeds or
    /// stop() is called.
    private func scheduleStartRetry(generation: Int) {
        let delays: [UInt64] = [5, 10, 20, 40]
        let delay = self.startRetryAttempt < delays.count ? delays[self.startRetryAttempt] : 60
        self.startRetryAttempt += 1
        let reason = self.lastError.map { String(describing: $0) } ?? "unknown"
        self.logger.notice("Server start failed (\(reason, privacy: .public)); retrying in \(delay)s")
        self.startRetryTask?.cancel()
        self.startRetryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled, generation == self.lifecycleGeneration, !self.isRunning
            else { return }
            await self.start()
        }
    }

    private func performStart() async {
        // 2026-10-20: with sign-in None no tunnel may stay up (one started before the switch
        // kept publishing the server); also covers settings changed outside the picker.
        await NoSignInTunnelGuard.enforceForCurrentSignIn()
        NoSignInPhoneAccessNotice.postIfNeeded(policy: ServerNetworkPolicy.current(bindAddress: self.bindAddress))

        // Check if we already have a running server
        if let existingServer = bunServer {
            let state = existingServer.getState()

            switch state {
            case .running:
                self.logger.info("Server already running on port \(existingServer.port)")
                // Ensure our state is synced
                self.isRunning = true
                self.lastError = nil
                // Start notification service if server is already running
                await NotificationService.shared.start()
                return
            case .starting:
                self.logger.info("Server is already starting")
                return
            case .stopping:
                self.logger.warning("Cannot start server while it's stopping")
                self.lastError = BunServerError.invalidState
                return
            case .crashed, .idle:
                // Clean up and proceed with start
                self.bunServer = nil
                self.isRunning = false
            }
        }

        // First check if port is truly available by trying to bind to it
        let portNumber = Int(self.port) ?? NetworkConstants.defaultPort

        let canBind = await PortConflictResolver.shared.canBindToPort(portNumber, bindAddress: self.listeningAddress.value)
        if !canBind {
            self.logger.warning("Cannot bind to port \(portNumber), checking for conflicts...")
        }

        // Check for port conflicts before starting
        if let conflict = await PortConflictResolver.shared.detectConflict(on: portNumber) {
            self.logger
                .warning("Port \(self.port) is in use by \(conflict.process.name) (PID: \(conflict.process.pid))")

            // Handle based on conflict type
            switch conflict.suggestedAction {
            case let .killOurInstance(pid, processName):
                self.logger.info("Attempting to kill conflicting process: \(processName) (PID: \(pid))")

                do {
                    try await PortConflictResolver.shared.resolveConflict(conflict)
                    // resolveConflict now includes exponential backoff
                } catch {
                    self.logger.error("Failed to resolve port conflict: \(error)")
                    self.lastError = PortConflictError.failedToKillProcess(pid: pid)
                    return
                }

            case let .reportExternalApp(appName):
                self.logger.error("Port \(self.port) is used by external app: \(appName)")
                self.lastError = ServerManagerError.portInUseByApp(
                    appName: appName,
                    port: Int(self.port) ?? NetworkConstants.defaultPort,
                    alternatives: conflict.alternativePorts)
                return

            case .suggestAlternativePort:
                // This shouldn't happen in our case
                self.logger.warning("Port conflict requires alternative port")
            }
        }

        do {
            let server = BunServer()
            server.port = self.port
            let currentBindAddress = self.bindAddress
            server.bindAddress = currentBindAddress
            self.logger.info("Starting server with port=\(self.port), bindAddress=\(currentBindAddress)")

            // Set up crash handler; ignore late reports from a server we already replaced
            server.onCrash = { [weak self, weak server] exitCode in
                Task { @MainActor in
                    guard let self, let server, self.bunServer === server else { return }
                    await self.handleServerCrash(exitCode: exitCode)
                }
            }

            try await server.start()

            self.bunServer = server
            // Check server state to ensure it's actually running
            if server.getState() == .running {
                // Update sleep prevention FIRST before updating state
                // This prevents a race condition where the server could crash after setting isRunning = true
                let preventSleep = AppConstants.boolValue(for: AppConstants.UserDefaultsKeys.preventSleepWhenRunning)
                self.powerManager.updateSleepPrevention(enabled: preventSleep, serverRunning: true)

                // Now update state. The crash counter is NOT reset here: only a server that
                // keeps passing health checks for 5 minutes counts as recovered.
                self.isRunning = true
                self.lastError = nil
                self.healthPolicy = ServerHealthWatchdogPolicy(
                    startedAt: Date(),
                    startupGrace: DevServerConfig.current().useDevServer ? 120 : 45)

                // The control socket lives in the server: connect now instead of waiting out
                // the reconnect backoff accumulated while the server was down
                SharedUnixSocketManager.shared.reconnectNow()

                // Start notification service
                await NotificationService.shared.start()
            } else {
                self.logger.error("Server started but not in running state")
                self.isRunning = false
                self.bunServer = nil
                self.lastError = BunServerError.processFailedToStart
                return
            }

            self.logger.info("Started server on port \(self.port)")

            // Initialize terminal control handler
            // The handler registers itself with SharedUnixSocketManager during init
            _ = TerminalControlHandler.shared

            // Note: SystemControlHandler is initialized in AppDelegate via
            // SharedUnixSocketManager.initializeSystemHandler()

            // Pass the local auth token to SessionMonitor
            SessionMonitor.shared.setLocalAuthToken(server.localToken)

            // Clean up old sessions once the server answers, only after the app's first server
            // start (never on crash or manual restarts). Not awaited: start() must return (and
            // crash handling must be able to run) while it waits.
            if !self.initialCleanupConsidered {
                self.initialCleanupConsidered = true
                Task { await self.triggerInitialCleanup(for: server) }
            }
        } catch {
            self.logger.error("Failed to start server: \(error.localizedDescription)")
            self.lastError = error

            // Always clean up on error
            self.isRunning = false
            self.bunServer = nil
        }
    }

    /// Stop the current server
    func stop() async {
        // Crash recovery in flight must not restart what we're stopping
        self.lifecycleGeneration += 1
        self.startRetryTask?.cancel()
        self.startRetryTask = nil
        self.startRetryAttempt = 0
        if let startTask {
            await startTask.value
        }

        // Reset crash tracking when manually stopped
        self.crashPolicy.reset()
        self.healthPolicy = nil

        guard let server = bunServer else {
            self.logger.warning("No server running")
            self.isRunning = false // Ensure state is synced
            return
        }

        self.logger.info("Stopping server")

        // Clear crash handler to prevent auto-restart
        server.onCrash = nil

        await server.stop()
        if self.bunServer === server {
            self.bunServer = nil
        }

        self.isRunning = false

        // Stop notification service connection when server stops
        NotificationService.shared.stop()

        // Clear the auth token from SessionMonitor
        SessionMonitor.shared.setLocalAuthToken(nil)

        // Allow sleep when server is stopped
        self.powerManager.updateSleepPrevention(enabled: false, serverRunning: false)
    }

    /// Kill the server synchronously while the app quits.
    ///
    /// 2026-10-12: applicationWillTerminate used to block on a semaphore waiting for the
    /// @MainActor stop(), which can never run while the main thread waits: the server was
    /// never stopped on quit. Signals need no actor hop.
    func terminateServerForAppExit() {
        self.lifecycleGeneration += 1
        self.healthPolicy = nil
        self.healthMonitorTask?.cancel()
        // 2026-10-20: 2 s cut the server's 6 s graceful shutdown short (stale Tailscale Serve
        // route, sessions not marked exited); wait the full stop window before SIGKILL.
        self.bunServer?.terminateSynchronously(grace: ServerProcess.gracefulStopSeconds)
    }

    /// Restart the current server
    func restart() async {
        // Set restarting flag to prevent UI from showing "stopped" state
        self.isRestarting = true
        defer { isRestarting = false }

        await self.stop()
        // 2026-10-20: a Stop pressed while this restart waited for the port was overridden
        // (the server came back up). stop() bumps the generation: if it moved, Stop wins.
        let generation = self.lifecycleGeneration

        // Wait with exponential backoff for port to be available
        let portNumber = Int(self.port) ?? NetworkConstants.defaultPort
        var retries = 0
        let maxRetries = 5

        while retries < maxRetries {
            guard generation == self.lifecycleGeneration else {
                self.logger.info("Restart cancelled: the server was stopped while waiting for the port")
                return
            }
            let delay = 1.0 * pow(2.0, Double(retries)) // 1, 2, 4, 8, 16 seconds
            self.logger
                .info("Waiting \(delay) seconds for port to be released (attempt \(retries + 1)/\(maxRetries))...")
            try? await Task.sleep(for: .seconds(delay))

            if await PortConflictResolver.shared.canBindToPort(portNumber, bindAddress: self.listeningAddress.value) {
                self.logger.info("Port \(portNumber) is now available")
                break
            }

            retries += 1
        }

        if retries == maxRetries {
            // 2026-10-20: this used to return here, leaving the server stopped after a manual
            // Restart. start() resolves port conflicts (frees our own stale server) and keeps
            // retrying with backoff.
            self.logger.error("Port \(portNumber) still unavailable after \(maxRetries) attempts; starting anyway")
        }

        guard Self.restartMayStart(generationAtStop: generation, current: self.lifecycleGeneration) else {
            self.logger.info("Restart cancelled: the server was stopped while waiting for the port")
            return
        }
        await self.start()
    }

    /// A restart starts the server again only if no stop() happened since its own stop.
    nonisolated static func restartMayStart(generationAtStop: Int, current: Int) -> Bool {
        generationAtStop == current
    }

    /// Trigger cleanup of exited sessions after server startup
    private func triggerInitialCleanup(for server: BunServer) async {
        // Check if cleanup on startup is enabled
        guard self.cleanupOnStartup else {
            self.logger.info("Cleanup on startup is disabled in settings")
            return
        }

        // Wait until the server answers its health endpoint (dev servers build first)
        var ready = false
        for _ in 0..<120 {
            guard self.bunServer === server else { return }
            if await self.probeHealthEndpoint() {
                ready = true
                break
            }
            try? await Task.sleep(for: .seconds(1))
        }
        guard ready, self.bunServer === server else {
            self.logger.warning("Skipping initial cleanup: server never became healthy")
            return
        }

        self.logger.info("Triggering initial cleanup of exited sessions")

        do {
            // Create authenticated request for cleanup
            var request = try makeRequest(endpoint: APIEndpoints.cleanupExited, method: "POST")
            request.timeoutInterval = 10

            // Make the cleanup request
            let (data, response) = try await URLSession.shared.data(for: request)

            if let httpResponse = response as? HTTPURLResponse {
                if httpResponse.statusCode == 200 {
                    // Parse the server response
                    if let jsonData = JSONValue.decodeObject(from: data),
                       let cleanedCount = jsonData["localCleaned"]?.int
                    {
                        self.logger.info("Initial cleanup completed: cleaned \(cleanedCount) exited sessions")
                    } else {
                        self.logger.info("Initial cleanup completed successfully")
                    }
                } else {
                    self.logger.warning("Initial cleanup returned status code: \(httpResponse.statusCode)")
                }
            }
        } catch {
            // Log the error but don't fail startup
            self.logger.warning("Failed to trigger initial cleanup: \(error.localizedDescription)")
        }
    }

    /// Manually trigger a server restart (for UI button)
    func manualRestart() async {
        await self.restart()
    }

    // MARK: - Server Management

    /// Handle server crash with automatic restart logic.
    ///
    /// Retries with exponential backoff, then (after the third consecutive crash) tells the
    /// user once and keeps retrying every 60 s instead of giving up forever. A restart that
    /// fails to start counts as another crash and is retried too.
    private func handleServerCrash(exitCode: Int32) async {
        // Special handling for exit code 9 (port in use)
        if exitCode == 9 {
            self.logger.error("Server failed to start: Port \(self.port) is already in use")
        } else {
            self.logger.error("Server crashed with exit code: \(exitCode)")
        }

        // Update state immediately
        self.isRunning = false
        self.bunServer = nil
        self.healthPolicy = nil

        // Allow sleep when server crashes
        self.powerManager.updateSleepPrevention(enabled: false, serverRunning: false)

        // Prevent multiple simultaneous crash handlers
        guard !self.isHandlingCrash else {
            self.logger.warning("Already handling a crash, skipping duplicate handler")
            return
        }

        self.isHandlingCrash = true
        defer { isHandlingCrash = false }

        let generation = self.lifecycleGeneration
        var lastExitCode = exitCode

        while true {
            let decision = self.crashPolicy.recordCrash()
            let crashes = self.crashPolicy.consecutiveCrashes

            if decision.isSlowRetry {
                self.lastError = ServerError.repeatedCrashes(count: crashes)
                if decision.notifyUser {
                    self.logger.error("Server crashed \(crashes) times in a row, retrying every \(decision.delay)s")
                    self.notifyRepeatedCrashes(count: crashes)
                }
            }

            // Exit code 9: something holds the port. Free it if it's ours.
            if lastExitCode == 9 {
                await self.resolvePortConflictAfterCrash()
            }

            self.logger.info("Will restart server after \(decision.delay) seconds (consecutive crash #\(crashes))")
            try? await Task.sleep(for: .seconds(decision.delay))

            // Only restart if nobody stopped or restarted the server in the meantime
            guard generation == self.lifecycleGeneration, self.bunServer == nil else {
                self.logger.info("Server was stopped or restarted during crash recovery, skipping auto-restart")
                return
            }

            // Restart with full port conflict detection
            self.logger.info("Auto-restarting server after crash...")
            await self.start()

            if self.isRunning || generation != self.lifecycleGeneration {
                return
            }

            self.logger.error("Auto-restart failed: \(self.lastError?.localizedDescription ?? "unknown error")")
            lastExitCode = self.lastError is ServerManagerError || self.lastError is PortConflictError ? 9 : -1
        }
    }

    private func resolvePortConflictAfterCrash() async {
        let portNumber = Int(self.port) ?? NetworkConstants.defaultPort
        self.logger.info("Port \(portNumber) is in use, checking for conflicts...")

        guard let conflict = await PortConflictResolver.shared.detectConflict(on: portNumber) else {
            self.logger.info("No listener on port \(portNumber) any more")
            return
        }
        self.logger.warning("Found port conflict: \(conflict.process.name) (PID: \(conflict.process.pid))")

        guard case let .killOurInstance(pid, processName) = conflict.suggestedAction else {
            self.logger.error("Cannot auto-resolve port conflict")
            return
        }
        self.logger.info("Attempting to kill conflicting process: \(processName) (PID: \(pid))")
        do {
            try await PortConflictResolver.shared.resolveConflict(conflict)
        } catch {
            self.logger.error("Failed to resolve port conflict: \(error)")
            self.lastError = PortConflictError.failedToKillProcess(pid: pid)
        }
    }

    /// Tell the user (once per crash streak) that the server keeps dying.
    private func notifyRepeatedCrashes(count: Int) {
        let content = UNMutableNotificationContent()
        content.title = String(localized: "Untether server keeps crashing", comment: "Notification title: the local server crashes repeatedly")
        content.body = String(
            localized: "It crashed \(count) times in a row. Untether keeps retrying every minute — see logs.",
            comment: "Notification body: the local server crashes repeatedly. Placeholder: number of crashes (plural)")
        content.sound = .default
        let request = UNNotificationRequest(identifier: "untether-server-repeated-crashes", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { [logger] error in
            if let error {
                logger.error("Failed to post crash notification: \(error.localizedDescription)")
            }
        }
    }

    /// Monitor server health periodically.
    ///
    /// 2026-10-12: health only checked that the wrapper process was alive, but in dev mode
    /// `tsx watch` stays alive after cli.ts throws, so a dead server went unnoticed for good.
    /// Now every 15 s the server must answer GET /api/health within 3 s; three consecutive
    /// failures (after the startup grace) kill its process group and run crash recovery.
    func startHealthMonitoring() {
        self.healthMonitorTask?.cancel()
        self.healthMonitorTask = Task { [weak self] in
            // Check initial state on app launch
            if let self, let server = self.bunServer, server.getState() == .running {
                let preventSleep = AppConstants.boolValue(for: AppConstants.UserDefaultsKeys.preventSleepWhenRunning)
                self.powerManager.updateSleepPrevention(enabled: preventSleep, serverRunning: true)
            }

            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                await self?.runHealthCheck()
            }
        }
    }

    private func runHealthCheck() async {
        guard let server = self.bunServer, !self.isHandlingCrash else { return }

        // The wrapper exited without the crash path noticing: sync state and recover
        let state = server.getState()
        let processAlive = await server.checkHealth()
        guard self.bunServer === server else { return }
        if !processAlive || state == .crashed {
            guard self.isRunning, state != .stopping else { return }
            self.logger.warning("Server process is gone but state shows running, syncing state")
            server.onCrash = nil
            await self.handleServerCrash(exitCode: -1)
            return
        }

        guard state == .running, var policy = self.healthPolicy else { return }

        let healthy = await self.probeHealthEndpoint()
        guard self.bunServer === server, self.healthPolicy != nil else { return }

        let verdict = policy.record(success: healthy)
        self.healthPolicy = policy

        switch verdict {
        case .healthy:
            if let healthySince = policy.healthySince {
                self.crashPolicy.recordHealthy(since: healthySince)
            }
        case .starting:
            self.logger.debug("Server not answering health checks yet (starting up)")
        case let .failing(consecutive):
            self.logger.warning("Server health check failed (\(consecutive)/\(policy.failureThreshold))")
        case .dead:
            self.logger.error("Server stopped answering health checks, killing it and restarting")
            server.onCrash = nil
            await server.stop()
            guard self.bunServer === server else { return }
            await self.handleServerCrash(exitCode: -1)
        }
    }

    /// GET /api/health on the local server (no auth required; 3 s timeout).
    private func probeHealthEndpoint() async -> Bool {
        guard let url = self.buildURL(endpoint: "/api/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        request.setValue(NetworkConstants.localhost, forHTTPHeaderField: NetworkConstants.hostHeader)
        if let token = self.bunServer?.localToken {
            request.setValue(token, forHTTPHeaderField: NetworkConstants.localAuthHeader)
        }
        do {
            let (_, response) = try await self.healthSession.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    // MARK: - Authentication

    /// Add authentication headers to a request
    func authenticate(request: inout URLRequest) throws {
        guard let server = bunServer else {
            throw ServerError.startupFailed(ErrorMessages.serverNotRunning)
        }
        request.setValue(server.localToken, forHTTPHeaderField: NetworkConstants.localAuthHeader)
    }

    // MARK: - Request Helpers

    /// Build a URL for the local server with the given endpoint
    func buildURL(endpoint: String) -> URL? {
        self.listeningAddress.connectableAddress.url(port: self.port, endpoint: endpoint)
    }

    /// Build a URL for the local server with the given endpoint and query parameters
    func buildURL(endpoint: String, queryItems: [URLQueryItem]?) -> URL? {
        guard let baseURL = buildURL(endpoint: endpoint) else { return nil }

        guard let queryItems, !queryItems.isEmpty else {
            return baseURL
        }

        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.queryItems = queryItems
        return components?.url
    }

    /// Create an authenticated JSON request
    func makeRequest(
        endpoint: String,
        method: String = "POST",
        body: Encodable? = nil,
        queryItems: [URLQueryItem]? = nil)
        throws -> URLRequest
    {
        let url: URL? = if let queryItems, !queryItems.isEmpty {
            self.buildURL(endpoint: endpoint, queryItems: queryItems)
        } else {
            self.buildURL(endpoint: endpoint)
        }

        guard let url else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(NetworkConstants.contentTypeJSON, forHTTPHeaderField: NetworkConstants.contentTypeHeader)
        request.setValue(NetworkConstants.localhost, forHTTPHeaderField: NetworkConstants.hostHeader)

        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }

        try self.authenticate(request: &request)

        return request
    }
}

// MARK: - Network Request Extension

extension ServerManager {
    /// Perform a network request with automatic JSON parsing and error handling
    /// - Parameters:
    ///   - endpoint: The API endpoint path
    ///   - method: HTTP method (default: "POST")
    ///   - body: Optional request body (Encodable)
    ///   - queryItems: Optional query parameters
    ///   - responseType: The expected response type (must be Decodable)
    /// - Returns: Decoded response of the specified type
    /// - Throws: NetworkError for various failure cases
    func performRequest<T: Decodable>(
        endpoint: String,
        method: String = "POST",
        body: Encodable? = nil,
        queryItems: [URLQueryItem]? = nil,
        responseType: T.Type)
        async throws -> T
    {
        let request = try makeRequest(
            endpoint: endpoint,
            method: method,
            body: body,
            queryItems: queryItems)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw NetworkError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let errorData = try? JSONDecoder().decode(ErrorResponse.self, from: data)
            throw NetworkError.serverError(
                statusCode: httpResponse.statusCode,
                message: errorData?.error ?? String(
                    localized: "Request failed with status \(httpResponse.statusCode)",
                    comment: "Error from the local server. Placeholder: HTTP status code"))
        }

        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Perform a network request that returns no body (void response)
    /// - Parameters:
    ///   - endpoint: The API endpoint path
    ///   - method: HTTP method (default: "POST")
    ///   - body: Optional request body (Encodable)
    ///   - queryItems: Optional query parameters
    /// - Throws: NetworkError for various failure cases
    func performVoidRequest(
        endpoint: String,
        method: String = "POST",
        body: Encodable? = nil,
        queryItems: [URLQueryItem]? = nil)
        async throws
    {
        let request = try makeRequest(
            endpoint: endpoint,
            method: method,
            body: body,
            queryItems: queryItems)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw NetworkError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let errorData = try? JSONDecoder().decode(ErrorResponse.self, from: data)
            throw NetworkError.serverError(
                statusCode: httpResponse.statusCode,
                message: errorData?.error ?? String(
                    localized: "Request failed with status \(httpResponse.statusCode)",
                    comment: "Error from the local server. Placeholder: HTTP status code"))
        }
    }
}

// MARK: - Server Manager Error

/// Errors specific to server management operations.
///
/// Handles error cases that occur during server startup and management,
/// particularly port conflicts with other applications.
enum ServerManagerError: LocalizedError {
    case portInUseByApp(appName: String, port: Int, alternatives: [Int])

    var errorDescription: String? {
        switch self {
        case let .portInUseByApp(appName, port, _):
            String(localized: "Port \(port) is in use by \(appName)", comment: "Error: starting the local server")
        }
    }

    var failureReason: String? {
        switch self {
        case .portInUseByApp:
            String(localized: "The port is being used by another application", comment: "Error detail: starting the local server")
        }
    }

    var recoverySuggestion: String? {
        switch self {
        case let .portInUseByApp(_, _, alternatives):
            let ports = alternatives.map(String.init).formatted(.list(type: .or))
            return String(localized: "Try one of these ports: \(ports)", comment: "Error suggestion: starting the local server. Placeholder: list of port numbers")
        }
    }

    var helpAnchor: String? {
        switch self {
        case .portInUseByApp:
            "port-conflict"
        }
    }
}
