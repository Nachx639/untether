import SwiftUI

struct PinggyIntegrationSection: View {
    let pinggyService: PinggyService
    let serverPort: String

    @State private var tunnelEnabled = false
    @State private var isTogglingTunnel = false
    @State private var tokenInput = ""
    @State private var tokenStored = false
    @State private var isEditingToken = false
    @State private var tokenError: String?
    @State private var tunnelError: String?
    @State private var isConfirmingRemove = false

    var body: some View {
        Section {
            SettingRow("Status", caption: "Uses the pinggy command line tool.") {
                StatusBadge(self.statusText, kind: self.statusKind)
            }

            if !self.pinggyService.isInstalled {
                SettingRow("Install", caption: "Paste the command in Terminal to install pinggy.") {
                    HStack(spacing: DS.Spacing.m) {
                        Button("Setup Guide") { self.pinggyService.openSetupGuide() }
                        Button("Copy Install Command") { self.pinggyService.copyInstallCommand() }
                    }
                    .buttonStyle(.dsText)
                }
            } else {
                ToggleRow(
                    "Tunnel",
                    caption: self.isTogglingTunnel ? "Working…" : nil,
                    isOn: self.$tunnelEnabled)
                    .disabled(self.isTogglingTunnel)
                    .onChange(of: self.tunnelEnabled) { _, enabled in
                        switch TunnelToggleAction.resolve(
                            switchIsOn: enabled,
                            serviceIsRunning: self.pinggyService.isRunning)
                        {
                        case .start: self.startTunnel()
                        case .stop: self.stopTunnel()
                        case .none: break
                        }
                    }

                if let publicUrl = pinggyService.publicUrl {
                    ClickableURLView(label: "Public URL", url: publicUrl)
                }

                PublicAccessCallout()

                ForEach(self.errors, id: \.self) { error in
                    CalloutBox(error, kind: .error)
                }

                self.tokenControls

                SettingRow("Fixed URL", caption: "Give your token a persistent domain in Pinggy.") {
                    Button("Open Pinggy") { self.pinggyService.openDashboard() }
                        .buttonStyle(.dsText)
                }
            }
        } header: {
            Text(verbatim: "Pinggy")
        }
        .task {
            _ = self.pinggyService.checkCLIInstallation()
            self.tokenStored = self.pinggyService.hasAccessToken
            self.tunnelEnabled = self.pinggyService.isRunning
        }
        .onChange(of: self.pinggyService.isRunning) { _, isRunning in
            self.tunnelEnabled = isRunning
        }
    }

    @ViewBuilder
    private var tokenControls: some View {
        if self.tokenStored, !self.isEditingToken {
            SettingRow("Access Token", caption: "Saved in the Keychain.") {
                HStack(spacing: DS.Spacing.s) {
                    Button("Replace") {
                        self.tokenInput = ""
                        self.isEditingToken = true
                    }
                    Button("Remove…", role: .destructive) {
                        self.isConfirmingRemove = true
                    }
                }
            }
            .confirmationDialog("Remove the Pinggy access token?", isPresented: self.$isConfirmingRemove) {
                Button("Remove", role: .destructive) {
                    self.pinggyService.deleteAccessToken()
                    self.tokenStored = false
                    self.tokenInput = ""
                    self.tokenError = nil
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("New tunnels get a random URL until you add a token again.")
            }
        } else {
            LabeledContent("Access Token") {
                HStack(spacing: DS.Spacing.s) {
                    SecureField("Access Token", text: self.$tokenInput, prompt: Text("Optional"))
                        .frame(minWidth: 180)
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            self.saveToken()
                        }

                    Button("Save") {
                        self.saveToken()
                    }
                    .disabled(self.tokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    if self.isEditingToken {
                        Button("Cancel") {
                            self.isEditingToken = false
                            self.tokenInput = ""
                            self.tokenError = nil
                        }
                    }
                }
            }
        }
    }

    private var errors: [String] {
        [self.pinggyService.statusError, self.tunnelError, self.tokenError].compactMap(\.self)
    }

    private var statusKind: StatusKind {
        if !self.pinggyService.isInstalled {
            return .inactive
        }
        return self.pinggyService.isRunning ? .ok : .inactive
    }

    private var statusText: String {
        if !self.pinggyService.isInstalled {
            return String(localized: "Not installed", comment: "Settings, Remote Access: Pinggy status")
        }
        return self.pinggyService.isRunning ? String(localized: "Tunnel running", comment: "Settings, Remote Access: Pinggy status") : String(localized: "Installed", comment: "Settings, Remote Access: Pinggy status")
    }

    private func saveToken() {
        let token = self.tokenInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }

        if self.pinggyService.saveAccessToken(token) {
            self.tokenStored = true
            self.isEditingToken = false
            self.tokenInput = ""
            self.tokenError = nil
        } else {
            self.tokenError = String(
                localized: "Couldn't save the access token to the Keychain.",
                comment: "Settings, Remote Access: Pinggy token error")
        }
    }

    private func startTunnel() {
        guard !self.isTogglingTunnel else { return }
        self.isTogglingTunnel = true
        self.tunnelError = nil

        Task {
            defer { self.isTogglingTunnel = false }
            do {
                try await self.pinggyService.startTunnel(port: Int(self.serverPort) ?? 4020)
                self.tunnelEnabled = self.pinggyService.isRunning
            } catch {
                self.tunnelEnabled = false
                self.tunnelError = error.localizedDescription
            }
        }
    }

    private func stopTunnel() {
        guard !self.isTogglingTunnel else { return }
        self.isTogglingTunnel = true

        Task {
            await self.pinggyService.stopTunnel()
            self.tunnelEnabled = false
            self.isTogglingTunnel = false
        }
    }
}
