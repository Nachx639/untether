import Foundation

/// Control message protocol for unified Unix socket communication
enum ControlProtocol {
    // MARK: - Message Types

    enum MessageType: String, Codable {
        case request
        case response
        case event
    }

    enum Category: String, Codable {
        case terminal
        case system
    }

    // MARK: - Base message for runtime dispatch

    protocol AnyControlMessage {
        var id: String { get }
        var type: MessageType { get }
        var category: Category { get }
        var action: String { get }
        var sessionId: String? { get }
        var error: String? { get }
    }

    // MARK: - Type aliases for common message types

    typealias TerminalSpawnRequestMessage = ControlMessage<TerminalSpawnRequest>
    typealias TerminalSpawnResponseMessage = ControlMessage<TerminalSpawnResponse>
    typealias SystemReadyMessage = ControlMessage<SystemReadyEvent>
    typealias SystemPingRequestMessage = ControlMessage<SystemPingRequest>
    typealias SystemPingResponseMessage = ControlMessage<SystemPingResponse>

    // MARK: - Convenience builders for specific message types

    /// Build a spawn response
    /// NOTE: Error Duplication Pattern
    /// Both top-level error and payload error fields are set intentionally:
    /// - Top-level error: Indicates transport/protocol-level errors (malformed request, handler not found)
    /// - Payload error: Indicates application-level errors (spawn failed due to permissions)
    /// This separation allows clients to distinguish between different error types.
    static func terminalSpawnResponse(
        to request: TerminalSpawnRequestMessage,
        success: Bool,
        pid: Int? = nil,
        error: String? = nil)
        -> TerminalSpawnResponseMessage
    {
        ControlMessage(
            id: request.id,
            type: .response,
            category: .terminal,
            action: "spawn",
            payload: TerminalSpawnResponse(success: success, pid: pid, error: error),
            sessionId: request.sessionId,
            error: error)
    }

    static func systemPingRequest() -> SystemPingRequestMessage {
        ControlMessage(
            type: .request,
            category: .system,
            action: "ping",
            payload: SystemPingRequest())
    }

    static func systemPingResponse(
        to request: SystemPingRequestMessage)
        -> SystemPingResponseMessage
    {
        ControlMessage(
            id: request.id,
            type: .response,
            category: .system,
            action: "ping",
            payload: SystemPingResponse())
    }

    // MARK: - Message Serialization

    static func encode(_ message: ControlMessage<some Codable>) throws -> Data {
        let encoder = JSONEncoder()
        return try encoder.encode(message)
    }

    static func decode<T: Codable>(_ data: Data, as messageType: ControlMessage<T>.Type) throws -> ControlMessage<T> {
        let decoder = JSONDecoder()
        return try decoder.decode(messageType, from: data)
    }

    /// For handlers that need to decode specific message types based on action
    static func decodeTerminalSpawnRequest(_ data: Data) throws -> TerminalSpawnRequestMessage {
        try self.decode(data, as: TerminalSpawnRequestMessage.self)
    }

    static func decodeSystemPingRequest(_ data: Data) throws -> SystemPingRequestMessage {
        try self.decode(data, as: SystemPingRequestMessage.self)
    }
}
