import AppKit
import os.log
import SwiftUI

/// Remote Access settings tab for external access configuration
struct RemoteAccessSettingsView: View {
    @AppStorage(AppConstants.UserDefaultsKeys.remoteAccessProvider, store: appDefaults)
    private var selectedProviderRaw = RemoteProvider.tailscale.rawValue
    @AppStorage(AppConstants.UserDefaultsKeys.tailscaleServeEnabled, store: appDefaults)
    private var tailscaleServeEnabled = false
    @AppStorage("ngrokEnabled", store: appDefaults)
    private var ngrokEnabled = false
    @AppStorage("ngrokTokenPresent", store: appDefaults)
    private var ngrokTokenPresent = false
    @AppStorage(AppConstants.UserDefaultsKeys.serverPort, store: appDefaults)
    private var serverPort = "4020"
    @AppStorage(AppConstants.UserDefaultsKeys.dashboardAccessMode, store: appDefaults)
    private var accessModeString = AppConstants.Defaults.dashboardAccessMode
    @AppStorage(AppConstants.UserDefaultsKeys.authenticationMode, store: appDefaults)
    private var authModeString = "os"

    @State private var authMode: AuthenticationMode = .osAuth

    @Environment(NgrokService.self)
    private var ngrokService
    @Environment(TailscaleService.self)
    private var tailscaleService
    @Environment(CloudflareService.self)
    private var cloudflareService
    @Environment(PinggyService.self)
    private var pinggyService
    @Environment(PangolinService.self)
    private var pangolinService
    @Environment(TailscaleServeStatusService.self)
    private var tailscaleServeStatus
    @Environment(ServerManager.self)
    private var serverManager

