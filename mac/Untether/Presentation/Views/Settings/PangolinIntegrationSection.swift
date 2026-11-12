import SwiftUI

struct PangolinIntegrationSection: View {
    let pangolinService: PangolinService
    let serverPort: String

    @State private var connectionEnabled = false
    @State private var isTogglingConnection = false
    @State private var endpointInput = URLConstants.pangolinCloud
    @State private var siteIDInput = ""
    @State private var secretInput = ""
    @State private var credentialsStored = false
    @State private var isEditingCredentials = false
    @State private var credentialsError: String?
    @State private var connectionError: String?
    @State private var isConfirmingRemove = false

    var body: some View {
        Section {
            SettingRow("Status", caption: "Runs Newt, the Pangolin site connector.") {
                StatusBadge(self.statusText, kind: self.statusKind)
            }

            if !self.pangolinService.isInstalled {
                SettingRow("Install", caption: "Paste the command in Terminal to install Newt.") {
                    Button("Copy Install Command") { self.pangolinService.copyInstallCommand() }
                        .buttonStyle(.dsText)
                }
            } else {
                self.credentialsControls

                if self.credentialsStored {
                    ToggleRow(
                        "Connect Site",
                        caption: self.isTogglingConnection ? "Working…" : nil,
                        isOn: self.$connectionEnabled)
                        .disabled(self.isTogglingConnection)
                        .onChange(of: self.connectionEnabled) { _, enabled in
                            switch TunnelToggleAction.resolve(
                                switchIsOn: enabled,
                                serviceIsRunning: self.pangolinService.isRunning)
                            {
                            case .start: self.startConnection()
                            case .stop: self.stopConnection()
                            case .none: break
                            }
                        }
                }

                ForEach(self.errors, id: \.self) { error in
                    CalloutBox(error, kind: .error)
                }
            }

            VStack(alignment: .leading, spacing: DS.Spacing.xs) {
                Text("Resource Target")
                CodeSnippet("http://localhost:\(self.serverPort)")
                Text("Use this as the target of a public Resource in Pangolin.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            SettingRow("Access Policy", caption: "Pangolin owns the public URL and who can open it.") {
                HStack(spacing: DS.Spacing.m) {
                    Button("Setup Guide") { self.pangolinService.openSetupGuide() }
                    Button("Open Pangolin") { self.pangolinService.openDashboard() }
                }
                .buttonStyle(.dsText)
            }
        } header: {
            Text(verbatim: "Pangolin")
        }
        .task {
            _ = self.pangolinService.checkCLIInstallation()
            self.credentialsStored = self.pangolinService.hasCredentials
            self.connectionEnabled = self.pangolinService.isRunning
            if let credentials = pangolinService.credentials {
                self.endpointInput = credentials.endpoint
            }
        }
        .onChange(of: self.pangolinService.isRunning) { _, isRunning in
            self.connectionEnabled = isRunning
        }
    }

    @ViewBuilder
    private var credentialsControls: some View {
        if self.credentialsStored, !self.isEditingCredentials {
            SettingRow("Site Credentials", caption: "Saved in the Keychain.") {
                HStack(spacing: DS.Spacing.s) {
                    Button("Replace") {
                        if let credentials = pangolinService.credentials {
                            self.endpointInput = credentials.endpoint
                            self.siteIDInput = credentials.siteID
                        }
                        self.secretInput = ""
                        self.isEditingCredentials = true
                    }
                    Button("Remove…", role: .destructive) {
                        self.isConfirmingRemove = true
                    }
                }
                .disabled(self.pangolinService.isRunning)
            }
            .confirmationDialog("Remove the site credentials?", isPresented: self.$isConfirmingRemove) {
                Button("Remove", role: .destructive) {
                    self.pangolinService.deleteCredentials()
                    self.credentialsStored = false
                    self.siteIDInput = ""
                    self.secretInput = ""
                    self.credentialsError = nil
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You'll need the site ID and secret again to reconnect.")
            }
        } else {
            LabeledContent("Endpoint") {
                TextField("Endpoint", text: self.$endpointInput, prompt: Text(verbatim: URLConstants.pangolinCloud))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 220)
            }
            LabeledContent("Site ID") {
                TextField("Site ID", text: self.$siteIDInput, prompt: Text("From your site in Pangolin"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 220)
            }
            LabeledContent("Secret") {
                SecureField("Secret", text: self.$secretInput, prompt: Text("Required"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 220)
                    .onSubmit {
                        self.saveCredentials()
                    }
            }

            HStack {
                Spacer()
                if self.isEditingCredentials {
                    Button("Cancel") {
                        self.isEditingCredentials = false
                        self.siteIDInput = ""
                        self.secretInput = ""
                        self.credentialsError = nil
                    }
                }
                Button("Save Credentials") {
                    self.saveCredentials()
                }
                .disabled(
                    self.endpointInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        self.siteIDInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        self.secretInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var errors: [String] {
        [self.pangolinService.statusError, self.connectionError, self.credentialsError].compactMap(\.self)
    }

    private var statusKind: StatusKind {
        if !self.pangolinService.isInstalled {
            return .inactive
        }
        if self.pangolinService.isConnected {
            return .ok
        }
        return self.pangolinService.isRunning ? .progress : .inactive
    }

    private var statusText: String {
        if !self.pangolinService.isInstalled {
            return String(localized: "Not installed", comment: "Settings, Remote Access: Pangolin status")
        }
        if self.pangolinService.isConnected {
            return String(localized: "Site connected", comment: "Settings, Remote Access: Pangolin status")
        }
        return self.pangolinService.isRunning ? String(localized: "Connecting…", comment: "Settings, Remote Access: Pangolin status") : String(localized: "Installed", comment: "Settings, Remote Access: Pangolin status")
    }

    private func saveCredentials() {
        if self.pangolinService.saveCredentials(
            endpoint: self.endpointInput,
            siteID: self.siteIDInput,
            secret: self.secretInput)
        {
            self.credentialsStored = true
            self.isEditingCredentials = false
            self.siteIDInput = ""
            self.secretInput = ""
            self.credentialsError = nil
        } else {
            self.credentialsError = String(
                localized: "Enter a valid HTTP(S) endpoint, site ID, and secret.",
                comment: "Settings, Remote Access: Pangolin credentials error")
        }
    }

    private func startConnection() {
        guard !self.isTogglingConnection else { return }
        self.isTogglingConnection = true
        self.connectionError = nil

        Task {
            defer { self.isTogglingConnection = false }
            do {
                try await self.pangolinService.start()
                self.connectionEnabled = self.pangolinService.isRunning
            } catch {
                self.connectionEnabled = false
                self.connectionError = error.localizedDescription
            }
        }
    }

    private func stopConnection() {
        guard !self.isTogglingConnection else { return }
        self.isTogglingConnection = true

        Task {
            await self.pangolinService.stop()
            self.connectionEnabled = false
            self.isTogglingConnection = false
        }
    }
}
