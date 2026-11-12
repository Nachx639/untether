import AppKit
import OSLog
import SwiftUI

// MARK: - Logger

extension Logger {
    fileprivate static let appPreferences = Logger(
        subsystem: BundleIdentifiers.loggerSubsystem,
        category: "AppPreferences")
}

// MARK: - Terminal Preference Section

struct TerminalPreferenceSection: View {
    @AppStorage(AppConstants.UserDefaultsKeys.preferredTerminal, store: appDefaults)
    private var preferredTerminal = Terminal.terminal.rawValue
    @AppStorage(AppConstants.UserDefaultsKeys.preferredGitApp, store: appDefaults)
    private var preferredGitApp = ""
    @State private var terminalLauncher = TerminalLauncher.shared
    @State private var showingError = false
    @State private var errorMessage = ""
    @State private var errorTitle = ""
    @State private var recoveryPermission: SystemPermission?

    var body: some View {
        Section {
            SettingRow("Terminal", caption: "Where new sessions open.") {
                HStack(spacing: DS.Spacing.s) {
                    Button("Test Terminal") {
                        self.testTerminal()
                    }
                    .buttonStyle(.dsText)
                    .help("Opens a test command in the chosen terminal")

                    Picker("Terminal", selection: self.$preferredTerminal) {
                        ForEach(Terminal.installed, id: \.rawValue) { terminal in
                            AppMenuLabel(name: terminal.displayName, icon: terminal.appIcon)
                                .tag(terminal.rawValue)
                        }
                    }
                    .pickerStyle(.menu)
                    .dsNeutralTint()
                    .labelsHidden()
                    .fixedSize()
                }
            }

            Picker(selection: self.gitAppBinding) {
                ForEach(GitApp.installed, id: \.rawValue) { gitApp in
                    AppMenuLabel(name: gitApp.displayName, icon: gitApp.appIcon)
                        .tag(gitApp.rawValue)
                }
            } label: {
                Text("Git App")
                Text("Opens repositories from the menu.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .pickerStyle(.menu)
            .dsNeutralTint()
        } header: {
            Text("Apps")
        }
        .alert(self.errorTitle, isPresented: self.$showingError) {
            Button("OK") {}
            if let recoveryPermission = self.recoveryPermission {
                Button("Open System Settings") {
                    if let url = recoveryPermission.settingsURL {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        } message: {
            Text(self.errorMessage)
        }
    }

    private func testTerminal() {
        Task {
            do {
                try self.terminalLauncher.launchCommand("echo 'Untether Terminal Test: Success!'")
            } catch {
                Logger.appPreferences.error("Failed to launch terminal test: \(error)")

                let alert = TerminalLaunchAlertContent(
                    error: error,
                    terminalName: Terminal(rawValue: self.preferredTerminal)?.displayName
                        ?? String(localized: "terminal", comment: "Generic name for a terminal app, used inside a sentence"))
                self.errorTitle = alert.title
                self.errorMessage = alert.message
                self.recoveryPermission = alert.recoveryPermission
                self.showingError = true
            }
        }
    }

    private var gitAppBinding: Binding<String> {
        Binding(
            get: {
                // If no preference or invalid preference, use first installed app
                if self.preferredGitApp.isEmpty || GitApp(rawValue: self.preferredGitApp) == nil {
                    return GitApp.installed.first?.rawValue ?? ""
                }
                return self.preferredGitApp
            },
            set: { newValue in
                self.preferredGitApp = newValue
            })
    }
}

// MARK: - Window Highlight Settings Section

struct WindowHighlightSettingsSection: View {
    @AppStorage("windowHighlightEnabled", store: appDefaults)
    private var highlightEnabled = true
    @AppStorage("windowHighlightStyle", store: appDefaults)
    private var highlightStyle = "default"
    @AppStorage("windowHighlightColor", store: appDefaults)
    private var highlightColorData = Data()

    @State private var customColor = DS.Accent.color
    @State private var highlightEffect: WindowHighlightEffect?

    var body: some View {
        Section {
            Picker(selection: self.highlightStyleBinding) {
                Text("None").tag("none")
                Text("Default").tag("default")
                Text("Subtle").tag("subtle")
                Text("Neon").tag("neon")
                Text("Custom").tag("custom")
            } label: {
                Text("Style")
                Text("Flashes a terminal window when Untether focuses it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .pickerStyle(.menu)
            .dsNeutralTint()

            if self.highlightStyle == "custom", self.highlightEnabled {
                ColorPicker("Highlight Color", selection: self.$customColor, supportsOpacity: false)
                    .onChange(of: self.customColor) { _, newColor in
                        self.saveCustomColor(newColor)
                        self.previewHighlightEffect()
                    }
            }
        } header: {
            Text("Window Highlight")
        }
        .onAppear {
            self.loadCustomColor()
            // Create highlight effect instance for preview
            self.highlightEffect = WindowHighlightEffect()
        }
    }

    private var highlightStyleBinding: Binding<String> {
        Binding(
            get: {
                self.highlightEnabled ? self.highlightStyle : "none"
            },
            set: { newValue in
                if newValue == "none" {
                    self.highlightEnabled = false
                    self.highlightStyle = "default" // Keep a default style for when re-enabled
                } else {
                    self.highlightEnabled = true
                    self.highlightStyle = newValue
                    self.previewHighlightEffect()
                }
            })
    }

    private func saveCustomColor(_ color: Color) {
        let nsColor = NSColor(color)
        do {
            let data = try NSKeyedArchiver.archivedData(withRootObject: nsColor, requiringSecureCoding: false)
            self.highlightColorData = data
        } catch {
            Logger.appPreferences.error("Failed to save custom color: \(error)")
        }
    }

    private func loadCustomColor() {
        if !self.highlightColorData.isEmpty {
            do {
                if let nsColor = try NSKeyedUnarchiver.unarchivedObject(
                    ofClass: NSColor.self,
                    from: highlightColorData)
                {
                    self.customColor = Color(nsColor)
                }
            } catch {
                Logger.appPreferences.error("Failed to load custom color: \(error)")
            }
        }
    }

    private func previewHighlightEffect() {
        Task { @MainActor in
            // Get the current highlight configuration
            let config = self.loadCurrentHighlightConfig()

            // Update the highlight effect with new config
            self.highlightEffect?.updateConfig(config)

            // Find the settings window (SwiftUI's fixed identifier, else the key window)
            guard let settingsWindow = NSApp.windows.first(where: { window in
                window.identifier?.rawValue == "com_apple_SwiftUI_Settings_window"
            }) ?? NSApp.keyWindow else {
                Logger.appPreferences.debug("Could not find settings window for highlight preview")
                return
            }

            // Get the window's accessibility element
            let pid = ProcessInfo.processInfo.processIdentifier
            let axApp = AXElement.application(pid: pid)

            guard let windows = axApp.windows, !windows.isEmpty else {
                Logger.appPreferences.debug("Could not get accessibility windows for highlight preview")
                return
            }

            // Find the settings window by comparing bounds
            let settingsFrame = settingsWindow.frame
            var targetWindow: AXElement?

            for axWindow in windows {
                if let frame = axWindow.frame() {
                    // Check if this matches our settings window (with some tolerance for frame differences)
                    let tolerance: CGFloat = 5.0
                    if abs(frame.origin.x - settingsFrame.origin.x) < tolerance,
                       abs(frame.width - settingsFrame.width) < tolerance,
                       abs(frame.height - settingsFrame.height) < tolerance
                    {
                        targetWindow = axWindow
                        break
                    }
                }
            }

            // Apply highlight effect to the settings window
            if let window = targetWindow {
                self.highlightEffect?.highlightWindow(window)
            } else {
                Logger.appPreferences.debug("Could not match settings window for highlight preview")
            }
        }
    }

    private func loadCurrentHighlightConfig() -> WindowHighlightConfig {
        guard self.highlightEnabled else {
            return WindowHighlightConfig(
                color: .clear,
                duration: 0,
                borderWidth: 0,
                glowRadius: 0,
                isEnabled: false)
        }

        switch self.highlightStyle {
        case "subtle":
            return .subtle
        case "neon":
            return .neon
        case "custom":
            // Load custom color
            let colorData = self.highlightColorData
            if !colorData.isEmpty,
               let nsColor = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NSColor.self, from: colorData)
            {
                return WindowHighlightConfig(
                    color: nsColor,
                    duration: 0.8,
                    borderWidth: 4.0,
                    glowRadius: 12.0,
                    isEnabled: true)
            }
            return .default
        default:
            return .default
        }
    }
}

// MARK: - App Menu Label

/// App name with its 16pt icon, for app pickers.
private struct AppMenuLabel: View {
    let name: String
    let icon: NSImage?

    var body: some View {
        HStack {
            if let icon {
                Image(nsImage: icon.resized(to: NSSize(width: 16, height: 16)))
            }
            Text(self.name)
        }
    }
}
