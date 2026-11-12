import Foundation

/// A provider for generating tooltip strings for the status bar item.
///
/// This component centralizes the logic for creating the detailed tooltip,
/// combining information from various services into a single, formatted string.
enum TooltipProvider {
    /// Generates the tooltip string based on the current state of the application.
    ///
    /// - Parameters:
    ///   - serverManager: The manager for the Untether server.
    ///   - ngrokService: The service for managing ngrok tunnels.
    ///   - tailscaleService: The service for managing Tailscale connectivity.
    ///   - sessionMonitor: The monitor for active terminal sessions.
    /// - Returns: A formatted string to be used as the tooltip for the status bar item.
    @MainActor
    static func generateTooltip(
        serverManager: ServerManager,
        ngrokService: NgrokService,
        tailscaleService: TailscaleService,
        sessionMonitor: SessionMonitor)
        -> String
    {
        var tooltipParts: [String] = []

        // Server status
        if serverManager.isRunning {
            let endpoint = serverManager.dashboardEndpoint
            tooltipParts.append(String(
                localized: "Server: \(endpoint)",
                comment: "Menu bar icon tooltip line. Placeholder: local address"))

            // ngrok status
            if ngrokService.isActive, let publicURL = ngrokService.publicUrl {
                tooltipParts.append("ngrok: \(publicURL)")
            }

            // Tailscale status
            if tailscaleService.isRunning, let hostname = tailscaleService.tailscaleHostname {
                tooltipParts.append("Tailscale: \(hostname)")
            }
        } else {
            tooltipParts.append(String(localized: "Server stopped", comment: "Menu bar icon tooltip line"))
        }

        // Session info
        let sessions = sessionMonitor.sessions.values.filter(\.isRunning)
        if !sessions.isEmpty {
            // Same states and order as the menu: Needs you, Working, Idle, Running (shell)
            var counts: [SessionAgentState: Int] = [:]
            for session in sessions {
                counts[SessionDisplay.state(for: session), default: 0] += 1
            }
            let summary = [SessionAgentState.needsYou, .working, .idle, .shell]
                .compactMap { state -> String? in
                    guard let count = counts[state], count > 0 else { return nil }
                    return Self.stateCount(count, state: state)
                }
                .joined(separator: ", ")
            let total = sessions.count
            tooltipParts.append(String(
                localized: "\(total) sessions: \(summary)",
                comment: "Menu bar icon tooltip line. First: number of sessions (plural), second: counts per state"))
        }

        return tooltipParts.joined(separator: "\n")
    }

    /// "2 working": one count of the tooltip's session summary.
    private static func stateCount(_ count: Int, state: SessionAgentState) -> String {
        switch state {
        case .needsYou:
            String(localized: "tooltip.count.needsYou", defaultValue: "\(count) need you", comment: "Menu bar icon tooltip: sessions waiting on the user (plural)")
        case .working:
            String(localized: "tooltip.count.working", defaultValue: "\(count) working", comment: "Menu bar icon tooltip: sessions whose agent works (plural)")
        case .idle:
            String(localized: "tooltip.count.idle", defaultValue: "\(count) idle", comment: "Menu bar icon tooltip: idle sessions (plural)")
        case .shell:
            String(localized: "tooltip.count.running", defaultValue: "\(count) running", comment: "Menu bar icon tooltip: plain terminals that are running (plural)")
        case .exited:
            String(localized: "tooltip.count.exited", defaultValue: "\(count) exited", comment: "Menu bar icon tooltip: sessions that ended (plural)")
        }
    }
}
