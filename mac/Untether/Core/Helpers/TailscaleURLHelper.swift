import Foundation

/// The address of this Mac on the tailnet, as the app shows and opens it.
enum TailscaleURLHelper {
    struct Address: Equatable {
        /// What the menu and the settings show.
        let display: String
        /// What a click opens; nil while nothing answers there.
        let url: URL?
    }

    /// - Parameters:
    ///   - serveEnabled: Tailscale Serve is on in the settings and the sign-in method allows it.
    ///   - serveRunning: the server reports Serve as running.
    ///   - serverOnLoopback: the server listens on this Mac only (ServerManager.listeningAddress).
    ///
    /// 2026-11-11: with Serve active in private mode the app showed and opened
    /// `http://<tailscale IP>:<port>`: plain HTTP, past Serve and its Tailscale sign-in, to a
    /// port that behind Serve only listens on 127.0.0.1. The address of an active Serve is its
    /// `https://<hostname>`, private or public (Funnel). Without Serve the tailnet reaches the
    /// port itself, which only works when the server listens beyond this Mac.
    static func address(
        hostname: String,
        port: String,
        serveEnabled: Bool,
        serveRunning: Bool,
        serverOnLoopback: Bool)
        -> Address
    {
        if serveEnabled {
            return Address(display: hostname, url: serveRunning ? URL(string: "https://\(hostname)") : nil)
        }
        if serverOnLoopback {
            return Address(display: hostname, url: nil)
        }
        return Address(display: "\(hostname):\(port)", url: URL(string: "http://\(hostname):\(port)"))
    }
}