    @State private var ngrokAuthToken = ""
    @State private var ngrokStatus: NgrokTunnelStatus?
    @State private var isStartingNgrok = false
    @State private var ngrokError: String?
    @State private var showingAuthTokenAlert = false
    @State private var showingKeychainAlert = false
    @State private var isTokenRevealed = false
    @State private var maskedToken = ""
    @State private var localIPAddress: String?
    @State private var showingServerErrorAlert = false
    @State private var serverErrorMessage = ""

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "RemoteAccessSettings")

    private var accessMode: DashboardAccessMode {
        DashboardAccessMode(rawValue: self.accessModeString) ?? .localhost
    }

    private var selectedProvider: Binding<RemoteProvider> {
        Binding(
            get: { RemoteProvider(rawValue: self.selectedProviderRaw) ?? .tailscale },
            set: { self.selectedProviderRaw = $0.rawValue })
    }

    private var providerStates: RemoteProviderStates {
        RemoteProviderStates(
            tailscale: self.tailscaleService,
            tailscaleServeEnabled: self.tailscaleServeEnabled,
            cloudflare: self.cloudflareService,
            pinggy: self.pinggyService,
            pangolin: self.pangolinService,
            ngrok: self.ngrokService)
    }

    var body: some View {
        Form {
            self.providerPickerSection

            switch self.selectedProvider.wrappedValue {
            case .tailscale:
                TailscaleIntegrationSection(
                    tailscaleService: self.tailscaleService,
                    serverPort: self.serverPort,
                    accessMode: self.accessMode,
                    serverManager: self.serverManager)
            case .cloudflare:
                CloudflareIntegrationSection(
                    cloudflareService: self.cloudflareService,
                    serverPort: self.serverPort,
                    accessMode: self.accessMode)
            case .pinggy:
                PinggyIntegrationSection(
                    pinggyService: self.pinggyService,
                    serverPort: self.serverPort)
            case .pangolin:
                PangolinIntegrationSection(
                    pangolinService: self.pangolinService,
                    serverPort: self.serverPort)
            case .ngrok:
                NgrokIntegrationSection(
                    ngrokEnabled: self.$ngrokEnabled,
                    ngrokAuthToken: self.$ngrokAuthToken,
                    isTokenRevealed: self.$isTokenRevealed,
                    maskedToken: self.$maskedToken,
                    ngrokTokenPresent: self.$ngrokTokenPresent,
                    ngrokStatus: self.$ngrokStatus,
                    isStartingNgrok: self.$isStartingNgrok,
                    ngrokError: self.$ngrokError,
                    toggleTokenVisibility: self.toggleTokenVisibility,
                    checkAndStartNgrok: self.checkAndStartNgrok,
                    stopNgrok: self.stopNgrok,
                    ngrokService: self.ngrokService,
                    logger: self.logger)
            }

            AuthenticationSection(
                authMode: self.$authMode,
                enableSSHKeys: .constant(self.authMode == .sshKeys || self.authMode == .both),
                logger: self.logger,
                serverManager: self.serverManager)
        }
        .formStyle(.grouped)
        .onAppear {
            self.onAppearSetup()
            self.updateLocalIPAddress()
            // Initialize authentication mode from stored value
            let storedMode = appDefaults
                .string(forKey: AppConstants.UserDefaultsKeys.authenticationMode) ?? "os"
            self.authMode = AuthenticationMode(rawValue: storedMode) ?? .osAuth
            // Open on the provider that is actually in use
            let states = self.providerStates
            if !states.isActive(self.selectedProvider.wrappedValue), let active = states.activeProviders.first {
                self.selectedProvider.wrappedValue = active
            }
            // Start monitoring Tailscale Serve status
            self.tailscaleServeStatus.startMonitoring()
        }
        .onDisappear {
            // 2026-11-10: this stopped the polling for the whole app (it is one shared
            // service), so the menu's Tailscale chip kept its last value until this tab was
            // opened again. It only stops when Serve is off and nobody shows its state.
            if !self.tailscaleServeEnabled {
                self.tailscaleServeStatus.stopMonitoring()
            }
        }
        .alert("ngrok Authentication Required", isPresented: self.$showingAuthTokenAlert) {
            Button("OK") {}
        } message: {
            Text("Enter your ngrok auth token to start a tunnel.")
        }
        .alert("Keychain Access Failed", isPresented: self.$showingKeychainAlert) {
            Button("OK") {}
        } message: {
            Text("The auth token couldn't be saved to the Keychain. Check your Keychain permissions and try again.")
        }
        .alert("Failed to Restart Server", isPresented: self.$showingServerErrorAlert) {
            Button("OK") {}
        } message: {
            Text(self.serverErrorMessage)
        }
    }

    private var providerPickerSection: some View {
        let states = self.providerStates
        let selected = self.selectedProvider.wrappedValue
        let othersActive = states.activeProviders.filter { $0 != selected }

        return Section {
            SettingRow(title: Text("Provider", comment: "Settings, Remote Access: label of the provider picker"), caption: Text(selected.summary)) {
                HStack(spacing: DS.Spacing.s) {
                    if states.isActive(selected) {
                        StatusBadge("On", kind: .ok)
                    }
                    Picker("Provider", selection: self.selectedProvider) {
                        ForEach(RemoteProvider.allCases) { provider in
                            Text(provider.displayName)
                                .tag(provider)
                        }
                    }
                    .pickerStyle(.menu)
                    .dsNeutralTint()
                    .labelsHidden()
                    .fixedSize()
                }
            }

            if !othersActive.isEmpty {
                CalloutBox(
                    "Also on: \(othersActive.map(\.displayName).formatted(.list(type: .and))).",
                    kind: .info)
            }
        } header: {
            Text("Remote Access")
        }
    }

    // MARK: - Private Methods

    private func onAppearSetup() {
        // Check if token exists without triggering keychain
        if self.ngrokService.hasAuthToken, !self.ngrokTokenPresent {
            self.ngrokTokenPresent = true
        }

        // Update masked field based on token presence
        if self.ngrokTokenPresent, !self.isTokenRevealed {
            self.maskedToken = String(repeating: "•", count: 12)
        }
    }

    private func checkAndStartNgrok() {
        self.logger.debug("checkAndStartNgrok called")

        // Check if we have a token in the keychain without accessing it
        guard self.ngrokTokenPresent || self.ngrokService.hasAuthToken else {
            self.logger.debug("No auth token stored")
            self.ngrokError = String(localized: "Enter your ngrok auth token first.", comment: "Settings, Remote Access: ngrok error")
            self.ngrokEnabled = false
            self.showingAuthTokenAlert = true
            return
        }

        // If token hasn't been revealed yet, we need to access it from keychain
        if !self.isTokenRevealed, self.ngrokAuthToken.isEmpty {
            // This will trigger keychain access
            if let token = ngrokService.authToken {
                self.ngrokAuthToken = token
                self.logger.debug("Retrieved token from keychain for ngrok start")
            } else {
                self.logger.error("Failed to retrieve token from keychain")
                self.ngrokError = String(localized: "Couldn't read the auth token. Try again.", comment: "Settings, Remote Access: ngrok error")
                self.ngrokEnabled = false
                self.showingKeychainAlert = true
                return
            }
        }

        self.logger.debug("Starting ngrok with auth token present")
        self.isStartingNgrok = true
        self.ngrokError = nil

        Task {
            do {
                let port = Int(serverPort) ?? 4020
                self.logger.info("Starting ngrok on port \(port)")
                _ = try await self.ngrokService.start(port: port)
                self.isStartingNgrok = false
                self.ngrokStatus = await self.ngrokService.getStatus()
                self.logger.info("ngrok started successfully")
            } catch {
                self.logger.error("ngrok start error: \(error)")
                self.isStartingNgrok = false
                self.ngrokError = error.localizedDescription
                self.ngrokEnabled = false
            }
        }
    }

    private func stopNgrok() {
        Task {
            try? await self.ngrokService.stop()
            self.ngrokStatus = nil
            // Don't clear the error here - let it remain visible
        }
    }

    private func toggleTokenVisibility() {
        if self.isTokenRevealed {
            // Hide the token
            self.isTokenRevealed = false
            self.ngrokAuthToken = ""
            if self.ngrokTokenPresent {
                self.maskedToken = String(repeating: "•", count: 12)
            }
        } else {
            // Reveal the token - this will trigger keychain access
            if let token = ngrokService.authToken {
                self.ngrokAuthToken = token
                self.isTokenRevealed = true
            } else {
                // No token stored, just reveal the empty field
                self.ngrokAuthToken = ""
                self.isTokenRevealed = true
            }
        }
    }

    private func restartServerWithNewPort(_ port: Int) {
        Task {
            await ServerConfigurationHelpers.restartServerWithNewPort(port, serverManager: self.serverManager)
        }
    }

    private func restartServerWithNewBindAddress() {
        Task {
            await ServerConfigurationHelpers.restartServerWithNewBindAddress(
                accessMode: self.accessMode,
                customAddress: self.serverManager.customBindAddress,
                serverManager: self.serverManager)
        }
    }

    private func updateLocalIPAddress() {
        Task {
            self.localIPAddress = await ServerConfigurationHelpers.updateLocalIPAddress(accessMode: self.accessMode)
        }
    }
}

