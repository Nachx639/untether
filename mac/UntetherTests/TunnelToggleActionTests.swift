import Testing
@testable import Untether

// 2026-11-10: reopening Settings → Remote Access turned a running tunnel off (see TunnelToggleAction).
@Suite("Tunnel switch")
struct TunnelToggleActionTests {
    @Test
    func mirroringARunningTunnelAsksForNothing() {
        // Remote Access opens: the switch goes from off to on because the tunnel runs.
        #expect(TunnelToggleAction.resolve(switchIsOn: true, serviceIsRunning: true) == .none)
        // A tunnel that ended by itself: the switch follows, nothing to stop.
        #expect(TunnelToggleAction.resolve(switchIsOn: false, serviceIsRunning: false) == .none)
    }

    @Test
    func theUserFlippingTheSwitchStartsOrStops() {
        #expect(TunnelToggleAction.resolve(switchIsOn: true, serviceIsRunning: false) == .start)
        #expect(TunnelToggleAction.resolve(switchIsOn: false, serviceIsRunning: true) == .stop)
    }
}
