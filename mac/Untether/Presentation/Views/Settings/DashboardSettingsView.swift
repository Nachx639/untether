import os.log
import SwiftUI

/// Server settings tab (the `dashboard` tab): server status, address, remote access summary
/// and active sessions.
struct DashboardSettingsView: View {
    @AppStorage(AppConstants.UserDefaultsKeys.serverPort, store: appDefaults)
    private var serverPort = "4020"
    @AppStorage(AppConstants.UserDefaultsKeys.dashboardAccessMode, store: appDefaults)
    private var accessModeString = AppConstants.Defaults.dashboardAccessMode

    @Environment(ServerManager.self)
    private var serverManager
    @Environment(SessionService.self)
    private var sessionService
    @Environment(SessionMonitor.self)
    private var sessionMonitor
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
    @AppStorage(AppConstants.UserDefaultsKeys.tailscaleServeEnabled, store: appDefaults)
    private var tailscaleServeEnabled = false

    @State private var serverStatus: ServerStatus = .stopped
    @State private var activeSessions: [DashboardSessionInfo] = []

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "DashboardSettings")

    private var accessMode: DashboardAccessMode {
        DashboardAccessMode(rawValue: self.accessModeString) ?? .localhost
    }

    var body: some View {
        Form {
            ServerStatusSection(
                serverStatus: self.serverStatus,
                serverPort: self.$serverPort,
                accessModeString: self.$accessModeString,
                serverManager: self.serverManager)

            RemoteAccessSummarySection(states: RemoteProviderStates(
                tailscale: self.tailscaleService,
                tailscaleServeEnabled: self.tailscaleServeEnabled,
                cloudflare: self.cloudflareService,
                pinggy: self.pinggyService,
                pangolin: self.pangolinService,
                ngrok: self.ngrokService))

            ActiveSessionsSection(activeSessions: self.activeSessions)

            ServerTechnicalSection(serverManager: self.serverManager)
        }
        .formStyle(.grouped)
        .task {
            await self.updateStatuses()
        }
        .onReceive(Timer.publish(every: 15, on: .main, in: .common).autoconnect()) { _ in
            // Reduced frequency to prevent UI flickering
            Task {
                await self.updateStatuses()
            }
        }
    }

    // MARK: - Private Methods

    private func updateStatuses() async {
        // Update server status
        self.serverStatus = self.serverManager.isRunning ? .running : .stopped

        // Update active sessions - filter out zombie and exited sessions
        self.activeSessions = self.sessionMonitor.sessions.values
            .compactMap { session in
                // Only include sessions that are actually running
                guard session.status == "running" else { return nil }

                let tool = SessionDisplay.tool(for: session)
                return DashboardSessionInfo(
                    id: session.id,
                    title: SessionDisplay.title(for: session, tool: tool),
                    createdAt: SessionDisplay.parseDate(session.startedAt) ?? Date(),
                    state: SessionDisplay.state(for: session))
            }
            .sorted { $0.createdAt > $1.createdAt }

        // Refresh remote provider state shown in the summary
        await self.tailscaleService.checkTailscaleStatus()

        // Update Cloudflare status
        await self.cloudflareService.checkCloudflaredStatus()
    }
}

// MARK: - Server Status

private enum ServerStatus: Equatable {
    case running
    case stopped
    case starting
    case error(String)
}

// MARK: - Session Info

private struct DashboardSessionInfo: Identifiable {
    let id: String
    let title: String
    let createdAt: Date
    let state: SessionAgentState
}

// MARK: - Server Configuration Section

