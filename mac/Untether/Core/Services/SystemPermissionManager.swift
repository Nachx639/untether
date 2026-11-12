import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Observation
import OSLog

extension Notification.Name {
    static let permissionsUpdated = Notification.Name("com.nachx639.untether.permissionsUpdated")
}

enum AccessibilityPermissionProbe {
    private static let targetBundleIdentifiers = [
        "com.apple.finder",
        "com.apple.dock",
        "com.apple.systemuiserver",
    ]

    static func isGranted() -> Bool {
        let apiTrusted = AXIsProcessTrusted()
        guard apiTrusted else {
            return false
        }

        let crossProcessResults = self.targetBundleIdentifiers.compactMap { bundleIdentifier in
            NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first
        }.map { application in
            let element = AXUIElementCreateApplication(application.processIdentifier)
            var role: CFTypeRef?
            return AXUIElementCopyAttributeValue(
                element,
                kAXRoleAttribute as CFString,
                &role)
        }

        return self.evaluate(apiTrusted: apiTrusted, crossProcessResults: crossProcessResults)
    }

    static func evaluate(apiTrusted: Bool, crossProcessResults: [AXError]) -> Bool {
        apiTrusted && crossProcessResults.contains(.success)
    }

    static func shouldOpenSettings(promptReportedTrusted: Bool, probeGranted: Bool) -> Bool {
        !promptReportedTrusted || !probeGranted
    }
}

/// Types of system permissions that Untether requires.
///
/// Represents the various macOS system permissions needed for full functionality,
/// including automation and accessibility access.
enum SystemPermission {
    case appleScript
    case accessibility

    var displayName: String {
        switch self {
        case .appleScript:
            String(localized: "Automation", comment: "macOS permission name, as in System Settings > Privacy & Security")
        case .accessibility:
            String(localized: "Accessibility", comment: "macOS permission name, as in System Settings > Privacy & Security")
        }
    }

    var explanation: String {
        switch self {
        case .appleScript:
            String(localized: "Required to launch and control terminal applications", comment: "Why Untether needs the Automation permission")
        case .accessibility:
            String(localized: "Required to track and interact with terminal windows", comment: "Why Untether needs the Accessibility permission")
        }
    }

    private var settingsURLString: String {
        switch self {
        case .appleScript:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        case .accessibility:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
    }

    var settingsURL: URL? {
        URL(string: self.settingsURLString)
    }
}

/// Whether macOS lets Untether send Apple events to the apps it scripts.
///
/// 2026-11-11: the check ran `return "test"`, a script that targets no application and so
/// needs no permission: Automation was shown as granted to everybody, also after the user
/// had refused it. macOS answers the real question, per target application, with
/// AEDeterminePermissionToAutomateTarget; without asking the user (askUserIfNeeded false)
/// it only answers for a target that is running.
enum AutomationPermissionProbe {
    enum Status: Equatable {
        case granted
        case denied
        /// macOS would ask the user: nothing decided yet.
        case notDetermined
        /// The target is not running (or the answer is not one of the above): nothing known.
        case unknown
    }

    static let systemEvents = "com.apple.systemevents"

    /// errAEEventWouldRequireUserConsent, not exported to Swift by every SDK.
    private static let wouldRequireUserConsent: OSStatus = -1744

    static func status(of result: OSStatus) -> Status {
        switch result {
        case noErr: .granted
        case OSStatus(errAEEventNotPermitted): .denied
        case self.wouldRequireUserConsent: .notDetermined
        default: .unknown // procNotFound (-600): the target is not running
        }
    }

    /// Asks macOS about one application, without showing the consent dialog. Not on the main
    /// thread: the call waits for the system's answer.
    nonisolated static func status(forBundleIdentifier bundleIdentifier: String) -> Status {
        let target = NSAppleEventDescriptor(bundleIdentifier: bundleIdentifier)
        guard let descriptor = target.aeDesc else { return .unknown }
        return self.status(of: AEDeterminePermissionToAutomateTarget(descriptor, typeWildCard, typeWildCard, false))
    }

