import AppKit
import os.log
import SwiftUI
import UserNotifications

/// Main entry point for the Untether macOS application.
///
/// Manages the app's lifecycle and window hierarchy including the menu bar interface,
/// settings window, welcome screen, and session detail views. Coordinates shared services
/// across all windows and handles deep linking for terminal session URLs.
///
/// This application runs on macOS 14.0+ and requires Swift 6.
/// The app provides terminal access through web browsers.
@main
struct UntetherApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self)
    var appDelegate
    @State var sessionMonitor = SessionMonitor.shared
    @State var serverManager = ServerManager.shared
    @State var ngrokService = NgrokService.shared
    @State var tailscaleService = TailscaleService.shared
    @State var cloudflareService = CloudflareService.shared
    @State var pinggyService = PinggyService.shared
    @State var pangolinService = PangolinService.shared
    @State var permissionManager = SystemPermissionManager.shared
    @State var terminalLauncher = TerminalLauncher.shared
    @State var gitRepositoryMonitor = GitRepositoryMonitor()
    @State var sessionService: SessionService?
    @State var worktreeService = WorktreeService(serverManager: ServerManager.shared)
    @State var configManager = ConfigManager.shared
    @State var notificationService = NotificationService.shared
    @State var tailscaleServeStatusService = TailscaleServeStatusService.shared

    init() {
        // Connect the app delegate to this app instance
        _appDelegate.wrappedValue.app = self
    }

    var body: some Scene {
        // Hidden WindowGroup to make Settings work in MenuBarExtra-only apps
        // This is a workaround for FB10184971
        WindowGroup(Text(verbatim: "HiddenWindow")) {
            HiddenWindowView()
        }
        .windowResizability(.contentSize)
        .defaultSize(width: 1, height: 1)
        .windowStyle(.hiddenTitleBar)

        // Welcome Window
        WindowGroup(Text("Welcome", comment: "Window title: onboarding window"), id: "welcome") {
            WelcomeView()
                .environment(self.sessionMonitor)
                .environment(self.serverManager)
                .environment(self.ngrokService)
                .environment(self.tailscaleService)
                .environment(self.cloudflareService)
                .environment(self.pinggyService)
                .environment(self.pangolinService)
                .environment(self.permissionManager)
                .environment(self.terminalLauncher)
                .environment(self.gitRepositoryMonitor)
                .environment(self.configManager)
                .environment(self.worktreeService)
                .environment(self.notificationService)
        }
        .windowResizability(.contentSize)
        .defaultSize(width: 580, height: 480)
        .windowStyle(.hiddenTitleBar)

        // Session Detail Window
        WindowGroup(
            Text("Session Details", comment: "Window title: details of one session"),
            id: "session-detail",
            for: String.self)
        { $sessionId in
            if let sessionId,
               let session = sessionMonitor.sessions[sessionId]
            {
                SessionDetailView(session: session)
                    .environment(self.sessionMonitor)
                    .environment(self.serverManager)
                    .environment(self.ngrokService)
                    .environment(self.tailscaleService)
                    .environment(self.cloudflareService)
                    .environment(self.pinggyService)
                    .environment(self.pangolinService)
                    .environment(self.permissionManager)
                    .environment(self.terminalLauncher)
                    .environment(self.gitRepositoryMonitor)
                        .environment(self.configManager)
                    .environment(self.sessionService ?? SessionService(
                        serverManager: self.serverManager,
                        sessionMonitor: self.sessionMonitor))
                    .environment(self.worktreeService)
                    .environment(self.notificationService)
            } else {
                SessionEndedView()
            }
        }
        .windowResizability(.contentSize)

        // New Session is now integrated into the popover

        Settings {
            SettingsView()
                .environment(self.sessionMonitor)
                .environment(self.serverManager)
                .environment(self.ngrokService)
                .environment(self.tailscaleService)
                .environment(self.cloudflareService)
                .environment(self.pinggyService)
                .environment(self.pangolinService)
                .environment(self.permissionManager)
                .environment(self.terminalLauncher)
                .environment(self.gitRepositoryMonitor)
                .environment(self.configManager)
                .environment(self.sessionService ?? SessionService(
                    serverManager: self.serverManager,
                    sessionMonitor: self.sessionMonitor))
                .environment(self.worktreeService)
                .environment(self.notificationService)
                .environment(self.tailscaleServeStatusService)
        }
        .commands {
            CommandGroup(after: .appInfo) {
                Button(String(localized: "About Untether", comment: "App menu item: opens the About tab")) {
                    SettingsOpener.openSettings()
                    // Navigate to About tab after settings opens
                    Task {
                        try? await Task.sleep(for: .milliseconds(100))
                        NotificationCenter.default.post(
                            name: .openSettingsTab,
                            object: SettingsTab.about)
                    }
                }
            }
        }
    }
}