// MARK: - Remote Providers

/// The ways Untether can be reached from other devices.
enum RemoteProvider: String, CaseIterable, Identifiable {
    case tailscale
    case cloudflare
    case pinggy
    case pangolin
    case ngrok

    var id: String {
        self.rawValue
    }

    var displayName: String {
        switch self {
        case .tailscale: "Tailscale"
        case .cloudflare: "Cloudflare"
        case .pinggy: "Pinggy"
        case .pangolin: "Pangolin"
        case .ngrok: "ngrok"
        }
    }

    /// One-line description shown under the provider picker.
    var summary: String {
        switch self {
        case .tailscale:
            String(localized: "Recommended. Private access from your own devices.", comment: "Settings, Remote Access: Tailscale summary")
        case .cloudflare:
            String(localized: "Free public Quick Tunnel. No account needed.", comment: "Settings, Remote Access: Cloudflare summary. Quick Tunnel is a Cloudflare product name")
        case .pinggy:
            String(localized: "Public HTTPS tunnel, optional fixed URL.", comment: "Settings, Remote Access: Pinggy summary")
        case .pangolin:
            String(localized: "Your self-hosted or cloud Pangolin site.", comment: "Settings, Remote Access: Pangolin summary")
        case .ngrok:
            String(localized: "Public tunnel with an ngrok account.", comment: "Settings, Remote Access: ngrok summary")
        }
    }
}

/// Live state of every remote provider, read from their services.
@MainActor
struct RemoteProviderStates {
    let tailscale: TailscaleService
    let tailscaleServeEnabled: Bool
    let cloudflare: CloudflareService
    let pinggy: PinggyService
    let pangolin: PangolinService
    let ngrok: NgrokService

