import Foundation
import Testing
@testable import Untether

// 2026-11-10: three ways the Mac app's events socket went quiet for good: a failed handshake
// left it "connecting" forever, a reconnect never asked for the events again, and frames to
// send piled up without limit while there was no connection.
@Suite("WS v3 client: losing and regaining the connection", .serialized)
@MainActor
struct WsV3SocketClientReconnectTests {
    private func welcome() -> URLSessionWebSocketTask.Message {
        .data(WsV3SocketClient.encodeFrame(type: .welcome, sessionId: "", payload: Data()))
    }

    private func types(_ frames: [Data]) -> [WsV3SocketClient.MessageType] {
        frames.compactMap { try? WsV3SocketClient.decodeFrame($0).type }
    }

    /// A loopback port nothing listens on.
    private func closedPort() throws -> String {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        try #require(descriptor >= 0)
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        try #require(bound == 0)
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descriptor, $0, &length) }
        }
        try #require(named == 0)
        return String(UInt16(bigEndian: address.sin_port))
    }

    @Test
    func everyWelcomeAsksForTheEventsAgain() {
        let client = WsV3SocketClient()
        var sent: [Data] = []
        client.sendOverride = { sent.append($0) }

        client.subscribeGlobalEvents() // asked before the connection is up, as NotificationService does
        #expect(sent.isEmpty)

        client.handle(self.welcome())
        #expect(self.types(sent) == [.subscribe])

        // The server restarted by itself: a new connection, a new WELCOME.
        sent.removeAll()
        client.handle(self.welcome())
        #expect(self.types(sent) == [.subscribe])
    }

    @Test
    func nobodyAskedForEventsNobodyGetsASubscription() {
        let client = WsV3SocketClient()
        var sent: [Data] = []
        client.sendOverride = { sent.append($0) }
        client.handle(self.welcome())
        #expect(sent.isEmpty)
    }

    @Test
    func framesWaitingForAConnectionAreBounded() throws {
        let client = WsV3SocketClient()
        var sent: [Data] = []
        client.sendOverride = { sent.append($0) }

        let total = WsV3SocketClient.maxPendingSends * 10
        for index in 0..<total {
            client.sendInputText(sessionId: "s", text: "\(index)")
        }
        client.handle(self.welcome())

        #expect(sent.count == WsV3SocketClient.maxPendingSends)
        // The newest are the ones kept, in order.
        let last = try WsV3SocketClient.decodeFrame(#require(sent.last))
        #expect(String(data: last.payload, encoding: .utf8) == "\(total - 1)")
        let first = try WsV3SocketClient.decodeFrame(#require(sent.first))
        #expect(String(data: first.payload, encoding: .utf8) == "\(total - WsV3SocketClient.maxPendingSends)")
    }

    @Test
    func aFailedHandshakeIsALostConnectionNotAnEternalConnecting() async throws {
        let client = WsV3SocketClient()
        defer { client.disconnect() }

        try client.connect(serverPort: self.closedPort(), authMode: "none", token: nil)
        #expect(client.state == .connecting)

        var left = false
        for _ in 0..<200 {
            if client.state == .disconnected {
                left = true; break
            }
            try? await Task.sleep(for: .milliseconds(50))
        }
        #expect(left, "still \(client.state) after a handshake nobody answered")
        // And it will try again by itself.
        #expect(client.hasPendingReconnect)
    }
}
