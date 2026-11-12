import AppKit
import os.log
import SwiftUI

private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "NotificationSettings")

/// Settings view for managing notification preferences
struct NotificationSettingsView: View {
    @Environment(ConfigManager.self) private var configManager
    @Environment(NotificationService.self) private var notificationService

    @State private var isTestingNotification = false
    @State private var showingPermissionAlert = false
    @State private var eventStreamConnectionStatus = false

    private func updateNotificationPreferences() {
        // Load current preferences from ConfigManager and notify the service
        let prefs = NotificationService.NotificationPreferences(fromConfig: self.configManager)
        self.notificationService.updatePreferences(prefs)
    }

    /// The master switch. config.json is its one home (the server reads it there too).
    ///
    /// 2026-11-10: it lived twice, in the app's preferences and in config.json. Flipping it
    /// changed memory but was not saved until another switch was touched, so "off" came back
    /// on at the next launch; and opening this tab copied one store into the other, which ran
    /// the switch's action: a test notification or the permission alert just for looking.
    private var notificationsEnabled: Binding<Bool> {
        Binding(
            get: { self.configManager.notificationsEnabled },
            set: { newValue in
                guard newValue != self.configManager.notificationsEnabled else { return }
                self.applyNotificationsEnabled(newValue)
            })
    }

    var body: some View {
        @Bindable var bindableConfig = self.configManager

        Form {
            Section {
                ToggleRow(
                    "Session Notifications",
                    caption: "Native macOS notifications for session and command events.",
                    isOn: self.notificationsEnabled)

                if self.configManager.notificationsEnabled {
                    SettingRow(
                        "Live Updates",
                        caption: self.eventStreamConnectionStatus
                            ? "Untether hears about sessions as they happen."
                            : "Notifications are paused until the server reconnects.")
                    {
                        StatusBadge(
                            self.eventStreamConnectionStatus ? "Connected" : "Disconnected",
                            kind: self.eventStreamConnectionStatus ? .ok : .warning)
                    }
                    .help(
                        self.eventStreamConnectionStatus
                            ? "The live update stream from the server is connected"
                            : "The live update stream is disconnected. Check that the server is running.")
                }
            } header: {
                Text("General", comment: "Settings, Notifications: section header")
            }

            if self.configManager.notificationsEnabled {
                Section("Notify Me When") {
                    self.typeToggle(
                        "A Session Starts",
                        caption: "Useful when a terminal is shared.",
                        isOn: $bindableConfig.notificationSessionStart)
                    self.typeToggle(
                        "A Session Ends",
                        caption: "Includes the exit code when a session crashes.",
                        isOn: $bindableConfig.notificationSessionExit)
                    self.typeToggle(
                        "A Command Fails",
                        caption: "Commands that exit with a non-zero code.",
                        isOn: $bindableConfig.notificationCommandError)
                    self.typeToggle(
                        "A Long Command Finishes",
                        caption: "Commands that ran longer than 3 seconds, like builds and tests.",
                        isOn: $bindableConfig.notificationCommandCompletion)
                    self.typeToggle(
                        "The Terminal Bell Rings",
                        caption: "Bell (^G) from vim, IRC mentions and completion sounds.",
                        isOn: $bindableConfig.notificationBell)
                }

                Section("Behavior") {
                    self.typeToggle("Play Sound", caption: nil, isOn: $bindableConfig.notificationSoundEnabled)
                }

                Section("Test") {
                    SettingRow("Send a Test Notification") {
                        HStack(spacing: DS.Spacing.s) {
                            if self.isTestingNotification {
                                ProgressView()
                                    .controlSize(.small)
                            }
                            Button("Send") {
                                Task { @MainActor in
                                    self.isTestingNotification = true
                                    // Use server test notification to verify the full flow
                                    await self.notificationService.sendServerTestNotification()
                                    await Task.yield()
                                    self.isTestingNotification = false
                                }
                            }
                            .disabled(self.isTestingNotification)
                        }
                    }

                    SettingRow("System Settings", caption: "Banner style, sounds and Focus for Untether.") {
                        Button("Notification Settings…") {
                            self.notificationService.openNotificationSettings()
                        }
                        .buttonStyle(.dsText)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            self.eventStreamConnectionStatus = self.notificationService.isEventStreamConnected
        }
        .onReceive(NotificationCenter.default.publisher(for: .notificationServiceConnectionChanged)) { _ in
            self.eventStreamConnectionStatus = self.notificationService.isEventStreamConnected
            logger.debug("Event stream connection status changed: \(self.eventStreamConnectionStatus)")
        }
        .alert("Notification Permission Required", isPresented: self.$showingPermissionAlert) {
            Button("Open System Settings") {
                self.notificationService.openNotificationSettings()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Allow notifications for Untether in System Settings.")
        }
    }

    private func typeToggle(_ title: LocalizedStringKey, caption: LocalizedStringKey?, isOn: Binding<Bool>) -> some View {
        ToggleRow(title, caption: caption, isOn: isOn)
            .onChange(of: isOn.wrappedValue) { _, _ in
                self.updateNotificationPreferences()
            }
    }

    private func applyNotificationsEnabled(_ newValue: Bool) {
        self.configManager.updateNotificationPreferences(enabled: newValue)

        guard newValue else {
            self.notificationService.stop()
            return
        }

        Task {
            // Request permissions and show test notification
            let granted = await self.notificationService.requestPermissionAndShowTestNotification()
            if granted {
                await self.notificationService.start()
            } else {
                // If permission denied, turn toggle back off
                self.configManager.updateNotificationPreferences(enabled: false)
                self.showingPermissionAlert = true
            }
        }
    }
}

#Preview {
    NotificationSettingsView()
        .environment(ConfigManager.shared)
        .environment(NotificationService.shared)
        .frame(width: 560, height: 700)
}
