import Foundation
import Testing
@testable import Untether

@Suite("JSONValue Tests", .tags(.models))
struct JSONValueTests {
    @Test
    func decodesObjectWithNestedValues() throws {
        let json = """
        {
            "name": "Untether",
            "count": 3,
            "flag": true,
            "child": { "value": 1 },
            "list": [1, "two", false, null]
        }
        """
        let data = try #require(json.data(using: .utf8))

        let object = try #require(JSONValue.decodeObject(from: data))
        #expect(object["name"]?.string == "Untether")
        #expect(object["count"]?.int == 3)
        #expect(object["flag"]?.bool == true)
        #expect(object["child"]?.object?["value"]?.int == 1)
        #expect(object["list"]?.array?.count == 4)
        #expect(object["list"]?.array?.last == .null)
    }

    @Test
    func roundTripsViaJsonencoderDecoder() throws {
        let value: JSONValue = .object([
            "name": .string("untether"),
            "count": .number(2),
            "active": .bool(true),
            "list": .array([.string("a"), .number(1)]),
        ])

        let data = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(decoded == value)
    }

    @Test
    func convertsFromAnyPayloads() throws {
        let payload: [String: Any] = [
            "name": "untether",
            "count": 2,
            "flag": true,
            "list": [1, "two", false, NSNull()],
        ]

        let value = try #require(JSONValue(any: payload))
        let object = try #require(value.object)
        #expect(object["name"]?.string == "untether")
        #expect(object["count"]?.int == 2)
        #expect(object["flag"]?.bool == true)
        #expect(object["list"]?.array?.count == 4)
    }
}