// MARK: - App Delegate

/// Manages app lifecycle, single instance enforcement, and core services.
///
/// Handles application-level responsibilities including server lifecycle management,
/// status bar setup, single instance enforcement via distributed notifications,
/// URL scheme handling, and user notification management. Acts as the central
/// coordinator for application-wide events and services.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    // Needed for menu item highlight hack
    weak static var shared: AppDelegate?
    override init() {
        super.init()
        Self.shared = self
    }

    var app: UntetherApp?
    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "AppDelegate")
    private(set) var statusBarController: StatusBarController?
    private let notificationService = NotificationService.shared

    /// Other Untether instances killed at launch; the server start waits for them to exit
    private var killedInstancePIDs: [pid_t] = []

    /// Distributed notification name used to ask an existing instance to show the Settings window.
    private static let showSettingsNotification = Notification.Name.showSettings

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Language change relaunch: let the previous instance stop its server and quit
        // before this one kills "other instances" or checks for a running copy.
        AppLanguage.waitForRelaunchParent()
        _ = AppLanguage.launchLanguage
        AppLanguage.syncLayoutDirectionAtLaunch()

        let processInfo = ProcessInfo.processInfo
        let isRunningInTests = processInfo.environment["XCTestConfigurationFilePath"] != nil ||
            processInfo.environment["XCTestBundlePath"] != nil ||
            processInfo.environment["XCTestSessionIdentifier"] != nil ||
            processInfo.arguments.contains("-XCTest") ||
            NSClassFromString("XCTestCase") != nil
        let isRunningInPreview = processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1"
        #if DEBUG
        let isRunningInDebug = true
        #else
        let isRunningInDebug = processInfo.environment["DYLD_INSERT_LIBRARIES"]?
            .contains("libMainThreadChecker.dylib") ?? false ||
            processInfo.environment["__XCODE_BUILT_PRODUCTS_DIR_PATHS"] != nil
        #endif

        // Kill other Untether instances FIRST, before any other initialization
        // This ensures only the newest instance survives and prevents Unix socket conflicts
        if !isRunningInTests, !isRunningInPreview {
            self.killedInstancePIDs = ProcessKiller.killOtherInstances()
        }

        // Handle single instance check before doing anything else
        #if DEBUG
        // Skip single instance check in debug builds
        #else
        if !isRunningInPreview, !isRunningInTests, !isRunningInDebug {
            self.handleSingleInstanceCheck()
            self.registerForDistributedNotifications()

            // Check if app needs to be moved to Applications folder
            let applicationMover = ApplicationMover()
            applicationMover.checkAndOfferToMoveToApplications()
        }
        #endif

        // Register default values
        appDefaults.register(defaults: [
            AppConstants.UserDefaultsKeys.showInDock: AppConstants.Defaults.showInDock,
            "dashboardAccessMode": AppConstants.Defaults.dashboardAccessMode,
        ])

        // Initialize dock icon visibility through DockIconManager
        DockIconManager.shared.updateDockVisibility()

        // Check CLI installation status
        let cliInstaller = CLIInstaller()
        cliInstaller.checkInstallationStatus()

        // Show welcome screen when version changes OR when ut script is outdated
        let storedWelcomeVersion = appDefaults.integer(forKey: AppConstants.UserDefaultsKeys.welcomeVersion)

        // Small delay to allow CLI check to complete
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            // Show welcome if version is different from current OR if ut script is outdated
            if storedWelcomeVersion < AppConstants.currentWelcomeVersion || cliInstaller.isOutdated,
               !isRunningInTests, !isRunningInPreview
            {
                self?.showWelcomeScreen(
                    mode: WelcomePresentationMode.automatic(storedWelcomeVersion: storedWelcomeVersion))
            }
        }

        // Skip all service initialization during tests
        if isRunningInTests {
            self.logger.info("Running in test mode - skipping service initialization")
            return
        }

        // Verify preferred terminal is still available
        app?.terminalLauncher.verifyPreferredTerminal()

        // Initialize SessionService
        if let serverManager = app?.serverManager, let sessionMonitor = app?.sessionMonitor {
            app?.sessionService = SessionService(serverManager: serverManager, sessionMonitor: sessionMonitor)
        }

        // Start the terminal control handler (registers its handler)
        TerminalControlHandler.shared.start()

        // Initialize system control handler with ready callback
        SharedUnixSocketManager.shared.initializeSystemHandler {
            self.logger.info("🎉 System ready event received from server")
            // Could add any system-ready handling here if needed
        }

        // Start the shared unix socket manager after all handlers are registered
        SharedUnixSocketManager.shared.connect()

        // Start Git monitoring early
        app?.gitRepositoryMonitor.startMonitoring()

        // Initialize status bar controller IMMEDIATELY to show menu bar icon
        guard let app else {
            fatalError("UntetherApp instance not connected to AppDelegate")
        }

        // Connect GitRepositoryMonitor to SessionMonitor for pre-caching
        app.sessionMonitor.gitRepositoryMonitor = app.gitRepositoryMonitor

        self.statusBarController = StatusBarController(
            sessionMonitor: app.sessionMonitor,
            serverManager: app.serverManager,
            ngrokService: app.ngrokService,
            tailscaleService: app.tailscaleService,
            terminalLauncher: app.terminalLauncher,
            gitRepositoryMonitor: app.gitRepositoryMonitor,
            configManager: app.configManager,
            worktreeService: app.worktreeService)

        // Initialize and start HTTP server using ServerManager
        Task {
            let serverManager = app.serverManager
            if !self.killedInstancePIDs.isEmpty {
                // Give killed instances (and the servers their wrappers tear down) time to
                // release the port before we check it
                await ProcessKiller.waitForExit(self.killedInstancePIDs, timeout: .seconds(1))
                let port = Int(serverManager.port) ?? NetworkConstants.defaultPort
                for _ in 0..<30 {
                    if await PortConflictResolver.shared.canBindToPort(port, bindAddress: serverManager.bindAddress) {
                        break
                    }
                    try? await Task.sleep(for: .milliseconds(200))
                }
                self.killedInstancePIDs = []
            }
            self.logger.info("Attempting to start HTTP server using ServerManager...")
            await serverManager.start()

            // Check if server actually started
            if serverManager.isRunning {
                self.logger.info("HTTP server started successfully on port \(serverManager.port)")

                // Update status bar icon to reflect server running state
                self.statusBarController?.updateStatusItemDisplay()

                // Session monitoring starts automatically

                // NotificationService is started by ServerManager when the server is ready
            } else {
                self.logger.error("HTTP server failed to start")
                if let error = serverManager.lastError {
                    self.logger.error("Server start error: \(error.localizedDescription)")
                }
            }
        }
    }

    private func handleSingleInstanceCheck() {
        // Extra safety check - should never be called during tests
        let processInfo = ProcessInfo.processInfo
        let isRunningInTests = processInfo.environment["XCTestConfigurationFilePath"] != nil ||
            processInfo.environment["XCTestBundlePath"] != nil ||
            processInfo.environment["XCTestSessionIdentifier"] != nil ||
            processInfo.arguments.contains("-XCTest") ||
            NSClassFromString("XCTestCase") != nil

        if isRunningInTests {
            self.logger.info("Skipping single instance check - running in tests")
            return
        }

        // A language-change relaunch may briefly overlap the instance it replaces.
        let replacedPID = AppLanguage.relaunchParentPID()
        let runningApps = NSRunningApplication
            .runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != replacedPID }

        if runningApps.count > 1 {
            // Send notification to existing instance to show settings
            DistributedNotificationCenter.default().post(name: Self.showSettingsNotification, object: nil)

            // Show alert that another instance is running
            Task { @MainActor in
                let alert = NSAlert()
                alert.messageText = String(
                    localized: "Untether is already running",
                    comment: "Alert title: a second copy of the app was opened")
                alert.informativeText = String(
                    localized: "Another instance of Untether is already running. This instance will now quit.",
                    comment: "Alert message: a second copy of the app was opened")
                alert.alertStyle = .informational
                alert.addButton(withTitle: UIStrings.ok)
                alert.runModal()

                // Terminate this instance
                NSApp.terminate(nil)
            }
            return
        }
    }

    private func registerForDistributedNotifications() {
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(self.handleShowSettingsNotification),
            name: Self.showSettingsNotification,
            object: nil)
    }

    /// Shows the Settings window when another Untether instance asks us to.
    @objc
    private func handleShowSettingsNotification(_ notification: Notification) {
        SettingsOpener.openSettings()
    }

    /// Shows the welcome screen
    private func showWelcomeScreen(mode: WelcomePresentationMode) {
        // Initialize the welcome window controller (singleton will handle the rest)
        _ = WelcomeWindowController.shared
        WelcomeWindowController.shared.show(mode: mode)
    }

    /// Public method to show welcome screen (can be called from settings)
    static func showWelcomeScreen() {
        WelcomeWindowController.shared.show(mode: .full)
    }

    /// Creates a custom dock menu when the user right-clicks on the dock icon.
    ///
    /// IMPORTANT: Due to a known SwiftUI bug with NSApplicationDelegateAdaptor, this method
    /// is NOT called when running the app from Xcode. However, it DOES work correctly when:
    /// - The app is launched manually from Finder
    /// - The app is launched from a built/archived version
    /// - The app is running in production
    ///
    /// This is a debugging limitation only and does not affect end users.
    /// See: https://github.com/feedback-assistant/reports/issues/246
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let dockMenu = NSMenu()

        // Dashboard menu item
        let dashboardItem = NSMenuItem(
            title: String(localized: "Open Dashboard", comment: "Dock menu item: opens the web dashboard"),
            action: #selector(openDashboard),
            keyEquivalent: "")
        dashboardItem.target = self
        dockMenu.addItem(dashboardItem)

        // Settings menu item
        let settingsItem = NSMenuItem(
            title: String(localized: "Settings…", comment: "Dock menu item: opens Settings"),
            action: #selector(openSettings),
            keyEquivalent: "")
        settingsItem.target = self
        dockMenu.addItem(settingsItem)

        return dockMenu
    }

    @objc
    private func openDashboard() {
        // Same URL as the menu: it follows the bind address, localhost is not always it.
        if let serverManager = app?.serverManager,
           let url = DashboardURLBuilder.dashboardURL(port: serverManager.port)
        {
            NSWorkspace.shared.open(url)
        }
    }

    @objc
    private func openSettings() {
        SettingsOpener.openSettings()
    }

    func applicationWillTerminate(_ notification: Notification) {
        self.logger.info("🚨 applicationWillTerminate called - starting cleanup process")

        let processInfo = ProcessInfo.processInfo
        let isRunningInTests = processInfo.environment["XCTestConfigurationFilePath"] != nil ||
            processInfo.environment["XCTestBundlePath"] != nil ||
            processInfo.environment["XCTestSessionIdentifier"] != nil ||
            processInfo.arguments.contains("-XCTest") ||
            NSClassFromString("XCTestCase") != nil

        // Skip cleanup during tests
        if isRunningInTests {
            self.logger.info("Running in test mode - skipping termination cleanup")
            return
        }

        // Ultra-fast cleanup for cloudflared - just send signals and exit
        if let cloudflareService = app?.cloudflareService, cloudflareService.isRunning {
            self.logger.info("🔥 Sending quick termination signal to Cloudflare")
            cloudflareService.sendTerminationSignal()
        }

        if NgrokService.shared.hasProcess {
            self.logger.info("Sending quick termination signal to ngrok")
            NgrokService.shared.sendTerminationSignal()
        }

        if let pinggyService = app?.pinggyService, pinggyService.isRunning {
            self.logger.info("Sending quick termination signal to Pinggy")
            pinggyService.sendTerminationSignal()
        }

        if let pangolinService = app?.pangolinService, pangolinService.isRunning {
            self.logger.info("Sending quick termination signal to Pangolin Newt")
            pangolinService.sendTerminationSignal()
        }

        // Kill the server's whole process group synchronously (SIGTERM, up to 8 s, SIGKILL).
        // 2026-10-12: this used to wait on a semaphore for the @MainActor stop(), which can't
        // run while the main thread is blocked here, so quitting never stopped the server.
        app?.serverManager.terminateServerForAppExit()

        // Remove observers (quick operations)
        #if !DEBUG
        if !isRunningInTests {
            DistributedNotificationCenter.default().removeObserver(
                self,
                name: Self.showSettingsNotification,
                object: nil)
        }
        #endif

        self.logger.info("🚨 applicationWillTerminate completed quickly")
    }
}
