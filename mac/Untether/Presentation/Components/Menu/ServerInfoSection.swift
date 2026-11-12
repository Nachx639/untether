import AppKit
import SwiftUI

// MARK: - Server Info Header

/// Header of the menu: the brand row (app icon, name, a DEV/DEBUG tag, a one-line summary of
/// the sessions) with the server status as a dot and a word, then the addresses the dashboard
/// is reachable at as compact chips (click copies, the arrow opens).
struct ServerInfoHeader: View {
    @Environment(ServerManager.self)
    var serverManager
    @Environment(SessionMonitor.self)
    var sessionMonitor
    @Environment(NgrokService.self)
    var ngrokService
    @Environment(TailscaleService.self)
    var tailscaleService
    @Environment(TailscaleServeStatusService.self)
    var tailscaleServeStatus

    @AppStorage(AppConstants.UserDefaultsKeys.tailscaleServeEnabled, store: appDefaults)
    private var serveSetting = false

    private var isTailscaleServeEnabled: Bool {
        self.serveSetting && !self.signInIsNone
    }
    @AppStorage(AppConstants.UserDefaultsKeys.tailscaleFunnelEnabled, store: appDefaults)
    private var funnelSetting = false
    @AppStorage(AppConstants.UserDefaultsKeys.authenticationMode, store: appDefaults)
    private var authModeString = AppConstants.Defaults.authenticationMode

    // 2026-10-20: with sign-in None the server never starts Tailscale Serve/Funnel
    // (ServerNetworkPolicy), but the chip read the raw settings and said "Starting…" forever.
    private var isFunnelEnabledInSettings: Bool {
        self.funnelSetting && !self.signInIsNone
    }

    private var signInIsNone: Bool {
        self.authModeString == AuthenticationMode.none.rawValue
    }

    /// Read once when the menu opens, not on every redraw.
    @State private var developmentStatus: (debugMode: Bool, useDevServer: Bool) = (false, false)

