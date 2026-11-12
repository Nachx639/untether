import AppKit
import os.log
import SwiftUI

// MARK: - Access Mode View

struct AccessModeView: View {
    let accessMode: DashboardAccessMode
    @Binding var accessModeString: String
    let restartServerWithNewBindAddress: (DashboardAccessMode, String?) -> Void

    @AppStorage(AppConstants.UserDefaultsKeys.tailscaleServeEnabled, store: appDefaults)
    private var tailscaleServeEnabled = false
    @AppStorage(AppConstants.UserDefaultsKeys.customBindAddress, store: appDefaults)
    private var customBindAddress = ""
    @AppStorage(AppConstants.UserDefaultsKeys.authenticationMode, store: appDefaults)
    private var authModeString = AppConstants.Defaults.authenticationMode

    @Environment(TailscaleService.self)
    private var tailscaleService
    @Environment(TailscaleServeStatusService.self)
    private var tailscaleServeStatus

    @FocusState private var isCustomAddressFieldFocused: Bool
    @State private var pendingAccessMode: DashboardAccessMode?
    @State private var pendingCustomAddress = ""
    @State private var customAddressError: String?

    var body: some View {
        if self.shouldLockToLocalhost {
            SettingRow("Access Mode", caption: "Locked to this Mac while Tailscale Serve is on.") {
                Label("Localhost", systemImage: "lock.shield.fill")
                    .foregroundStyle(.secondary)
                    .help("Tailscale Serve is on, so the server only listens on this Mac")
            }
        } else {
            Picker(selection: self.accessModeSelection) {
                ForEach(DashboardAccessMode.allCases, id: \.rawValue) { mode in
                    Text(mode.displayName)
                        .tag(mode.rawValue)
                }
            } label: {
                Text("Access Mode")
                Text("Who can reach the server on your network.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .pickerStyle(.menu)
            .dsNeutralTint()
        }

        if self.displayedAccessMode == .custom, !self.shouldLockToLocalhost {
            LabeledContent {
                HStack(spacing: DS.Spacing.s) {
                    TextField("Custom Bind Address", text: self.$pendingCustomAddress, prompt: Text("127.0.0.1 or ::", comment: "Settings, Server: placeholder of the custom bind address. Keep the addresses"))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .frame(minWidth: 180, maxWidth: 220)
                        .focused(self.$isCustomAddressFieldFocused)
                        .onSubmit {
                            self.validateAndApplyCustomAddress()
                        }
                        .onAppear {
                            self.pendingCustomAddress = self.customBindAddress
                        }
                        .onChange(of: self.pendingCustomAddress) { _, _ in
                            self.customAddressError = nil
                        }

                    Button("Apply") {
                        self.validateAndApplyCustomAddress()
                    }
                    .disabled(self.pendingCustomAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } label: {
                Text("Custom Address")
                Text("Use :: to listen on both IPv6 and IPv4.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let customAddressError {
                CalloutBox(customAddressError, kind: .error)
            }
        }

        if self.shouldLockToLocalhost, !(self.tailscaleService.isRunning && self.tailscaleServeStatus.isRunning) {
            CalloutBox(
                "Tailscale Serve is on but not active: until it is, the server is reachable from this Mac only. Turn Serve off in Remote Access to use an access mode.",
                kind: .warning)
        }
    }

    /// The row says what the server is started with (ServerNetworkPolicy): with Serve on it
    /// listens on this Mac only, active or not. 2026-11-11: the lock showed only while Serve
    /// was active, and even then the server was listening on the access mode's address.
    private var shouldLockToLocalhost: Bool {
        self.tailscaleServeEnabled && self.authModeString != AuthenticationMode.none.rawValue
    }

    private var displayedAccessMode: DashboardAccessMode {
        self.pendingAccessMode ?? self.accessMode
    }

    private var accessModeSelection: Binding<String> {
        Binding(
            get: { self.displayedAccessMode.rawValue },
            set: { rawValue in
                guard let mode = DashboardAccessMode(rawValue: rawValue) else {
                    return
                }

                if mode == .custom {
                    self.pendingAccessMode = .custom
                    self.pendingCustomAddress = self.customBindAddress
                    self.customAddressError = nil
                } else {
                    self.pendingAccessMode = nil
                    self.accessModeString = mode.rawValue
                    self.restartServerWithNewBindAddress(mode, nil)
                }
            })
    }

    private func validateAndApplyCustomAddress() {
        let address = self.pendingCustomAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let bindAddress = ServerBindAddress(address) else {
            self.customAddressError = if address.hasPrefix("[") || address.hasSuffix("]") {
                String(localized: "Enter IPv6 addresses without brackets.", comment: "Settings, Server: custom address error")
            } else {
                String(localized: "Enter a valid IPv4 or IPv6 address.", comment: "Settings, Server: custom address error")
            }
            self.isCustomAddressFieldFocused = true
            return
        }

        self.pendingCustomAddress = bindAddress.value
        self.customBindAddress = bindAddress.value
        self.accessModeString = DashboardAccessMode.custom.rawValue
        self.pendingAccessMode = nil
        self.customAddressError = nil
        self.restartServerWithNewBindAddress(.custom, bindAddress.value)
    }
}

// MARK: - Port Configuration View

struct PortConfigurationView: View {
    @Binding var serverPort: String
    let restartServerWithNewPort: (Int) -> Void
    let serverManager: ServerManager

    @FocusState private var isPortFieldFocused: Bool
    @State private var pendingPort: String = ""
    @State private var portError: String?

    var body: some View {
        LabeledContent {
            HStack(spacing: DS.Spacing.xs) {
                TextField("Port", text: self.$pendingPort)
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 72)
                    .multilineTextAlignment(.center)
                    .monospacedDigit()
                    .focused(self.$isPortFieldFocused)
                    .onSubmit {
                        self.validateAndUpdatePort()
                    }
                    .onAppear {
                        self.pendingPort = self.serverPort
                    }
                    .onChange(of: self.pendingPort) { _, newValue in
                        self.portError = nil
                        if newValue.count > 5 {
                            self.pendingPort = String(newValue.prefix(5))
                        }
                    }

                Stepper("Port", value: self.portStepperValue, in: 1024...65535)
                    .labelsHidden()
            }
        } label: {
            Text("Port")
            Text("Changing it restarts the server.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        if let error = portError {
            CalloutBox(error, kind: .error)
        }
    }

    private var portStepperValue: Binding<Int> {
        Binding(
            get: { Int(self.pendingPort) ?? Int(self.serverPort) ?? 4020 },
            set: { newValue in
                self.pendingPort = String(newValue)
                self.validateAndUpdatePort()
            })
    }

    private func validateAndUpdatePort() {
        guard let port = Int(pendingPort) else {
            self.portError = String(localized: "Enter a port number.", comment: "Settings, Server: port error")
            self.pendingPort = self.serverPort
            return
        }

        guard port >= 1024, port <= 65535 else {
            self.portError = String(localized: "Use a port between 1024 and 65535.", comment: "Settings, Server: port error")
            self.pendingPort = self.serverPort
            return
        }

        if String(port) != self.serverPort {
            self.restartServerWithNewPort(port)
            self.serverPort = String(port)
        }
    }
}

// MARK: - Server Configuration Helpers

@MainActor
enum ServerConfigurationHelpers {
    private static let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "ServerConfiguration")

    static func restartServerWithNewPort(_ port: Int, serverManager: ServerManager) async {
        // Update the port in ServerManager and restart
        serverManager.port = String(port)
        await serverManager.restart()
        self.logger.info("Server restarted on port \(port)")

        // Wait for server to be fully ready before restarting session monitor
        try? await Task.sleep(for: .seconds(1))

        // Session monitoring will automatically detect the port change
    }

    static func restartServerWithNewBindAddress(
        accessMode: DashboardAccessMode,
        customAddress: String? = nil,
        serverManager: ServerManager)
        async
    {
        guard serverManager.updateBindConfiguration(mode: accessMode, customAddress: customAddress) else {
            self.logger.error("Rejected invalid bind configuration")
            return
        }

        self.logger
            .info(
                "Restarting server due to access mode change: \(accessMode.displayName) -> \(serverManager.bindAddress)")
        await serverManager.restart()
        self.logger.info("Server restarted with bind address \(serverManager.bindAddress)")

        // Wait for server to be fully ready before restarting session monitor
        try? await Task.sleep(for: .seconds(1))

        // Session monitoring will automatically detect the bind address change
    }

    static func updateLocalIPAddress(accessMode: DashboardAccessMode) async -> String? {
        if accessMode == .network {
            NetworkUtility.getLocalIPAddress()
        } else {
            nil
        }
    }
}