private struct ServerStatusSection: View {
    let serverStatus: ServerStatus
    @Binding var serverPort: String
    @Binding var accessModeString: String
    let serverManager: ServerManager

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "ServerStatusSection")

    @State private var portConflict: PortConflict?
    @State private var isCheckingPort = false
    @State private var isShowingKillPortConflictConfirm = false
    @State private var isKillingPortConflictProcess = false
    @State private var killPortConflictErrorMessage: String?

    private var isServerRunning: Bool {
        self.serverStatus == .running
    }

    private var serverPortInt: Int {
        Int(self.serverPort) ?? 4020
    }

    private var accessMode: DashboardAccessMode {
        DashboardAccessMode(rawValue: self.accessModeString) ?? .localhost
    }

    var body: some View {
        Section {
            SettingRow("Status") {
                HStack(spacing: DS.Spacing.s) {
                    self.statusBadge
                    if self.serverStatus == .stopped {
                        Button("Start") {
                            Task { await self.serverManager.start() }
                        }
                        .buttonStyle(.borderedProminent)
                    } else if self.serverStatus == .running {
                        Button("Restart") {
                            Task { await self.serverManager.manualRestart() }
                        }
                    }
                }
            }

            AccessModeView(
                accessMode: self.accessMode,
                accessModeString: self.$accessModeString,
                restartServerWithNewBindAddress: self.restartServerWithNewBindAddress)

            PortConfigurationView(
                serverPort: self.$serverPort,
                restartServerWithNewPort: self.restartServerWithNewPort,
                serverManager: self.serverManager)

            if let conflict = portConflict {
                self.portConflictCallout(conflict)
            }

            if let url = serverManager.dashboardURL() {
                URLRow("Dashboard", url: url, caption: "Open Untether in a browser on this Mac.")
            }
        } header: {
            Text("Server")
        }
        .task {
            await self.checkPortAvailability()
        }
        .task(id: self.serverPort) {
            await self.checkPortAvailability()
        }
        .alert(
            "Failed to Quit Process",
            isPresented: Binding(
                get: { self.killPortConflictErrorMessage != nil },
                set: {
                    if !$0 {
                        self.killPortConflictErrorMessage = nil
                    }
                })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(self.killPortConflictErrorMessage ?? "")
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch self.serverStatus {
        case .running:
            StatusBadge(
                String(localized: "server.state.running", defaultValue: "Running", comment: "Server status word, in the menu bar and Settings"),
                kind: .ok)
        case .stopped:
            StatusBadge(
                String(localized: "server.state.stopped", defaultValue: "Stopped", comment: "Server status word, in the menu bar and Settings"),
                kind: .inactive)
        case .starting:
            StatusBadge(
                String(localized: "server.state.starting", defaultValue: "Starting…", comment: "Server status word, in the menu bar and Settings"),
                kind: .progress)
        case let .error(message):
            StatusBadge(message, kind: .error)
        }
    }

    private func portConflictCallout(_ conflict: PortConflict) -> some View {
        CalloutBox(kind: .warning) {
            Text(
                "Port \(String(conflict.port)) is in use by \(conflict.process.name) (PID \(String(conflict.process.pid))).",
                comment: "Settings, Server: port conflict. First: port, second: process name, third: process ID")

            HStack(spacing: DS.Spacing.s) {
                if !conflict.alternativePorts.isEmpty {
                    Text("Try port:")
                    ForEach(conflict.alternativePorts.prefix(3), id: \.self) { port in
                        Button(String(port)) {
                            Task {
                                await ServerConfigurationHelpers.restartServerWithNewPort(
                                    port,
                                    serverManager: self.serverManager)
                            }
                        }
                        .buttonStyle(.dsText)
                        .monospacedDigit()
                    }
                }
                Spacer()
                Button("Quit Process…", role: .destructive) {
                    self.isShowingKillPortConflictConfirm = true
                }
                .disabled(self.isKillingPortConflictProcess)
            }
        }
        .confirmationDialog(
            Text(
                "Quit \(conflict.process.name) (PID \(String(conflict.process.pid)))?",
                comment: "Settings, Server: confirmation title. First: process name, second: process ID"),
            isPresented: self.$isShowingKillPortConflictConfirm,
            titleVisibility: .visible)
        {
            Button("Quit Process", role: .destructive) {
                Task {
                    await self.killPortConflictProcess(conflict)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "This force-quits the process listening on port \(String(conflict.port)), then starts the server.",
                comment: "Settings, Server: confirmation message. Placeholder: port number")
        }
    }

    private func restartServerWithNewPort(_ port: Int) {
        Task {
            await ServerConfigurationHelpers.restartServerWithNewPort(port, serverManager: self.serverManager)
        }
    }

    private func restartServerWithNewBindAddress(_ mode: DashboardAccessMode, customAddress: String?) {
        Task {
            await ServerConfigurationHelpers.restartServerWithNewBindAddress(
                accessMode: mode,
                customAddress: customAddress,
                serverManager: self.serverManager)
        }
    }

    private func checkPortAvailability() async {
        self.isCheckingPort = true
        defer { isCheckingPort = false }

        let port = self.serverPortInt

        // Only check if it's not the port we're already successfully using
        if self.serverManager.isRunning, Int(self.serverManager.port) == port {
            self.portConflict = nil
            return
        }

        if let conflict = await PortConflictResolver.shared.detectConflict(on: port) {
            // Only show warning for non-Untether processes
            // Untether instances will be auto-killed by ServerManager
            if case .reportExternalApp = conflict.suggestedAction {
                self.portConflict = conflict
            } else {
                // It's our own process, will be handled automatically
                self.portConflict = nil
            }
        } else {
            self.portConflict = nil
        }
    }

    private func killPortConflictProcess(_ conflict: PortConflict) async {
        guard !self.isKillingPortConflictProcess else { return }
        self.isKillingPortConflictProcess = true
        defer { self.isKillingPortConflictProcess = false }

        do {
            try await PortConflictResolver.shared.forceKillProcess(conflict)
            await self.checkPortAvailability()

            if self.serverStatus == .stopped {
                await self.serverManager.start()
            }
        } catch {
            self.logger.error("Failed to kill port-conflicting process: \(String(describing: error))")
            self.killPortConflictErrorMessage = error.localizedDescription.isEmpty ? String(describing: error) : error
                .localizedDescription
        }
    }
}

// MARK: - Active Sessions Section

private struct ActiveSessionsSection: View {
    let activeSessions: [DashboardSessionInfo]

    private let visibleLimit = 5

    var body: some View {
        Section {
            if self.activeSessions.isEmpty {
                Text("No active sessions")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(self.activeSessions.prefix(self.visibleLimit)) { session in
                    LabeledContent {
                        Text(
                            "Started \(DS.Time.ago(session.createdAt))",
                            comment: "Settings, Server: when a session started. Placeholder: relative time such as '5 min ago'")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                            .help(DS.Time.full(session.createdAt))
                    } label: {
                        HStack(spacing: DS.Spacing.s) {
                            SessionStateDot(state: session.state)
                            Text(verbatim: session.title)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }

                if self.activeSessions.count > self.visibleLimit {
                    Text(
                        "And \(self.activeSessions.count - self.visibleLimit) more",
                        comment: "Settings, Server: more sessions than the list shows (plural)")
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            HStack {
                Text("Active Sessions")
                Spacer()
                Text(verbatim: String(self.activeSessions.count))
                    .monospacedDigit()
                    .accessibilityLabel(Text(
                        "\(self.activeSessions.count) active sessions",
                        comment: "VoiceOver: number of active sessions (plural)"))
            }
        }
    }
}

// MARK: - Remote Access Summary Section

private struct RemoteAccessSummarySection: View {
    let states: RemoteProviderStates

    var body: some View {
        let summary = self.states.summary
        Section {
            SettingRow("Status") {
                HStack(spacing: DS.Spacing.s) {
                    StatusBadge(summary.text, kind: summary.kind)
                    Button("Configure…") {
                        SettingsTab.remoteAccess.select()
                    }
                }
            }
            if let url = summary.url, summary.kind == .ok {
                InlineClickableURLView(label: "Address", url: url)
            }
        } header: {
            Text("Remote Access")
        }
    }
}

// MARK: - Technical Details

/// Bind address and process ID: kept for debugging, out of the way.
private struct ServerTechnicalSection: View {
    let serverManager: ServerManager

    var body: some View {
        Section {
            DisclosureGroup("Technical Details") {
                LabeledContent("Bind Address") {
                    Text(verbatim: self.serverManager.bindAddress)
                        .monospacedDigit()
                        .textSelection(.enabled)
                }

                if let pid = serverManager.serverProcessId {
                    LabeledContent("Process ID") {
                        Text(verbatim: String(pid))
                            .monospacedDigit()
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }
}

// MARK: - Previews

#Preview("Dashboard Settings") {
    DashboardSettingsView()
        .frame(width: 600, height: 600)
        .environment(SystemPermissionManager.shared)
}
