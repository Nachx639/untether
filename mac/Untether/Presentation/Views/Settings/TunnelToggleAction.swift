import Foundation

/// What a tunnel switch has to do when its value changes.
///
/// 2026-11-10: the switches of Pinggy, Pangolin and Cloudflare start as off, are set to the
/// service's state when Remote Access opens, and their `onChange` ran for that too: it started
/// a tunnel that was already running, the service threw "already running", the error handler
/// set the switch back to off and `onChange` then STOPPED the tunnel. Reopening Settings turned
/// a running tunnel off. A change that only mirrors the service is not a request.
enum TunnelToggleAction: Equatable {
    case start
    case stop
    case none

    static func resolve(switchIsOn: Bool, serviceIsRunning: Bool) -> Self {
        guard switchIsOn != serviceIsRunning else { return .none }
        return switchIsOn ? .start : .stop
    }
}
