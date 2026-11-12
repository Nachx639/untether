import AppKit
import os.log
import SwiftUI

// MARK: - Dev Server Validation

enum DevServerValidation: Equatable {
    case notValidated
    case validating
    case valid
    case invalid(String)

    var isValid: Bool {
        if case .valid = self {
            return true
        }
        return false
    }

    var errorMessage: String? {
        if case let .invalid(message) = self {
            return message
        }
        return nil
    }
}

/// Debug settings tab for development and troubleshooting
struct DebugSettingsView: View {
    @AppStorage(AppConstants.UserDefaultsKeys.useDevServer, store: appDefaults)
    private var useDevServer = false
    @AppStorage(AppConstants.UserDefaultsKeys.devServerPath, store: appDefaults)
    private var devServerPath = ""
    @Environment(ServerManager.self)
    private var serverManager
    @State private var showPurgeConfirmation = false
    @State private var devServerValidation: DevServerValidation = .notValidated
    @State private var devServerManager = DevServerManager.shared

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "DebugSettings")

    var body: some View {
        Form {
            DevelopmentServerSection(
                useDevServer: self.$useDevServer,
                devServerPath: self.$devServerPath,
                devServerValidation: self.$devServerValidation,
                validateDevServer: self.validateDevServer,
                serverManager: self.serverManager)

            DeveloperToolsSection(
                showPurgeConfirmation: self.$showPurgeConfirmation,
                openConsole: self.openConsole,
                showApplicationSupport: self.showApplicationSupport)
        }
        .formStyle(.grouped)
        .alert("Reset All Preferences?", isPresented: self.$showPurgeConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Reset and Quit", role: .destructive) {
                self.purgeAllUserDefaults()
            }
        } message: {
            Text("Every stored preference is removed and Untether quits.")
        }
    }

    // MARK: - Private Methods

    private func purgeAllUserDefaults() {
        // Get the app's bundle identifier
        if let bundleIdentifier = Bundle.main.bundleIdentifier {
            // Remove all UserDefaults for this app
            appDefaults.removePersistentDomain(forName: bundleIdentifier)
            appDefaults.synchronize()

            // Quit the app after a short delay to ensure the purge completes
            Task {
                try? await Task.sleep(for: .milliseconds(500))
                await MainActor.run {
                    NSApplication.shared.terminate(nil)
                }
            }
        }
    }

    private func openConsole() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Utilities/Console.app"))
    }

    private func showApplicationSupport() {
        if let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let appDirectory = appSupport.appendingPathComponent("Untether")
            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: appDirectory.path)
        }
    }

    private func validateDevServer(path: String) {
        self.devServerValidation = self.devServerManager.validate(path: path)
    }
}

// MARK: - Developer Tools Section

private struct DeveloperToolsSection: View {
    @Binding var showPurgeConfirmation: Bool
    let openConsole: () -> Void
    let showApplicationSupport: () -> Void

    var body: some View {
        Section("Tools") {
            SettingRow("System Logs", caption: "View Untether's logs in Console.") {
                Button("Open Console", action: self.openConsole)
            }

            SettingRow("App Data", caption: "Untether's folder in Application Support.") {
                Button("Show in Finder", action: self.showApplicationSupport)
            }

            SettingRow("Welcome Guide", caption: "Walk through onboarding again.") {
                Button("Show Welcome") {
                    #if !SWIFT_PACKAGE
                    AppDelegate.showWelcomeScreen()
                    #endif
                }
            }

            SettingRow("Preferences", caption: "Reset everything to defaults and quit.") {
                Button("Reset…", role: .destructive) {
                    self.showPurgeConfirmation = true
                }
            }
        }
    }
}

// MARK: - Development Server Section

private struct DevelopmentServerSection: View {
    @Binding var useDevServer: Bool
    @Binding var devServerPath: String
    @Binding var devServerValidation: DevServerValidation
    let validateDevServer: (String) -> Void
    let serverManager: ServerManager

    var body: some View {
        Section {
            ToggleRow(
                "Use Development Server",
                caption: "Run \"pnpm run dev\" with hot reload instead of the built-in server.",
                isOn: self.$useDevServer)
                .onChange(of: self.useDevServer) { _, newValue in
                    if newValue, !self.devServerPath.isEmpty {
                        self.validateDevServer(self.devServerPath)
                    }
                    // Restart server if it's running and the setting changed
                    if self.serverManager.isRunning {
                        Task {
                            await self.serverManager.restart()
                        }
                    }
                }

            if self.useDevServer {
                PathFieldRow(
                    title: Text("Web Project", comment: "Settings, Debug: folder of the web project for the development server"),
                    caption: Text("The folder that contains package.json.", comment: "Settings, Debug: caption of Web Project"),
                    prompt: Text(verbatim: "~/Projects/untether/web"),
                    path: self.$devServerPath,
                    onChoose: self.selectDirectory)
                {
                    switch self.devServerValidation {
                    case .validating:
                        StatusBadge("Checking…", kind: .progress)
                    case .valid:
                        StatusBadge("Has a dev script", kind: .ok)
                    case .invalid:
                        StatusBadge("Not usable", kind: .error)
                    case .notValidated:
                        EmptyView()
                    }
                }
                .onChange(of: self.devServerPath) { _, newPath in
                    self.validateDevServer(newPath)
                }

                if let message = self.devServerValidation.errorMessage {
                    CalloutBox(message, kind: .error)
                }
            }
        } header: {
            Text("Development Server")
        } footer: {
            if self.useDevServer {
                Text("Requires pnpm. Uses the same arguments as the built-in server.")
            }
        }
        .task {
            // Validate the saved path so its status shows as soon as the tab opens
            if self.useDevServer, !self.devServerPath.isEmpty, self.devServerValidation == .notValidated {
                self.validateDevServer(self.devServerPath)
            }
        }
    }

    private func selectDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false

        // Set initial directory
        if !self.devServerPath.isEmpty {
            let expandedPath = NSString(string: devServerPath).expandingTildeInPath
            panel.directoryURL = URL(fileURLWithPath: expandedPath)
        }

        if panel.runModal() == .OK, let url = panel.url {
            let path = url.path
            let homeDir = NSHomeDirectory()
            if path.hasPrefix(homeDir) {
                self.devServerPath = "~" + path.dropFirst(homeDir.count)
            } else {
                self.devServerPath = path
            }

            // Validate immediately after selection
            self.validateDevServer(self.devServerPath)
        }
    }
}
