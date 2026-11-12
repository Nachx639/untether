import AppKit
import os.log
import SwiftUI

/// General settings tab: app behavior, preferred apps, command line tool and permissions.
struct GeneralSettingsView: View {
    @AppStorage(AppConstants.UserDefaultsKeys.launchAtLogin, store: appDefaults)
    private var launchAtLogin = false
    @AppStorage(AppConstants.UserDefaultsKeys.showInDock, store: appDefaults)
    private var showInDock = AppConstants.Defaults.showInDock
    @AppStorage(AppConstants.UserDefaultsKeys.preventSleepWhenRunning, store: appDefaults)
    private var preventSleepWhenRunning = true
    @AppStorage(AppConstants.UserDefaultsKeys.debugMode, store: appDefaults)
    private var showDebugTab = false

    @Environment(SystemPermissionManager.self) private var permissionManager

    @State private var permissionUpdateTrigger = 0

    private let startupManager = StartupManager()

    // IMPORTANT: These computed properties ensure the UI always shows current permission state.
    // The permissionUpdateTrigger dependency forces SwiftUI to re-evaluate these properties
    // when permissions change in System Settings while this view is visible.
    private var hasAppleScriptPermission: Bool {
        _ = self.permissionUpdateTrigger
        return self.permissionManager.hasPermission(.appleScript)
    }

    private var hasAccessibilityPermission: Bool {
        _ = self.permissionUpdateTrigger
        return self.permissionManager.hasPermission(.accessibility)
    }

    var body: some View {
        Form {
            LanguageSettingsSection()

            Section("Application") {
                ToggleRow(
                    "Launch at Login",
                    caption: "Start Untether when you log in to your Mac.",
                    isOn: self.launchAtLoginBinding)
                ToggleRow(
                    "Show in Dock",
                    caption: "The Dock icon always shows while Settings is open.",
                    isOn: self.$showInDock)
                ToggleRow(
                    "Prevent Sleep While Running",
                    caption: "Keep your Mac awake while sessions are active.",
                    isOn: self.$preventSleepWhenRunning)
            }

            TerminalPreferenceSection()

            WindowHighlightSettingsSection()

            CLIInstallationSection()

            PermissionsSection(
                hasAppleScriptPermission: self.hasAppleScriptPermission,
                hasAccessibilityPermission: self.hasAccessibilityPermission,
                permissionManager: self.permissionManager)

            Section("Advanced") {
                ToggleRow(
                    "Show Debug Tab",
                    caption: "Logging, development server and reset tools.",
                    isOn: self.$showDebugTab)
            }
        }
        .formStyle(.grouped)
        .task {
            // Sync launch at login status
            self.launchAtLogin = self.startupManager.isLaunchAtLoginEnabled
            // Check permissions before first render to avoid UI flashing
            await self.permissionManager.checkAllPermissions()
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
    }

    private var launchAtLoginBinding: Binding<Bool> {
        Binding(
            get: { self.launchAtLogin },
            set: { newValue in
                self.launchAtLogin = newValue
                self.startupManager.setLaunchAtLogin(enabled: newValue)
            })
    }
}

#Preview {
    GeneralSettingsView()
        .environment(SystemPermissionManager.shared)
        .frame(width: 600, height: 680)
}
