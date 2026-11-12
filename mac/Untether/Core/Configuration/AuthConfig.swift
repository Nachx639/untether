import Foundation
import UserNotifications

/// Authentication configuration.
///
/// This struct manages the authentication settings for Untether,
/// controlling how users authenticate when accessing terminal sessions.
struct AuthConfig {
    /// The authentication mode currently in use.
    ///
    /// Common values include:
    /// - `"password"`: Traditional password authentication
    /// - `"biometric"`: Touch ID or other biometric authentication
    /// - `"none"`: No authentication required (development/testing only)
    ///
    /// The exact values depend on the authentication providers configured
    /// in the application.
    let mode: String

    /// Creates an authentication configuration from current user defaults.
    ///
    /// This factory method reads the current authentication mode setting
    /// from user defaults to create a configuration instance.
    ///
    /// - Returns: An `AuthConfig` instance with the current authentication mode.
    static func current() -> Self {
        Self(
            mode: AppConstants.stringValue(for: AppConstants.UserDefaultsKeys.authenticationMode))
    }
}

// MARK: - No sign-in stays on this Mac

/// What the server may listen on and expose for a sign-in mode.
///
/// 2026-10-20: the server refuses `--no-auth` on a network address or with Tailscale Serve /
/// Funnel (anyone who reaches the port gets a shell), so with the sign-in method "None" and the
/// access mode "Network" (or Tailscale on) the app started a server that exited at once and
/// restarted forever. With no sign-in the app now always starts it on 127.0.0.1 with no
/// tunnels (the safe default; there is no switch to open it to the network), and the settings
/// say so.
///
/// 2026-11-11: with Tailscale Serve on, the settings said "Locked to this Mac" while the
/// server was started on the address of the access mode (0.0.0.0 for "Network"): the port
/// stayed open to the local network. With Serve on the server is now started on 127.0.0.1
/// (Serve proxies to localhost), active or not: the address is chosen when the server starts
/// and Serve comes up after it, so waiting for "active" would leave the port open in between.
/// The server enforces the same (server-config.ts bindBehindTailscaleServe).
struct ServerNetworkPolicy: Equatable {
    static let loopback = "127.0.0.1"

    let bindAddress: String
    let tailscaleServe: Bool
    let tailscaleFunnel: Bool
    /// What "None" turned off, for the log (empty when nothing was).
    let restricted: [String]

    static func resolve(
        authMode: String,
        bindAddress: String,
        tailscaleServe: Bool,
        tailscaleFunnel: Bool)
        -> Self
    {
        guard authMode == AuthenticationMode.none.rawValue else {
            // Behind Tailscale Serve nothing but its proxy has to reach the port (see above).
            let behindServe = tailscaleServe && !Self.isLoopback(bindAddress)
            return Self(
                bindAddress: behindServe ? Self.loopback : bindAddress,
                tailscaleServe: tailscaleServe,
                tailscaleFunnel: tailscaleServe && tailscaleFunnel,
                restricted: [])
        }
        var restricted: [String] = []
        if !Self.isLoopback(bindAddress) { restricted.append("bind \(bindAddress)") }
        if tailscaleServe { restricted.append("Tailscale Serve") }
        if tailscaleFunnel { restricted.append("Tailscale Funnel") }
        return Self(bindAddress: Self.loopback, tailscaleServe: false, tailscaleFunnel: false, restricted: restricted)
    }

    /// Settings as they are now (UserDefaults).
    static func current(bindAddress: String) -> Self {
        Self.resolve(
            authMode: AuthConfig.current().mode,
            bindAddress: bindAddress,
            tailscaleServe: appDefaults.bool(forKey: AppConstants.UserDefaultsKeys.tailscaleServeEnabled),
            tailscaleFunnel: appDefaults.bool(forKey: AppConstants.UserDefaultsKeys.tailscaleFunnelEnabled))
    }

    static func isLoopback(_ address: String) -> Bool {
        let host = address.trimmingCharacters(in: .whitespaces).lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host == "::1" { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts[0] == "127" && parts.allSatisfy { UInt8($0) != nil }
    }

    /// Tunnels the app starts itself (ngrok, Cloudflare, Pinggy) would publish a server without
    /// sign-in to the internet: refused while the sign-in method is "None".
    static var tunnelsBlockedByNoAuth: Bool {
        AuthConfig.current().mode == AuthenticationMode.none.rawValue
    }

    static var tunnelBlockedMessage: String {
        String(
            localized: "Sign-in is off (None): Untether only listens on this Mac. Choose a sign-in method to use a tunnel.",
            comment: "Error: starting a tunnel while the sign-in method is None")
    }
}

// MARK: - Tunnels follow the sign-in method

/// Stops every tunnel the app runs when the sign-in method becomes "None".
///
/// 2026-10-20: tunnels only checked the sign-in method when they started, so switching to
/// "None" restarted the server without sign-in while an ngrok / Cloudflare / Pinggy / Pangolin
/// tunnel that was already up kept publishing it to the internet. Called before the server
/// restarts in "None" mode (and on every start in that mode).
@MainActor
enum NoSignInTunnelGuard {
    /// Names of the tunnels that were running and got stopped.
    @discardableResult
    static func stopAllTunnels() async -> [String] {
        let ngrok = NgrokService.shared
        let cloudflare = CloudflareService.shared
        let pinggy = PinggyService.shared
        let pangolin = PangolinService.shared
        var stopped: [String] = []
        if await ngrok.isRunning() || ngrok.isActive {
            try? await ngrok.stop()
            stopped.append("ngrok")
        }
        if cloudflare.isRunning {
            await cloudflare.stopQuickTunnel()
            stopped.append("Cloudflare")
        }
        if pinggy.isRunning {
            await pinggy.stopTunnel()
            stopped.append("Pinggy")
        }
        if pangolin.isRunning {
            await pangolin.stop()
            stopped.append("Pangolin")
        }
        return stopped
    }

    /// Stops all tunnels if the current sign-in method is "None".
    @discardableResult
    static func enforceForCurrentSignIn() async -> [String] {
        guard ServerNetworkPolicy.tunnelsBlockedByNoAuth else { return [] }
        return await self.stopAllTunnels()
    }
}

// MARK: - One-time notice: phone access is off with no sign-in

/// 2026-10-20: users who had sign-in "None" together with network access or Tailscale were
/// silently moved to this-Mac-only by ServerNetworkPolicy, so their phone just stopped
/// connecting. They get one notification explaining why (once per Mac, never again).
enum NoSignInPhoneAccessNotice {
    static let shownKey = "noSignInPhoneAccessNoticeShown"

    static func shouldShow(restricted: [String], alreadyShown: Bool) -> Bool {
        !restricted.isEmpty && !alreadyShown
    }

    /// Posts the notice if the current settings lose phone access and it was never shown.
    @MainActor
    static func postIfNeeded(policy: ServerNetworkPolicy, defaults: UserDefaults = appDefaults) {
        guard self.shouldShow(restricted: policy.restricted, alreadyShown: defaults.bool(forKey: self.shownKey))
        else { return }
        defaults.set(true, forKey: self.shownKey)
        let content = UNMutableNotificationContent()
        content.title = String(
            localized: "Phone access is off",
            comment: "Notification title: sign-in None now keeps Untether on this Mac only")
        content.body = String(
            localized: "Sign-in is set to None, so Untether now only listens on this Mac: network access and Tailscale are off. Choose a sign-in method in Settings to use it from your phone again.",
            comment: "Notification body: sign-in None now keeps Untether on this Mac only")
        let request = UNNotificationRequest(identifier: "untether-no-sign-in-phone-access", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }
}
