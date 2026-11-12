import os.log
import SwiftUI

/// CloudflareIntegrationSection displays Cloudflare tunnel status and management controls
/// Following the same pattern as TailscaleIntegrationSection
struct CloudflareIntegrationSection: View {
    let cloudflareService: CloudflareService
    let serverPort: String
    let accessMode: DashboardAccessMode

    @State private var statusCheckTimer: Timer?
    @State private var toggleTimeoutTimer: Timer?
    @State private var isTogglingTunnel = false
    @State private var tunnelEnabled = false

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "CloudflareIntegrationSection")

    // MARK: - Constants

    private let statusCheckInterval: TimeInterval = 10.0 // seconds
    private let startTimeoutInterval: TimeInterval = 15.0 // seconds
    private let stopTimeoutInterval: TimeInterval = 10.0 // seconds

    var body: some View {
        Section {
            SettingRow("Status", caption: "Uses the cloudflared command line tool.") {
                StatusBadge(self.statusText, kind: self.statusKind)
            }

            if !self.cloudflareService.isInstalled {
                SettingRow("Install", caption: "Install cloudflared, then come back here.") {
                    HStack(spacing: DS.Spacing.m) {
                        Button("Setup Guide") { self.cloudflareService.openSetupGuide() }
                        Button("Direct Download") { self.cloudflareService.openDownloadPage() }
                        Button(String("Homebrew")) { self.cloudflareService.openHomebrewInstall() }
                    }
                    .buttonStyle(.dsText)
                }
            } else {
                ToggleRow(
                    "Quick Tunnel",
                    caption: self.isTogglingTunnel ? "Working…" : "A new random public URL each time.",
                    isOn: self.$tunnelEnabled)
                    .disabled(self.isTogglingTunnel)
                    .onChange(of: self.tunnelEnabled) { _, newValue in
                        switch TunnelToggleAction.resolve(
                            switchIsOn: newValue,
                            serviceIsRunning: self.cloudflareService.isRunning)
                        {
                        case .start: self.startTunnel()
                        case .stop: self.stopTunnel()
                        case .none: break
                        }
                    }

                if let publicUrl = cloudflareService.publicUrl, !publicUrl.isEmpty {
                    ClickableURLView(label: "Public URL", url: publicUrl)
                }

                PublicAccessCallout()

                // Only show errors while the tunnel is on or changing
                if self.tunnelEnabled || self.isTogglingTunnel,
                   let error = cloudflareService.statusError, !error.isEmpty
                {
                    CalloutBox(error, kind: .error)
                }
            }
        } header: {
            Text(verbatim: "Cloudflare")
        }
        .task {
            // Reset any stuck toggling state first
            if self.isTogglingTunnel {
                self.logger.warning("CloudflareIntegrationSection: Found stuck isTogglingTunnel state, resetting")
                self.isTogglingTunnel = false
            }

            // Check status when view appears
            self.logger
                .info(
                    "CloudflareIntegrationSection: Starting initial status check, isTogglingTunnel: \(self.isTogglingTunnel)")
            await self.cloudflareService.checkCloudflaredStatus()
            await self.syncUIWithService()

            // Set up timer for automatic updates
            self.statusCheckTimer = Timer
                .scheduledTimer(withTimeInterval: self.statusCheckInterval, repeats: true) { _ in
                    Task { @MainActor in
                        self.logger
                            .debug(
                                "CloudflareIntegrationSection: Running periodic status check, isTogglingTunnel: \(self.isTogglingTunnel)")
                        // Only check if we're not currently toggling
                        if !self.isTogglingTunnel {
                            await self.cloudflareService.checkCloudflaredStatus()
                            await self.syncUIWithService()
                        } else {
                            self.logger.debug("CloudflareIntegrationSection: Skipping periodic check while toggling")
                        }
                    }
                }
        }
        .onDisappear {
            // Clean up timers when view disappears
            self.statusCheckTimer?.invalidate()
            self.statusCheckTimer = nil
            self.toggleTimeoutTimer?.invalidate()
            self.toggleTimeoutTimer = nil
            self.logger.info("CloudflareIntegrationSection: Stopped timers")
        }
    }

    // MARK: - Private Methods

    private func syncUIWithService() async {
        await MainActor.run {
            let wasEnabled = self.tunnelEnabled
            let oldUrl = self.cloudflareService.publicUrl

            self.tunnelEnabled = self.cloudflareService.isRunning

            if wasEnabled != self.tunnelEnabled {
                self.logger
                    .info(
                        "CloudflareIntegrationSection: Tunnel enabled changed: \(wasEnabled) -> \(self.tunnelEnabled)")
            }

            if oldUrl != self.cloudflareService.publicUrl {
                self.logger
                    .info(
                        "CloudflareIntegrationSection: URL changed: \(oldUrl ?? "nil") -> \(self.cloudflareService.publicUrl ?? "nil")")
            }

            self.logger
                .info(
                    "CloudflareIntegrationSection: Synced UI - isRunning: \(self.cloudflareService.isRunning), publicUrl: \(self.cloudflareService.publicUrl ?? "nil")")
        }
    }

    private func startTunnel() {
        guard !self.isTogglingTunnel else {
            self.logger.warning("Already toggling tunnel, ignoring start request")
            return
        }

        self.isTogglingTunnel = true
        self.logger.info("Starting Cloudflare Quick Tunnel on port \(self.serverPort)")

        // Set up timeout to force reset if stuck
        self.toggleTimeoutTimer?.invalidate()
        self.toggleTimeoutTimer = Timer
            .scheduledTimer(withTimeInterval: self.startTimeoutInterval, repeats: false) { _ in
                Task { @MainActor in
                    if self.isTogglingTunnel {
                        self.logger
                            .error(
                                "CloudflareIntegrationSection: Tunnel start timed out, force resetting isTogglingTunnel")
                        self.isTogglingTunnel = false
                        self.tunnelEnabled = false
                    }
                }
            }

        Task {
            defer {
                // Always reset toggling state and cancel timeout
                Task { @MainActor in
                    toggleTimeoutTimer?.invalidate()
                    toggleTimeoutTimer = nil
                    isTogglingTunnel = false
                    logger.info("CloudflareIntegrationSection: Reset isTogglingTunnel = false")
                }
            }

            do {
                let port = Int(serverPort) ?? 4020
                self.logger.info("Calling startQuickTunnel with port \(port)")
                try await self.cloudflareService.startQuickTunnel(port: port)
                self.logger
                    .info("Cloudflare tunnel started successfully, URL: \(self.cloudflareService.publicUrl ?? "nil")")

                // Sync UI with service state
                await self.syncUIWithService()
            } catch {
                self.logger.error("Failed to start Cloudflare tunnel: \(error)")

                // Reset toggle on failure
                await MainActor.run {
                    self.tunnelEnabled = false
                }
            }
        }
    }

    private func stopTunnel() {
        guard !self.isTogglingTunnel else {
            self.logger.warning("Already toggling tunnel, ignoring stop request")
            return
        }

        self.isTogglingTunnel = true
        self.logger.info("Stopping Cloudflare Quick Tunnel")

        // Set up timeout to force reset if stuck
        self.toggleTimeoutTimer?.invalidate()
        self.toggleTimeoutTimer = Timer
            .scheduledTimer(withTimeInterval: self.stopTimeoutInterval, repeats: false) { _ in
                Task { @MainActor in
                    if self.isTogglingTunnel {
                        self.logger
                            .error(
                                "CloudflareIntegrationSection: Tunnel stop timed out, force resetting isTogglingTunnel")
                        self.isTogglingTunnel = false
                    }
                }
            }

        Task {
            defer {
                // Always reset toggling state and cancel timeout
                Task { @MainActor in
                    toggleTimeoutTimer?.invalidate()
                    toggleTimeoutTimer = nil
                    isTogglingTunnel = false
                    logger.info("CloudflareIntegrationSection: Reset isTogglingTunnel = false after stop")
                }
            }

            await self.cloudflareService.stopQuickTunnel()
            self.logger.info("Cloudflare tunnel stopped")

            // Sync UI with service state
            await self.syncUIWithService()
        }
    }
}

// MARK: - Status

extension CloudflareIntegrationSection {
    private var statusKind: StatusKind {
        if !self.cloudflareService.isInstalled {
            return .inactive
        }
        return self.cloudflareService.isRunning ? .ok : .inactive
    }

    private var statusText: String {
        if !self.cloudflareService.isInstalled {
            return String(localized: "Not installed", comment: "Settings, Remote Access: Cloudflare status")
        }
        return self.cloudflareService.isRunning ? String(localized: "Tunnel running", comment: "Settings, Remote Access: Cloudflare status") : String(localized: "Installed", comment: "Settings, Remote Access: Cloudflare status")
    }
}

// MARK: - Previews

#Preview("Cloudflare Integration - Not Installed") {
    CloudflareIntegrationSection(
        cloudflareService: CloudflareService.shared,
        serverPort: "4020",
        accessMode: .network)
        .frame(width: 500)
        .formStyle(.grouped)
}

#Preview("Cloudflare Integration - Installed") {
    CloudflareIntegrationSection(
        cloudflareService: CloudflareService.shared,
        serverPort: "4020",
        accessMode: .network)
        .frame(width: 500)
        .formStyle(.grouped)
}
