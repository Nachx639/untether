import Foundation
import Testing
@testable import Untether

/// The reconnection delay. (The 11 other tests of this file compared local variables with
/// each other and exercised nothing of the app: removed 2026-11-10.)
@Suite("WebSocket Reconnection Tests", .tags(.critical, .websocket))
struct WebSocketReconnectionTests {
    // MARK: - Reconnection Strategy Tests

    @Test("Exponential backoff uses bounded jitter")
    @MainActor
    func exponentialBackoff() {
        let firstMinimum = ReconnectionManager.calculateBackoff(attempt: 1, randomUnit: 0)
        let firstMaximum = ReconnectionManager.calculateBackoff(attempt: 1, randomUnit: 1)
        let cappedMinimum = ReconnectionManager.calculateBackoff(attempt: 7, randomUnit: 0)
        let cappedMaximum = ReconnectionManager.calculateBackoff(attempt: 7, randomUnit: 1)
        let noJitter = ReconnectionManager.calculateBackoff(
            attempt: 4,
            jitterFactor: 0,
            randomUnit: 0)

        #expect(abs(firstMinimum - 0.7) < 0.000_001)
        #expect(firstMaximum == 1)
        #expect(abs(cappedMinimum - 42) < 0.000_001)
        #expect(cappedMaximum == 60)
        #expect(noJitter == 8)
    }
}