    /// The applications Untether scripts: the terminal it opens sessions in and, for every
    /// terminal but Apple's (the only one driven by its own scripting dictionary alone),
    /// System Events for the keystrokes (TerminalLauncher.unifiedAppleScript).
    static func targets(preferredTerminal: String?) -> [String] {
        let terminal = preferredTerminal.flatMap(Terminal.init(rawValue:)) ?? .terminal
        return terminal == .terminal ? [terminal.bundleIdentifier] : [terminal.bundleIdentifier, self.systemEvents]
    }

    /// One answer from the targets' answers: refused or undecided for any of them is "not
    /// granted"; granted for at least one and nothing against is "granted"; nil when no target
    /// could answer (none is running), for the caller to keep what it last knew.
    static func evaluate(_ statuses: [Status]) -> Bool? {
        if statuses.contains(.denied) || statuses.contains(.notDetermined) { return false }
        if statuses.contains(.granted) { return true }
        return nil
    }
}

/// Unified manager for all system permissions required by Untether.
///
/// Monitors and manages macOS system permissions including Apple Script automation
/// and accessibility access. Provides a centralized interface for
/// checking permission status and guiding users through the granting process.
@MainActor
@Observable
final class SystemPermissionManager {
    static let shared = SystemPermissionManager()

    /// Permission states
    private(set) var permissions: [SystemPermission: Bool] = [
        .appleScript: false,
        .accessibility: false,
    ]

    private let logger = Logger(
        subsystem: BundleIdentifiers.loggerSubsystem,
        category: "SystemPermissions")

    /// Timer for monitoring permission changes
    private var monitorTimer: Timer?

    /// Count of views that have registered for monitoring
    private var monitorRegistrationCount = 0

    /// Last time permissions were checked to avoid excessive checking
    private var lastPermissionCheck: Date?

    /// Minimum interval between permission checks (in seconds)
    private let minimumCheckInterval: TimeInterval = 0.5

    init() {
        // No automatic monitoring - UI components will register when visible
    }

    // MARK: - Public API

    /// Check if a specific permission is granted
    func hasPermission(_ permission: SystemPermission) -> Bool {
        self.permissions[permission] ?? false
    }

    /// Request a specific permission
    func requestPermission(_ permission: SystemPermission) {
        self.logger.info("Requesting \(permission.displayName) permission")

        switch permission {
        case .appleScript:
            self.requestAppleScriptPermission()
        case .accessibility:
            self.requestAccessibilityPermission()
        }
    }

    /// Force a permission recheck (useful when user manually changes settings)
    func forcePermissionRecheck() {
        self.logger.info("Force permission recheck requested")

        // Clear any cached values
        self.permissions[.accessibility] = false
        self.permissions[.appleScript] = false

        // Immediate check
        Task { @MainActor in
            await self.checkAllPermissions()

            // Double-check after a delay to catch any async updates
            try? await Task.sleep(for: .milliseconds(500))
            await self.checkAllPermissions()
        }
    }

    // MARK: - Permission Monitoring

    /// Register for permission monitoring (call when a view appears)
    func registerForMonitoring() {
        self.monitorRegistrationCount += 1
        self.logger.debug("Registered for monitoring, count: \(self.monitorRegistrationCount)")

        if self.monitorRegistrationCount == 1 {
            // First registration, start monitoring
            self.startMonitoring()
        }
    }

    /// Unregister from permission monitoring (call when a view disappears)
    func unregisterFromMonitoring() {
        self.monitorRegistrationCount = max(0, self.monitorRegistrationCount - 1)
        self.logger.debug("Unregistered from monitoring, count: \(self.monitorRegistrationCount)")

        if self.monitorRegistrationCount == 0 {
            // No more registrations, stop monitoring
            self.stopMonitoring()
        }
    }

    private func startMonitoring() {
        self.logger.info("Starting permission monitoring (registration count: \(self.monitorRegistrationCount))")

        // Initial check
        Task {
            await self.checkAllPermissions()
        }

        // Start timer for periodic checks
        self.monitorTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.checkAllPermissions()
            }
        }