    func isActive(_ provider: RemoteProvider) -> Bool {
        switch provider {
        case .tailscale: self.tailscaleServeEnabled && self.tailscale.isRunning
        case .cloudflare: self.cloudflare.isRunning
        case .pinggy: self.pinggy.isRunning
        case .pangolin: self.pangolin.isRunning
        case .ngrok: self.ngrok.isActive
        }
    }

    var activeProviders: [RemoteProvider] {
        RemoteProvider.allCases.filter { self.isActive($0) }
    }

    /// A single status for the Dashboard: the first active provider, or why none is.
    var summary: (text: String, kind: StatusKind, url: String?) {
        if let provider = self.activeProviders.first {
            let others = self.activeProviders.count - 1
            let name = provider.displayName
            let text = others > 0
                ? String(
                    localized: "\(name) and \(others) more",
                    comment: "Settings, Server: remote access status. First: provider name, second: number of other active providers (plural)")
                : String(localized: "\(name) connected", comment: "Settings, Server: remote access status. Placeholder: provider name")
            return (text, .ok, self.url(for: provider))
        }
        if self.tailscale.isRunning, let hostname = self.tailscale.tailscaleHostname {
            return (String(localized: "Tailscale available", comment: "Settings, Server: remote access status"), .info, hostname)
        }
        return (String(localized: "Off · this Mac only", comment: "Settings, Server: remote access status when nothing is on"), .inactive, nil)
    }

    private func url(for provider: RemoteProvider) -> String? {
        switch provider {
        case .tailscale: self.tailscale.tailscaleHostname.map { "https://\($0)" }
        case .cloudflare: self.cloudflare.publicUrl
        case .pinggy: self.pinggy.publicUrl
        case .pangolin: nil
        case .ngrok: self.ngrok.publicUrl
        }
    }
}

// MARK: - Tailscale Integration Section

private struct TailscaleIntegrationSection: View {
    let tailscaleService: TailscaleService
    let serverPort: String
    let accessMode: DashboardAccessMode
    let serverManager: ServerManager