    private var developmentTag: String? {
        if self.developmentStatus.useDevServer, self.serverManager.isRunning { return "DEV" }
        if self.developmentStatus.debugMode { return "DEBUG" }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Image(nsImage: NSApplication.shared.applicationIconImage ?? NSImage())
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 30, height: 30)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(verbatim: "Untether")
                            .font(.headline)
                        if let tag = developmentTag {
                            DevelopmentTag(text: tag)
                        }
                    }
                    MenuSessionSummary(
                        displays: self.sessionMonitor.displays,
                        isServerRunning: self.serverManager.isRunning,
                        isLoading: !self.sessionMonitor.hasLoaded && self.sessionMonitor.displays.isEmpty)
                }
                .accessibilityElement(children: .combine)

                Spacer(minLength: 8)

                // Starting the server is the empty state's job, so the badge only reports.
                ServerStatusBadge(
                    isRunning: self.serverManager.isRunning,
                    isStarting: self.serverManager.isRestarting,
                    hasError: self.serverManager.lastError != nil)
            }

            if self.serverManager.isRunning {
                HStack(spacing: 6) {
                    AddressChip(
                        icon: "desktopcomputer",
                        label: String(localized: "Local", comment: "Menu bar: address chip for this Mac's own address"),
                        address: self.serverManager.dashboardEndpoint,
                        url: self.serverManager.dashboardURL())

                    if self.tailscaleService.isRunning, let hostname = tailscaleService.tailscaleHostname {
                        self.tailscaleChip(hostname: hostname)
                    }

                    if self.ngrokService.isActive, let publicURL = ngrokService.publicUrl {
                        AddressChip(icon: "network", label: "ngrok", address: publicURL, url: URL(string: publicURL))
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .onAppear {
            self.developmentStatus = AppConstants.getDevelopmentStatus()
        }
    }

    private func tailscaleChip(hostname: String) -> some View {
        let serveRunning = self.tailscaleServeStatus.isRunning
        let funnelRunning = self.isFunnelEnabledInSettings && serveRunning && self.tailscaleServeStatus.funnelEnabled

        let state: String = if self.signInIsNone, self.serveSetting {
            String(
                localized: "Off (sign-in is None)",
                comment: "Menu bar: Tailscale address tooltip when Serve is off because the sign-in method is None")
        } else if self.isFunnelEnabledInSettings, !funnelRunning {
            if self.tailscaleServeStatus.funnelError != nil {
                String(localized: "Funnel error", comment: "Menu bar: Tailscale address tooltip. Funnel is a Tailscale feature name")
            } else if !serveRunning {
                String(localized: "Starting…", comment: "Menu bar: Tailscale address tooltip while it starts")
            } else {
                String(
                    localized: "Private (Funnel failed)",
                    comment: "Menu bar: Tailscale address tooltip. Funnel is a Tailscale feature name")
            }
        } else if funnelRunning {
            String(localized: "Public (Funnel)", comment: "Menu bar: Tailscale address tooltip. Funnel is a Tailscale feature name")
        } else if self.isTailscaleServeEnabled, serveRunning {
            String(localized: "Private (Serve)", comment: "Menu bar: Tailscale address tooltip. Serve is a Tailscale feature name")
        } else if self.isTailscaleServeEnabled {
            String(localized: "Starting…", comment: "Menu bar: Tailscale address tooltip while it starts")
        } else {
            String(localized: "Tailnet", comment: "Menu bar: Tailscale address tooltip. Tailnet is Tailscale's name for your private network")
        }

        let address = TailscaleURLHelper.address(
            hostname: hostname,
            port: self.serverManager.port,
            serveEnabled: self.isTailscaleServeEnabled,
            serveRunning: serveRunning,
            serverOnLoopback: ServerNetworkPolicy.isLoopback(self.serverManager.listeningAddress.value))

        return AddressChip(
            icon: funnelRunning ? "globe" : "point.3.filled.connected.trianglepath.dotted",
            label: "Tailscale",
            address: address.display,
            url: address.url,
            detail: state)
    }
}

/// "DEV" / "DEBUG": a quiet outlined tag, informative rather than alarming.
private struct DevelopmentTag: View {
    let text: String

    var body: some View {
        Text(verbatim: self.text)
            .font(.caption2.weight(.semibold))
            .tracking(0.4)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .overlay(Capsule().strokeBorder(MenuStyles.hairline, lineWidth: 1))
            .help(
                self.text == "DEV"
                    ? Text("Running the development server (pnpm run dev)", comment: "Menu bar: tooltip of the DEV tag")
                    : Text("Debug build", comment: "Menu bar: tooltip of the DEBUG tag"))
            .accessibilityLabel(
                self.text == "DEV"
                    ? Text("Development server", comment: "VoiceOver: the DEV tag")
                    : Text("Debug build", comment: "Menu bar: tooltip of the DEBUG tag"))
    }
}

/// "2 need you · 1 working · 3 idle" under the app name.
struct MenuSessionSummary: View {
    let displays: [SessionDisplay]
    let isServerRunning: Bool
    /// First fetch still running: "No sessions" would contradict the list's spinner.
    var isLoading = false

    var body: some View {
        let summary = Self.parts(for: self.displays)
        Group {
            if !self.isServerRunning {
                Text("Server stopped", comment: "Menu bar: session summary under the app name when the server is off")
            } else if self.isLoading {
                Text("Connecting…", comment: "Menu bar: session summary while the first fetch runs")
            } else if summary.isEmpty {
                Text("No sessions", comment: "Menu bar: session summary when there are none")
            } else {
                summary.enumerated().reduce(Text(verbatim: "")) { text, item in
                    let piece = Text(item.element.text)
                        .foregroundStyle(item.element.isUrgent ? AnyShapeStyle(MenuStyles.needsYou) : AnyShapeStyle(.secondary))
                        .fontWeight(item.element.isUrgent ? .semibold : .regular)
                    return item.offset == 0 ? piece : text + Text(verbatim: " · ").foregroundStyle(.tertiary) + piece
                }
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        // Two lines: in fr/pt-BR/es the four counts plus the status badge don't fit on one.
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
    }

    struct Part: Equatable {
        let text: String
        let isUrgent: Bool
    }

    /// The non-zero counts in section order: needs you, working, idle, other, suspended.
    static func parts(for displays: [SessionDisplay]) -> [Part] {
        let counts = Dictionary(grouping: displays) { SessionSectionKind(session: $0) }.mapValues(\.count)
        return SessionSectionKind.allCases.compactMap { kind in
            guard let count = counts[kind], count > 0 else { return nil }
            let text = switch kind {
            case .needsYou:
                String(localized: "\(count) need you", comment: "Menu bar summary: sessions waiting on the user (plural)")
            case .working:
                String(localized: "\(count) working", comment: "Menu bar summary: sessions whose agent is working (plural)")
            case .idle:
                String(localized: "\(count) idle", comment: "Menu bar summary: idle sessions (plural)")
            case .terminals:
                String(localized: "\(count) other", comment: "Menu bar summary: plain terminals without an agent (plural)")
            case .suspended:
                String(localized: "\(count) suspended", comment: "Menu bar summary: sessions paused to free memory (plural)")
            }
            return Part(text: text, isUrgent: kind == .needsYou)
        }
    }
}

/// Short forms of the dashboard's addresses for the chips; the full one is in the tooltip.
enum MenuAddress {
    /// "my-mac.example.ts.net:4020" → "my-mac:4020", "https://my-mac.example.ts.net" →
    /// "my-mac", "https://ab12.ngrok-free.app" → "ab12.ngrok-free.app"; IP addresses and
    /// "localhost" stay as they are.
    static func short(_ address: String) -> String {
        var rest = Substring(address.trimmingCharacters(in: .whitespacesAndNewlines))
        if let scheme = rest.range(of: "://") { rest = rest[scheme.upperBound...] }
        if let slash = rest.firstIndex(of: "/") { rest = rest[..<slash] }
        var host = String(rest)
        var port = ""
        if let colon = host.lastIndex(of: ":") {
            let candidate = host[host.index(after: colon)...]
            if !candidate.isEmpty, candidate.allSatisfy(\.isNumber) {
                port = ":" + candidate
                host = String(host[..<colon])
            }
        }
        let labels = host.split(separator: ".")
        let isIPv4 = labels.count == 4 && labels.allSatisfy { Int($0).map { (0...255).contains($0) } ?? false }
        if !isIPv4, host.hasSuffix(".ts.net"), let first = labels.first {
            host = String(first)
        }
        return host + port
    }
}

/// A compact address chip: click copies the address (it says "Copied" for a moment), the
/// arrow that appears on hover opens it in the browser.
struct AddressChip: View {
    let icon: String
    let label: String
    let address: String
    let url: URL?
    /// Extra state for the tooltip ("Private (Serve)").
    var detail: String?

    @State private var isHovered = false
    @State private var showCopiedFeedback = false
    @Environment(\.accessibilityReduceMotion)
    private var reduceMotion

    private var fullAddress: String {
        self.url?.absoluteString ?? self.address
    }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: self.copyToClipboard) {
                HStack(spacing: 4) {
                    Image(systemName: self.showCopiedFeedback ? "checkmark" : self.icon)
                        .imageScale(.small)
                        .foregroundStyle(self.showCopiedFeedback ? AnyShapeStyle(.green) : AnyShapeStyle(.secondary))
                        .frame(width: 14)
                    Text(
                        self.showCopiedFeedback
                            ? String(localized: "Copied", comment: "Copy button state after copying")
                            : MenuAddress.short(self.address))
                        .font(.caption.monospaced())
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .padding(.leading, 7)
                .padding(.trailing, self.isHovered ? 2 : 8)
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(self.helpText)
            .accessibilityLabel(Text(
                "\(self.label) address \(self.address)",
                comment: "VoiceOver: address chip. First: kind (Local, Tailscale, ngrok), second: the address"))
            .accessibilityHint(Text("Copies the address", comment: "VoiceOver hint: address chip"))
            .accessibilityAction(named: Text("Open in Browser", comment: "VoiceOver action: open an address or session in the web browser"), self.openURL)

            if self.isHovered, self.url != nil {
                Button(action: self.openURL) {
                    Image(systemName: "arrow.up.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(Text("Open in the browser", comment: "Menu bar: tooltip of the arrow that opens an address"))
                .accessibilityHidden(true)
                .padding(.trailing, 3)
                .transition(.opacity)
            }
        }
        .background(Capsule().fill(self.isHovered ? MenuStyles.chipFillHovered : MenuStyles.chipFill))
        .overlay(Capsule().strokeBorder(MenuStyles.hairline.opacity(0.6), lineWidth: 0.5))
        .onHover { self.isHovered = $0 }
        .animation(MenuStyles.animation(reduceMotion: self.reduceMotion), value: self.isHovered)
        .animation(MenuStyles.animation(reduceMotion: self.reduceMotion), value: self.showCopiedFeedback)
        .contextMenu {
            Button(String(
                localized: "Open \(self.label) Address",
                comment: "Context menu: open an address. Placeholder: Local, Tailscale or ngrok"), action: self.openURL)
            Button(String(
                localized: "Copy \(self.label) Address",
                comment: "Context menu: copy an address. Placeholder: Local, Tailscale or ngrok"), action: self.copyToClipboard)
        }
    }

    private var helpText: String {
        var text = "\(self.label): \(self.fullAddress)"
        if let detail { text += " · \(detail)" }
        return text + "\n" + String(localized: "Click to copy", comment: "Menu bar: last line of an address chip tooltip")
    }

    private func openURL() {
        if let url { NSWorkspace.shared.open(url) }
    }

    private func copyToClipboard() {
        let pasteboard = appPasteboard
        pasteboard.clearContents()
        pasteboard.setString(self.fullAddress, forType: .string)
        self.showCopiedFeedback = true
        NSAccessibility.post(
            element: NSApp as Any,
            notification: .announcementRequested,
            userInfo: [
                .announcement: String(localized: "Copied", comment: "Copy button state after copying"),
                .priority: NSAccessibilityPriorityLevel.medium.rawValue])
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.4))
            self.showCopiedFeedback = false
        }
    }
}

/// Server status: a dot and "Running" / "Starting…" / "Stopped" in quiet text. Red only for a
/// failure; a server the user stopped is a normal state (gray), and starting stays neutral so it
/// doesn't read like the orange "working" color.
struct ServerStatusBadge: View {
    let isRunning: Bool
    var isStarting = false
    /// The last start failed or the server crashed.
    var hasError = false

    private var dotColor: Color {
        if self.isRunning { return .green }
        if self.isStarting { return Color.secondary.opacity(0.6) }
        return self.hasError ? .red : .secondary
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.dotColor)
                .frame(width: 7, height: 7)
                .overlay(Circle().strokeBorder(Color.primary.opacity(0.15), lineWidth: 0.5))
            self.statusText
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .help(
            self.isRunning
                ? Text("Server is running", comment: "Menu bar: server status tooltip")
                : Text("Server is stopped", comment: "Menu bar: server status tooltip"))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(self.accessibilityText)
    }

    private var statusText: Text {
        if self.isRunning { return Text(String(localized: "server.state.running", defaultValue: "Running", comment: "Server status word, in the menu bar and Settings")) }
        if self.isStarting { return Text(String(localized: "server.state.starting", defaultValue: "Starting…", comment: "Server status word, in the menu bar and Settings")) }
        return Text(String(localized: "server.state.stopped", defaultValue: "Stopped", comment: "Server status word, in the menu bar and Settings"))
    }

    private var accessibilityText: Text {
        if self.isRunning { return Text("Server running", comment: "VoiceOver: server status") }
        if self.isStarting { return Text("Server starting", comment: "VoiceOver: server status") }
        return Text("Server stopped", comment: "VoiceOver: server status")
    }
}
