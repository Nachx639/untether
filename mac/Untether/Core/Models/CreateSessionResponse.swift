import Foundation

/// Response after creating a session.
///
/// Contains the session's identifier and, for a session created by this request, its
/// timestamp: the server answers `{ sessionId, existing: true }` without one when the
/// conversation to resume already runs in another session.
public struct CreateSessionResponse: Codable, Sendable {
    public let sessionId: String
    public let createdAt: Date?

    public init(sessionId: String, createdAt: Date?) {
        self.sessionId = sessionId
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId
        case createdAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.sessionId = try container.decode(String.self, forKey: .sessionId)

        guard let createdAtValue = try container.decodeIfPresent(String.self, forKey: .createdAt) else {
            self.createdAt = nil
            return
        }
        let fractionalFormat = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let wholeSecondFormat = Date.ISO8601FormatStyle(includingFractionalSeconds: false)

        if let date = try? fractionalFormat.parse(createdAtValue) {
            self.createdAt = date
        } else if let date = try? wholeSecondFormat.parse(createdAtValue) {
            self.createdAt = date
        } else {
            throw DecodingError.dataCorruptedError(
                forKey: .createdAt,
                in: container,
                debugDescription: "Expected an ISO 8601 timestamp")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.sessionId, forKey: .sessionId)
        try container.encodeIfPresent(
            self.createdAt?.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)),
            forKey: .createdAt)
    }
}
