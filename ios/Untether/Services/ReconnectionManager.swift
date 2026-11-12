import Foundation

/// Reconnection backoff used by `BufferWebSocketClient`.
enum ReconnectionManager {
    /// Calculate the next retry delay using bounded exponential backoff jitter.
    static func calculateBackoff(
        attempt: Int,
        baseDelay: TimeInterval = 1.0,
        maxDelay: TimeInterval = 60.0,
        jitterFactor: Double = 0.3,
        randomUnit: Double = Double.random(in: 0...1))
        -> TimeInterval
    {
        let exponentialDelay = baseDelay * pow(2.0, Double(attempt - 1))
        let cappedDelay = min(exponentialDelay, maxDelay)
        let boundedJitterFactor = min(max(jitterFactor, 0), 1)
        let boundedRandomUnit = min(max(randomUnit, 0), 1)
        let minimumDelay = cappedDelay * (1 - boundedJitterFactor)

        return minimumDelay + (cappedDelay - minimumDelay) * boundedRandomUnit
    }
}
