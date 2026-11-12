import Foundation
import Testing
@testable import Untether

@Suite("CreateSessionResponse")
struct CreateSessionResponseTests {
    // MARK: - CreateSessionResponse Tests

    @Test
    func createSessionResponseDecodesServerTimestampWithFractionalSeconds() throws {
        let data = Data(#"{"sessionId":"response-test-456","createdAt":"2026-06-12T06:04:18.721Z"}"#.utf8)
        let response = try JSONDecoder().decode(CreateSessionResponse.self, from: data)
        let expectedDate = try Date.ISO8601FormatStyle(includingFractionalSeconds: true)
            .parse("2026-06-12T06:04:18.721Z")

        #expect(response.sessionId == "response-test-456")
        #expect(response.createdAt == expectedDate)
    }

    @Test
    func createSessionResponseDecodesServerTimestampWithoutFractionalSeconds() throws {
        let data = Data(#"{"sessionId":"response-test-456","createdAt":"2026-06-12T06:04:18Z"}"#.utf8)
        let response = try JSONDecoder().decode(CreateSessionResponse.self, from: data)
        let expectedDate = try Date.ISO8601FormatStyle(includingFractionalSeconds: false)
            .parse("2026-06-12T06:04:18Z")

        #expect(response.createdAt == expectedDate)
    }

    /// 2026-11-10: resuming a Claude conversation that already runs elsewhere is answered
    /// `{ sessionId, existing: true }` (web/src/server/routes/sessions.ts); a required
    /// `createdAt` made the Mac report a failure for a session that exists.
    @Test
    func createSessionResponseDecodesAnExistingSessionWithoutTimestamp() throws {
        let data = Data(#"{"sessionId":"response-test-456","existing":true}"#.utf8)
        let response = try JSONDecoder().decode(CreateSessionResponse.self, from: data)

        #expect(response.sessionId == "response-test-456")
        #expect(response.createdAt == nil)
    }

    @Test
    func createSessionResponseRejectsInvalidTimestamp() {
        let data = Data(#"{"sessionId":"response-test-456","createdAt":"not-a-date"}"#.utf8)

        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(CreateSessionResponse.self, from: data)
        }
    }

    @Test
    func createSessionResponseEncodesServerTimestampFormat() throws {
        let date = try Date.ISO8601FormatStyle(includingFractionalSeconds: true)
            .parse("2026-06-12T06:04:18.721Z")
        let response = CreateSessionResponse(sessionId: "response-test-456", createdAt: date)
        let data = try JSONEncoder().encode(response)
        let payload = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        let createdAtValue = try #require(payload["createdAt"])
        let encodedDate = try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(createdAtValue)

        #expect(payload["sessionId"] == "response-test-456")
        #expect(createdAtValue.contains("."))
        #expect(abs(date.timeIntervalSince(encodedDate)) < 0.002)
    }
}