    @AppStorage(AppConstants.UserDefaultsKeys.tailscaleServeEnabled, store: appDefaults)
    private var tailscaleServeEnabled = false
    @AppStorage(AppConstants.UserDefaultsKeys.tailscaleFunnelEnabled, store: appDefaults)
    private var tailscaleFunnelEnabled = false
    @AppStorage(AppConstants.UserDefaultsKeys.authenticationMode, store: appDefaults)
    private var authModeString = AppConstants.Defaults.authenticationMode
    @Environment(TailscaleServeStatusService.self)
    private var tailscaleServeStatus

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "TailscaleIntegrationSection")

    var body: some View {
        Section {
            SettingRow("Status") {
                StatusBadge(self.installStatus.text, kind: self.installStatus.kind)
            }

            if !self.tailscaleService.isInstalled {
                SettingRow("Install", caption: "Install Tailscale on this Mac and on your other devices.") {
                    HStack(spacing: DS.Spacing.m) {
                        Button("Setup Guide") { self.tailscaleService.openSetupGuide() }
                        Button("Direct Download") { self.tailscaleService.openDownloadPage() }
                        Button(String("App Store")) { self.tailscaleService.openAppStore() }
                    }
                    .buttonStyle(.dsText)
                }
            } else {
                ToggleRow(
                    "Serve Over Tailscale",
                    caption: "HTTPS on your tailnet, signed in with your Tailscale identity.",
                    isOn: self.$tailscaleServeEnabled)
                    .onChange(of: self.tailscaleServeEnabled) { _, newValue in
                        self.logger.info("Tailscale integration \(newValue ? "enabled" : "disabled")")
                        Task { await self.serverManager.restart() }
                    }

                if self.tailscaleServeEnabled {
                    Picker("Access", selection: self.$tailscaleFunnelEnabled) {
                        Text("Private (Tailnet)").tag(false)
                        Text("Public (Internet)").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: self.tailscaleFunnelEnabled) { _, newValue in
                        self.applyFunnelMode(newValue)
                    }

                    if self.tailscaleFunnelEnabled {
                        PublicAccessCallout()
                    }
                }

                if self.tailscaleService.isRunning {
                    self.runningContent
                } else {
                    if self.tailscaleServeEnabled {
                        CalloutBox("Serve starts automatically when Tailscale is running.")
                    }
                    if self.tailscaleService.hasGUIApp {
                        SettingRow("Tailscale Isn't Running") {
                            Button("Start Tailscale") { self.tailscaleService.openTailscaleApp() }
                        }
                    } else {
                        Text("Start Tailscale with your system service manager, then come back here.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            Text(verbatim: "Tailscale")
        } footer: {
            if self.tailscaleServeEnabled, self.tailscaleFunnelEnabled {
                Text("Reach Untether from any browser, also from devices outside your tailnet.")
            } else {
                Text("Reach Untether from your phone, tablet or laptop without exposing it to the internet.")
            }
        }
        .task {
            // Initial check; ongoing updates come from TailscaleServeStatusService
            await self.tailscaleService.checkTailscaleStatus()
        }
    }

    private var installStatus: (text: String, kind: StatusKind) {
        if !self.tailscaleService.isInstalled {
            return (String(localized: "Not installed", comment: "Settings, Remote Access: Tailscale status"), .inactive)
        }
        return self.tailscaleService.isRunning
            ? (String(localized: "tailscale.state.running", defaultValue: "Running", comment: "Settings, Remote Access: Tailscale status"), .ok)
            : (String(localized: "Not running", comment: "Settings, Remote Access: Tailscale status"), .warning)
    }

    @ViewBuilder
    private var runningContent: some View {
        if self.tailscaleServeEnabled {
            SettingRow("Serve Status") {
                self.serveStatusBadge
            }
            self.serveProblem
        }

        if let hostname = tailscaleService.tailscaleHostname {
            self.urls(hostname: hostname)

            if self.accessMode == .localhost, !self.serveInEffect {
                CalloutBox(
                    "The server only listens on this Mac. Turn on Serve, or set Access Mode to Network in Server.",
                    kind: .warning)
            }
        }
    }

    private var actualIsPublic: Bool {
        self.tailscaleServeStatus.actualMode == "public"
    }

    private var modeMismatch: Bool {
        self.tailscaleServeStatus.isRunning && self.tailscaleFunnelEnabled != self.actualIsPublic
    }

    @ViewBuilder
    private var serveStatusBadge: some View {
        // 2026-10-20: with sign-in None the server never starts Serve, so the badge said
        // "Starting…" forever.
        if self.authModeString == AuthenticationMode.none.rawValue {
            StatusBadge("Off: sign-in is None", kind: .info)
        } else if self.tailscaleServeStatus.isLoading {
            StatusBadge("Checking…", kind: .progress)
        } else if self.tailscaleServeStatus.isRunning {
            StatusBadge(
                self.actualIsPublic ? "Public (Funnel)" : "Private (Serve)",
                kind: self.modeMismatch ? .warning : .ok)
        } else if self.tailscaleServeStatus.isPermanentlyDisabled {
            StatusBadge("Unavailable", kind: .warning)
        } else if self.tailscaleServeStatus.lastError != nil {
            StatusBadge("Error", kind: .error)
        } else {
            StatusBadge("Starting…", kind: .progress)
        }
    }

    @ViewBuilder
    private var serveProblem: some View {
        if self.modeMismatch {
            CalloutBox(kind: self.tailscaleServeStatus.funnelError == nil ? .progress : .warning) {
                if let funnelError = tailscaleServeStatus.funnelError {
                    Text("Funnel failed: \(funnelError)")
                } else {
                    if self.tailscaleFunnelEnabled {
                        Text("Switching to public access…", comment: "Settings, Remote Access: Tailscale is changing mode")
                    } else {
                        Text("Switching to private access…", comment: "Settings, Remote Access: Tailscale is changing mode")
                    }
                }
                // Only offer a retry for a real error, not a temporary mismatch
                if self.tailscaleServeStatus.lastError != nil {
                    Button("Retry", action: self.retryConfiguration)
                        .buttonStyle(.dsText)
                }
            }
        } else if !self.tailscaleServeStatus.isRunning, !self.tailscaleServeStatus.isLoading,
                  let error = tailscaleServeStatus.lastError
        {
            CalloutBox(error, kind: .error)
        } else if self.serveInEffect, self.tailscaleServeStatus.isPermanentlyDisabled {
            // 2026-11-11: this said "Direct on port N" while, behind Serve, the server only
            // listens on this Mac.
            CalloutBox(
                "Tailscale Serve cannot start on this tailnet, and with Serve on the server only listens on this Mac. Turn Serve off to reach it through the access mode in Server.",
                kind: .warning)
        }
    }

    /// Serve as the server runs it: off with sign-in None (ServerNetworkPolicy).
    private var serveInEffect: Bool {
        self.tailscaleServeEnabled && self.authModeString != AuthenticationMode.none.rawValue
    }

    @ViewBuilder
    private func urls(hostname: String) -> some View {
        let address = TailscaleURLHelper.address(
            hostname: hostname,
            port: self.serverPort,
            serveEnabled: self.serveInEffect,
            serveRunning: self.tailscaleServeStatus.isRunning,
            serverOnLoopback: ServerNetworkPolicy.isLoopback(self.serverManager.listeningAddress.value))

        if let url = address.url {
            InlineClickableURLView(
                label: self.tailscaleServeStatus.isRunning && self.actualIsPublic ? "Public URL" : "Address",
                url: url.absoluteString)
        } else if self.serveInEffect, !self.tailscaleServeStatus.isPermanentlyDisabled,
                  self.tailscaleServeStatus.lastError == nil
        {
            SettingRow("Address") {
                StatusBadge("Configuring…", kind: .progress)
            }
        }
    }

    private func applyFunnelMode(_ isPublic: Bool) {
        self.logger.warning("Tailscale access mode: \(isPublic ? "PUBLIC" : "PRIVATE")")
        // Force immediate UserDefaults synchronization
        appDefaults.set(isPublic, forKey: AppConstants.UserDefaultsKeys.tailscaleFunnelEnabled)
        appDefaults.synchronize()
        Task {
            await self.serverManager.restart()
            // Give server time to apply new configuration
            try? await Task.sleep(for: .seconds(1.5))
            await self.tailscaleServeStatus.refreshStatusImmediately()
        }
    }

    private func retryConfiguration() {
        self.logger.info("Retrying Tailscale configuration due to mismatch")
        Task {
            await self.tailscaleServeStatus.refreshStatusImmediately()
            if let desired = tailscaleServeStatus.desiredMode,
               let actual = tailscaleServeStatus.actualMode,
               desired != actual
            {
                self.logger.info("Mismatch persists after refresh, restarting server")
                await self.serverManager.restart()
            }
        }
    }
}

// MARK: - ngrok Integration Section

private struct NgrokIntegrationSection: View {
    @Binding var ngrokEnabled: Bool
    @Binding var ngrokAuthToken: String
    @Binding var isTokenRevealed: Bool
    @Binding var maskedToken: String
    @Binding var ngrokTokenPresent: Bool
    @Binding var ngrokStatus: NgrokTunnelStatus?
    @Binding var isStartingNgrok: Bool
    @Binding var ngrokError: String?
    let toggleTokenVisibility: () -> Void
    let checkAndStartNgrok: () -> Void
    let stopNgrok: () -> Void
    let ngrokService: NgrokService
    let logger: Logger

    var body: some View {
        Section {
            ToggleRow(title: Text("Tunnel", comment: "Settings, Remote Access: tunnel on/off"), caption: Text(self.statusCaption), isOn: self.$ngrokEnabled)
                .disabled(self.isStartingNgrok)
                .onChange(of: self.ngrokEnabled) { _, newValue in
                    if newValue {
                        self.checkAndStartNgrok()
                    } else {
                        self.stopNgrok()
                    }
                }

            AuthTokenField(
                ngrokAuthToken: self.$ngrokAuthToken,
                isTokenRevealed: self.$isTokenRevealed,
                maskedToken: self.$maskedToken,
                ngrokTokenPresent: self.$ngrokTokenPresent,
                toggleTokenVisibility: self.toggleTokenVisibility,
                ngrokService: self.ngrokService,
                logger: self.logger)

            if let status = ngrokStatus {
                InlineClickableURLView(label: "Public URL", url: status.publicUrl)
            }

            PublicAccessCallout()

            if let error = ngrokError {
                CalloutBox(error, kind: .error)
            }

            SettingRow("Account", caption: "The auth token comes from your ngrok account.") {
                Button("Create a Free Account") {
                    if let url = URL(string: "https://dashboard.ngrok.com/signup") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.dsText)
            }
        } header: {
            Text(verbatim: "ngrok")
        }
        .task {
            // Show a tunnel that is already running when Settings is reopened
            self.ngrokStatus = await self.ngrokService.getStatus()
        }
    }

    private var statusCaption: String {
        if self.isStartingNgrok {
            return String(localized: "Starting…", comment: "Settings, Remote Access: ngrok tunnel caption")
        }
        return self.ngrokStatus != nil
            ? String(localized: "Connected.", comment: "Settings, Remote Access: ngrok tunnel caption")
            : String(localized: "Not connected.", comment: "Settings, Remote Access: ngrok tunnel caption")
    }
}

// MARK: - Auth Token Field

private struct AuthTokenField: View {
    @Binding var ngrokAuthToken: String
    @Binding var isTokenRevealed: Bool
    @Binding var maskedToken: String
    @Binding var ngrokTokenPresent: Bool
    let toggleTokenVisibility: () -> Void
    let ngrokService: NgrokService
    let logger: Logger

    @FocusState private var isTokenFieldFocused: Bool
    @State private var tokenSaveError: String?

    var body: some View {
        LabeledContent("Auth Token") {
            HStack(spacing: DS.Spacing.s) {
                if self.isTokenRevealed {
                    TextField("Auth Token", text: self.$ngrokAuthToken, prompt: Text("Paste your auth token"))
                        .labelsHidden()
                        .frame(minWidth: 180)
                        .textFieldStyle(.roundedBorder)
                        .focused(self.$isTokenFieldFocused)
                        .onSubmit {
                            self.saveToken()
                        }
                } else {
                    TextField("Auth Token", text: self.$maskedToken, prompt: Text("Not set"))
                        .labelsHidden()
                        .frame(minWidth: 180)
                        .textFieldStyle(.roundedBorder)
                        .disabled(true)
                        .foregroundStyle(.secondary)
                }

                Button(action: self.toggleTokenVisibility) {
                    Label(
                        self.isTokenRevealed ? "Hide Token" : "Show Token",
                        systemImage: self.isTokenRevealed ? "eye.slash" : "eye")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help(self.isTokenRevealed ? "Hide the token" : "Show the token")

                if self.isTokenRevealed, self.ngrokAuthToken != self.ngrokService.authToken || !self.ngrokTokenPresent {
                    Button("Save") {
                        self.saveToken()
                    }
                }
            }
        }

        if let error = tokenSaveError {
            CalloutBox(error, kind: .error)
        }
    }

    private func saveToken() {
        guard !self.ngrokAuthToken.isEmpty else {
            self.tokenSaveError = String(localized: "Enter a token first.", comment: "Settings, Remote Access: ngrok token error")
            return
        }

        self.ngrokService.authToken = self.ngrokAuthToken
        if self.ngrokService.authToken != nil {
            self.ngrokTokenPresent = true
            self.tokenSaveError = nil
            self.isTokenRevealed = false
            self.maskedToken = String(repeating: "•", count: 12)
            self.logger.info("ngrok auth token saved successfully")
        } else {
            self.tokenSaveError = String(localized: "Couldn't save the token to the Keychain.", comment: "Settings, Remote Access: ngrok token error")
            self.logger.error("Failed to save ngrok auth token to keychain")
        }
    }
}

// MARK: - Public Access Note

/// The one warning every public tunnel shows (Tailscale Funnel, Cloudflare, Pinggy, ngrok).
struct PublicAccessCallout: View {
    var body: some View {
        CalloutBox("Anyone with the link can reach your sign-in page from the internet.", kind: .warning)
    }
}

// MARK: - Previews

#Preview("Remote Access Settings") {
    RemoteAccessSettingsView()
        .frame(width: 600, height: 680)
        .environment(SystemPermissionManager.shared)
}