        self.logger.debug("Permission monitoring timer created: \(String(describing: self.monitorTimer))")
    }

    private func stopMonitoring() {
        self.logger.info("Stopping permission monitoring (registration count: \(self.monitorRegistrationCount))")
        self.monitorTimer?.invalidate()
        self.monitorTimer = nil
        // Clear the last check time to ensure immediate check on next start
        self.lastPermissionCheck = nil
    }

    // MARK: - Permission Checking

    func checkAllPermissions() async {
        // Avoid checking too frequently
        if let lastCheck = lastPermissionCheck,
           Date().timeIntervalSince(lastCheck) < minimumCheckInterval
        {
            return
        }

        self.lastPermissionCheck = Date()
        let oldPermissions = self.permissions

        // Check each permission type
        self.permissions[.appleScript] = await self.checkAppleScriptPermission()
        self.permissions[.accessibility] = self.checkAccessibilityPermission()

        // Post notification if any permissions changed
        if oldPermissions != self.permissions {
            NotificationCenter.default.post(name: .permissionsUpdated, object: nil)
        }
    }

    // MARK: - AppleScript Permission

    private func checkAppleScriptPermission() async -> Bool {
        let targets = AutomationPermissionProbe.targets(
            preferredTerminal: appDefaults.string(forKey: AppConstants.UserDefaultsKeys.preferredTerminal))
        let statuses = await Task.detached(priority: .utility) {
            targets.map(AutomationPermissionProbe.status(forBundleIdentifier:))
        }.value

        if let granted = AutomationPermissionProbe.evaluate(statuses) {
            if granted != self.lastKnownAutomationPermission {
                self.logger.info("Automation permission: \(granted ? "granted" : "not granted", privacy: .public)")
            }
            self.lastKnownAutomationPermission = granted
            return granted
        }
        // No target is running, so macOS has no answer now: what it last said stands.
        return self.lastKnownAutomationPermission ?? false
    }

    /// The last answer macOS gave, kept across launches for when no target is running.
    private var lastKnownAutomationPermission: Bool? {
        get { appDefaults.object(forKey: Self.lastKnownAutomationKey) as? Bool }
        set { appDefaults.set(newValue, forKey: Self.lastKnownAutomationKey) }
    }

    private static let lastKnownAutomationKey = "automationPermissionLastKnown"

    private func requestAppleScriptPermission() {
        Task {
            // The consent dialog of each application Untether scripts (the same ones
            // checkAppleScriptPermission asks macOS about).
            let targets = AutomationPermissionProbe.targets(
                preferredTerminal: appDefaults.string(forKey: AppConstants.UserDefaultsKeys.preferredTerminal))
            for bundleIdentifier in targets {
                let triggerScript = "tell application id \"\(bundleIdentifier)\" to get name"
                do {
                    _ = try await AppleScriptExecutor.shared.executeAsync(triggerScript, timeout: 15.0)
                } catch {
                    self.logger.info("AppleScript permission dialog triggered")
                }
            }

            // Open System Settings after a delay
            try? await Task.sleep(for: .milliseconds(500))
            self.openSystemSettings(for: .appleScript)
        }
    }

    // MARK: - Accessibility Permission

    private func checkAccessibilityPermission() -> Bool {
        let hasAccess = AccessibilityPermissionProbe.isGranted()
        self.logger.debug("Accessibility permission probe returned: \(hasAccess)")
        return hasAccess
    }

    private func requestAccessibilityPermission() {
        // Trigger the system dialog
        let options: NSDictionary = ["AXTrustedCheckOptionPrompt": true]
        let promptReportedTrusted = AXIsProcessTrustedWithOptions(options)
        let probeGranted = AccessibilityPermissionProbe.isGranted()

        if !AccessibilityPermissionProbe.shouldOpenSettings(
            promptReportedTrusted: promptReportedTrusted,
            probeGranted: probeGranted)
        {
            self.logger.info("Accessibility permission already granted")
        } else {
            if promptReportedTrusted {
                self.logger.info("Accessibility permission requires recovery in System Settings")
            } else {
                self.logger.info("Accessibility permission dialog triggered")
            }

            // Also open System Settings as a fallback
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.openSystemSettings(for: .accessibility)
            }
        }
    }

    // MARK: - Utilities

    private func openSystemSettings(for permission: SystemPermission) {
        if let url = permission.settingsURL {
            NSWorkspace.shared.open(url)
        }
    }
}
