import AppKit
import SwiftUI

// MARK: - CLI Installation Section

struct CLIInstallationSection: View {
    @State private var cliInstaller = CLIInstaller()
    @State private var showingAlternateNameHelp = false
    @AppStorage(AppConstants.UserDefaultsKeys.debugMode, store: appDefaults)
    private var debugMode = false

    var body: some View {
        Section {
            SettingRow("ut", caption: self.caption) {
                self.controls
            }

            if let error = cliInstaller.lastError {
                CalloutBox(error, kind: .error)
            }

            SettingRow("Different Name", caption: "If \"ut\" clashes with another tool on your Mac.") {
                Button("Show Command…") {
                    self.showingAlternateNameHelp = true
                }
                .buttonStyle(.dsText)
            }
        } header: {
            Text("Command Line Tool")
        } footer: {
            Text("Prefix any command with \"ut\" to see and control it from anywhere.")
        }
        .onAppear {
            self.cliInstaller.checkInstallationStatus()
        }
        .alert("Install Under a Different Name", isPresented: self.$showingAlternateNameHelp) {
            Button("Copy Command") {
                self.copyCommandToClipboard()
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(
                "If \"ut\" clashes with another tool, install the script under another name:\n\n\(self.alternateNameCommand)")
        }
    }

    private var caption: String {
        if self.cliInstaller.isInstalled, self.cliInstaller.isOutdated {
            String(localized: "Update available.", comment: "Settings, command line tool: caption when a newer version is bundled")
        } else if self.cliInstaller.isInstalled {
            String(localized: "Installed at /usr/local/bin/ut.", comment: "Settings, command line tool: caption. Keep the path as is")
        } else {
            String(localized: "Not installed.", comment: "Settings, command line tool: caption")
        }
    }

    @ViewBuilder
    private var controls: some View {
        if self.cliInstaller.isInstalling {
            StatusBadge(self.cliInstaller.isUninstalling ? "Uninstalling…" : "Installing…", kind: .progress)
        } else if self.cliInstaller.isInstalled {
            HStack(spacing: DS.Spacing.s) {
                if self.cliInstaller.isOutdated {
                    Button("Update") {
                        Task { await self.cliInstaller.install() }
                    }
                } else {
                    StatusBadge("Installed", kind: .ok)
                    if self.debugMode {
                        Button {
                            self.cliInstaller.installCLITool()
                        } label: {
                            Label("Reinstall", systemImage: "arrow.clockwise")
                                .labelStyle(.iconOnly)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .help("Reinstall the command line tool")
                        .accessibilityLabel("Reinstall")
                    }
                }

                Button(role: .destructive) {
                    Task { await self.cliInstaller.uninstall() }
                } label: {
                    Label("Uninstall", systemImage: "trash")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help("Uninstall the command line tool")
                .accessibilityLabel("Uninstall")
            }
        } else {
            Button("Install") {
                Task { await self.cliInstaller.install() }
            }
        }
    }

    private var utScriptPath: String {
        if let path = Bundle.main.path(forResource: "ut", ofType: nil) {
            return path
        }
        return "/Applications/Untether.app/Contents/Resources/ut"
    }

    private var alternateNameCommand: String {
        "cp \"\(self.utScriptPath)\" /usr/local/bin/untether-ut && chmod +x /usr/local/bin/untether-ut"
    }

    private func copyCommandToClipboard() {
        let pasteboard = appPasteboard
        pasteboard.clearContents()
        pasteboard.setString(self.alternateNameCommand, forType: .string)
    }
}
