import SwiftUI

/// Placeholder shown in place of the session list.
///
/// Loading (first fetch): a small spinner. Server stopped: offers to start it. No sessions:
/// offers a new session and the dashboard. Filter without matches: says so. Static on purpose
/// (no breathing animation).
struct EmptySessionsView: View {
    /// The type-to-filter query, empty when not filtering.
    let filter: String
    var isLoading = false
    let onNewSession: () -> Void

    @Environment(ServerManager.self)
    var serverManager

    @State private var isStarting = false

    private var isStartingServer: Bool {
        self.isStarting || self.serverManager.isRestarting
    }

    var body: some View {
        Group {
            if !self.filter.isEmpty {
                MenuPlaceholder(
                    symbol: "magnifyingglass",
                    title: "No Matches",
                    message: "No session matches “\(self.filter)”.")
            } else if !self.serverManager.isRunning {
                MenuPlaceholder(
                    symbol: self.isStartingServer ? "bolt.horizontal.circle" : "bolt.slash",
                    title: self.isStartingServer ? "Starting Server…" : "Server Is Stopped",
                    message: "Sessions appear here once the server runs.")
                {
                    Button {
                        self.startServer()
                    } label: {
                        if self.isStartingServer {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Start Server")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.isStartingServer)
                }
            } else if self.isLoading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading sessions…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 28)
                .accessibilityElement(children: .combine)
            } else {
                MenuPlaceholder(
                    symbol: "terminal",
                    title: "No Sessions",
                    message: "Start one here, or run `ut` in any terminal.")
                {
                    HStack(spacing: 12) {
                        Button("New Session", action: self.onNewSession)
                            .buttonStyle(.borderedProminent)
                        Button("Open Dashboard") {
                            if let url = DashboardURLBuilder.dashboardURL(port: serverManager.port) {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.link)
                    }
                }
            }
        }
        .controlSize(.regular)
    }

    private func startServer() {
        self.isStarting = true
        Task {
            await self.serverManager.start()
            await SessionMonitor.shared.refresh()
            self.isStarting = false
        }
    }
}

/// Symbol in a soft circle, a title, one line of explanation and optional actions.
struct MenuPlaceholder<Actions: View>: View {
    let symbol: String
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: self.symbol)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .background(Circle().fill(MenuStyles.chipFill))
                .padding(.bottom, 4)
                .accessibilityHidden(true)
            Text(self.title)
                .font(.headline)
            Text(self.message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            self.actions
                .padding(.top, 8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 26)
        .padding(.horizontal, 24)
        .accessibilityElement(children: .contain)
    }
}

extension MenuPlaceholder where Actions == EmptyView {
    init(symbol: String, title: LocalizedStringKey, message: LocalizedStringKey) {
        self.init(symbol: symbol, title: title, message: message) { EmptyView() }
    }
}
