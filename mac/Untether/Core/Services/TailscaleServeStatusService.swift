import Foundation
import os.log
import SwiftUI

/// Service to fetch Tailscale Serve status from the server
@MainActor
@Observable
final class TailscaleServeStatusService {
    static let shared = TailscaleServeStatusService()

    var isRunning = false
    var lastError: String?
    var startTime: Date?
    var isLoading = false
    var isPermanentlyDisabled = false
    var funnelEnabled = false
    var funnelStartTime: Date?
    var desiredMode: String?
    var actualMode: String?
    var funnelError: String?

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "TailscaleServeStatus")
    private var updateTimer: Timer?
    private var isCurrentlyFetching = false
    private var lastKnownMode: Bool? // Track the last known Funnel mode to detect switches
    /// Last logged status summary: status is logged only when it changes
    private var lastLoggedStatus: String?

    private init() {
        // Auto-start monitoring if Tailscale is enabled
        let tailscaleEnabled = appDefaults.bool(forKey: AppConstants.UserDefaultsKeys.tailscaleServeEnabled)
        if tailscaleEnabled {
            Task {
                // Initial fetch
                await self.fetchStatus(silent: false)
                // Then start regular monitoring
                self.startMonitoring()
            }
        }
    }

    /// Start polling for status updates
    func startMonitoring() {
        self.logger.debug("Starting Tailscale Serve status monitoring")
        // Check current mode and detect switches
        let currentMode = appDefaults.bool(forKey: AppConstants.UserDefaultsKeys.tailscaleFunnelEnabled)
        let modeChanged = self.lastKnownMode != nil && self.lastKnownMode != currentMode
        self.lastKnownMode = currentMode

        if modeChanged {
            self.logger
                .info(
                    "[TAILSCALE STATUS] Mode switch detected: \(self.lastKnownMode == true ? "Private->Public" : "Public->Private")")
        }

        // Initial fetch - show spinner for initial load
        Task {
            // Small delay to let server start
            try? await Task.sleep(nanoseconds: 1_000_000_000) // 1 second

            // First fetch shows spinner
            await self.fetchStatus(silent: false)

            // Do rapid silent checks to catch up quickly (for any mode switch or startup)
            if self.lastError != nil || !self.isRunning {
                self.logger.info("[TAILSCALE STATUS] Performing rapid status checks")
                for i in 1...5 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000) // Check every 2 seconds
                    self.logger.debug("[TAILSCALE STATUS] Rapid check \(i)/5")
                    await self.fetchStatus(silent: true) // Silent background check
                    // Stop checking if we're now running successfully
                    if self.isRunning, self.lastError == nil {
                        self.logger.info("[TAILSCALE STATUS] Tailscale ready!")
                        break
                    }
                }
            }
        }

        // Set up periodic updates - less aggressive and always silent.
        // Invalidate any previous timer first: calling startMonitoring() again used to leak
        // the old timer, doubling the polling each time.
        self.updateTimer?.invalidate()
        self.updateTimer = Timer.scheduledTimer(withTimeInterval: 10.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.isCurrentlyFetching, !self.isPermanentlyDisabled else {
                    return
                }

                // Check if there's an error or not running (silent check)
                if !self.isRunning || self.lastError != nil {
                    await self.fetchStatus(silent: true)
                }
                // Also do periodic checks even when running (less frequent)
                else if Int.random(in: 0..<3) == 0 { // About every 30 seconds when running OK
                    await self.fetchStatus(silent: true)
                }
            }
        }
    }

    /// Stop polling for status updates
    func stopMonitoring() {
        self.logger.debug("Stopping Tailscale Serve status monitoring")
        self.updateTimer?.invalidate()
        self.updateTimer = nil
        self.isCurrentlyFetching = false
        self.isPermanentlyDisabled = false
    }

    /// Force an immediate status update (useful after server operations)
    func refreshStatusImmediately() async {
        self.logger.debug("Forcing immediate Tailscale Serve status refresh")
        await self.fetchStatus(silent: false) // Show spinner for user-initiated refresh
    }

    /// Fetch the current Tailscale Serve status
    /// - Parameter silent: If true, won't show loading spinner (for background checks)
    @MainActor
    func fetchStatus(silent: Bool = false) async {
        // Prevent concurrent fetches
        guard !self.isCurrentlyFetching else {
            self.logger.debug("Skipping fetch - already in progress")
            return
        }

        self.isCurrentlyFetching = true
        // Only show loading spinner for user-initiated actions
        if !silent {
            self.isLoading = true
        }
        defer {
            if !silent {
                isLoading = false
            }
            isCurrentlyFetching = false
        }

        self.logger.debug("Fetching Tailscale Serve status...")

        // Get server port
        let port = appDefaults.string(forKey: AppConstants.UserDefaultsKeys.serverPort) ?? "4020"
        let urlString = "http://localhost:\(port)/api/sessions/tailscale/status"

        guard let url = URL(string: urlString) else {
            self.logger.error("Invalid URL for Tailscale status endpoint")
            return
        }

        do {
            let (data, response) = try await URLSession.shared.data(from: url)

            guard let httpResponse = response as? HTTPURLResponse else {
                self.logger.error("Invalid response type")
                self.isRunning = false
                self.lastError = String(localized: "Invalid server response", comment: "Error: talking to the local server")
                return
            }

            guard httpResponse.statusCode == 200 else {
                // If we get a non-200 response, there's an issue with the endpoint
                self.isRunning = false
                self.lastError = String(
                    localized: "Unable to check status (HTTP \(httpResponse.statusCode))",
                    comment: "Tailscale Serve status check error. Placeholder: HTTP status code")
                self.logStatusIfChanged("HTTP error: \(httpResponse.statusCode)")
                return
            }

            let decoder = JSONDecoder()
            // Use custom date decoder to handle ISO8601 with fractional seconds
            decoder.dateDecodingStrategy = .custom { decoder in
                let container = try decoder.singleValueContainer()
                let dateString = try container.decode(String.self)

                // Create formatter inside the closure to avoid Sendable warning
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                if let date = formatter.date(from: dateString) {
                    return date
                }
                // Fallback to standard ISO8601 without fractional seconds
                formatter.formatOptions = [.withInternetDateTime]
                if let date = formatter.date(from: dateString) {
                    return date
                }
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Cannot decode date string \(dateString)")
            }

            let status = try decoder.decode(TailscaleServeStatus.self, from: data)

            // Check if this is a permanent failure (tailnet not configured)
            if let error = status.lastError {
                if error.contains("Serve is not enabled on your tailnet") ||
                    error.contains("Tailscale Serve feature not enabled") ||
                    error.contains("Tailscale Serve is disabled on your tailnet")
                {
                    self.isPermanentlyDisabled = true
                } else {
                    // Clear permanent disable if we get a different error
                    self.isPermanentlyDisabled = false
                }
            } else if status.isRunning {
                // Clear permanent disable if it's now running
                self.isPermanentlyDisabled = false
            }

            // Update published properties
            self.isRunning = status.isRunning
            self.lastError = status.lastError
            self.startTime = status.startTime
            self.funnelEnabled = status.funnelEnabled ?? false
            self.funnelStartTime = status.funnelStartTime
            self.desiredMode = status.desiredMode
            self.actualMode = status.actualMode
            self.funnelError = status.funnelError

            self.logStatusIfChanged(
                "running=\(self.isRunning), error=\(self.lastError ?? "none"), " +
                    "permanentlyDisabled=\(self.isPermanentlyDisabled), funnel=\(self.funnelEnabled), " +
                    "mode=\(self.actualMode ?? "none")/\(self.desiredMode ?? "none"), " +
                    "funnelError=\(self.funnelError ?? "none")")
        } catch {
            // On error, assume not running
            self.isRunning = false
            // Provide specific error messages based on the error type
            self.lastError = self.parseStatusCheckError(error)
            self.logStatusIfChanged("fetch from \(urlString) failed: \(self.lastError ?? "unknown")")
            self.logger.debug("Tailscale status fetch error details: \(String(describing: error))")
        }
    }

    /// Log the status only when it differs from the last logged one (polling runs every 10 s)
    private func logStatusIfChanged(_ summary: String) {
        guard summary != self.lastLoggedStatus else { return }
        self.lastLoggedStatus = summary
        self.logger.info("[TAILSCALE STATUS] \(summary)")
    }

    /// Parse status check errors and return user-friendly messages.
    ///
    /// 2026-10-12: matched English words in `localizedDescription`; once the app ships
    /// other languages Foundation returns those in the app's language and every error
    /// fell through to the generic message. Matches error codes instead.
    nonisolated static func statusCheckErrorMessage(for error: Error) -> String {
        if error is DecodingError {
            return String(localized: "Connection to server lost", comment: "Tailscale Serve status check error")
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cannotConnectToHost, .cannotFindHost:
                return String(localized: "Untether server not responding", comment: "Tailscale Serve status check error")
            case .networkConnectionLost, .cannotParseResponse, .badServerResponse:
                return String(localized: "Connection to server lost", comment: "Tailscale Serve status check error")
            case .timedOut:
                return String(localized: "Server response timeout", comment: "Tailscale Serve status check error")
            case .badURL, .unsupportedURL:
                return String(localized: "Invalid server configuration", comment: "Tailscale Serve status check error")
            case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
                return String(localized: "Network connectivity issue", comment: "Tailscale Serve status check error")
            default:
                break
            }
        }
        let nsError = error as NSError
        if nsError.domain == NSPOSIXErrorDomain, nsError.code == Int(ECONNREFUSED) {
            return String(localized: "Untether server not responding", comment: "Tailscale Serve status check error")
        }
        // Fall back to a generic but helpful message
        return String(localized: "Unable to check Tailscale Serve status", comment: "Tailscale Serve status check error")
    }

    private func parseStatusCheckError(_ error: Error) -> String {
        Self.statusCheckErrorMessage(for: error)
    }
}

/// Response model for Tailscale Serve status
struct TailscaleServeStatus: Codable {
    let isRunning: Bool
    let port: Int?
    let error: String?
    let lastError: String?
    let startTime: Date?
    let isPermanentlyDisabled: Bool?
    let funnelEnabled: Bool?
    let funnelStartTime: Date?
    let desiredMode: String? // "private" or "public"
    let actualMode: String? // "private" or "public"
    let funnelError: String? // Specific Funnel error if it failed
}
