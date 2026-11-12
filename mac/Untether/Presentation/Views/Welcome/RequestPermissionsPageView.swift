import SwiftUI
import UserNotifications

/// Onboarding page for Automation, Accessibility and Notifications.
///
/// Permission state is re-read whenever it changes in System Settings, so rows flip to
/// "Granted" while the page is visible.
struct RequestPermissionsPageView: View {
    @Environment(SystemPermissionManager.self)
    private var permissionManager
    @State private var permissionUpdateTrigger = 0
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined

    private let notificationService = NotificationService.shared

    // IMPORTANT: These computed properties ensure the UI always shows current permission state.
    // The permissionUpdateTrigger dependency forces SwiftUI to re-evaluate them when
    // permissions change in System Settings while this view is visible.
    private var hasAppleScriptPermission: Bool {
        _ = self.permissionUpdateTrigger
        return self.permissionManager.hasPermission(.appleScript)
    }

    private var hasAccessibilityPermission: Bool {
        _ = self.permissionUpdateTrigger
        return self.permissionManager.hasPermission(.accessibility)
    }

    var body: some View {
        OnboardingPage(
            symbol: "hand.raised",
            title: "A Few Permissions",
            subtitle: "So Untether can open terminals for you and tell you when an agent needs you.")
        {
            VStack(spacing: DS.Spacing.m) {
                PermissionRow(
                    symbol: "applescript",
                    title: "Automation",
                    caption: "Open and control your terminal app.",
                    isGranted: self.hasAppleScriptPermission,
                    onGrant: { self.permissionManager.requestPermission(.appleScript) })

                Divider()

                PermissionRow(
                    symbol: "accessibility",
                    title: "Accessibility",
                    caption: "Type startup commands into new terminal windows.",
                    isGranted: self.hasAccessibilityPermission,
                    onGrant: { self.permissionManager.requestPermission(.accessibility) })

                Divider()

                PermissionRow(
                    symbol: "bell",
                    title: "Notifications",
                    caption: self.notificationStatus == .denied
                        ? "Turned off. Allow Untether in System Settings."
                        : "When an agent needs you, a session ends or a command fails.",
                    isGranted: self.notificationStatus == .authorized || self.notificationStatus == .provisional,
                    grantTitle: self.notificationStatus == .denied ? "Open Settings…" : "Allow…",
                    onGrant: self.requestNotifications)
            }
            .padding(DS.Spacing.l)
            .background(.fill.quaternary, in: .ds(DS.Radius.medium))
            // Grant/Allow are secondary: neutral, so the accent stays on Continue.
            .dsNeutralTint()

            Text("You can change these anytime in System Settings.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .task {
            // Check permissions before first render to avoid UI flashing
            await self.permissionManager.checkAllPermissions()
            if !isRunningPreviews() {
                self.notificationStatus = await self.notificationService.authorizationStatus()
            }
        }
        .onAppear {
            self.permissionManager.registerForMonitoring()
        }
        .onDisappear {
            self.permissionManager.unregisterFromMonitoring()
        }
        .onReceive(NotificationCenter.default.publisher(for: .permissionsUpdated)) { _ in
            self.permissionUpdateTrigger += 1
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            // Re-check notifications when returning from System Settings
            Task {
                self.notificationStatus = await self.notificationService.authorizationStatus()
            }
        }
    }

    private func requestNotifications() {
        if self.notificationStatus == .denied {
            self.notificationService.openNotificationSettings()
            return
        }
        Task {
            _ = try? await self.notificationService.requestAuthorization()
            self.notificationStatus = await self.notificationService.authorizationStatus()
        }
    }
}

// MARK: - Preview

#Preview("Request Permissions Page") {
    RequestPermissionsPageView()
        .frame(width: 640, height: 380)
        .environment(SystemPermissionManager.shared)
}
