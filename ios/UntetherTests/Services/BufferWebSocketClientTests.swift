import Foundation
import Testing
@testable import Untether

// Tests use mock classes from Mocks/ directory

@Suite("BufferWebSocketClient Tests", .tags(.critical, .websocket))
@MainActor
final class BufferWebSocketClientTests {
    // Test dependencies
    let mockFactory: MockWebSocketFactory
    let client: BufferWebSocketClient

    /// Initialize test environment
    init() {
        self.mockFactory = MockWebSocketFactory()
        self.client = BufferWebSocketClient(webSocketFactory: self.mockFactory)

        // Setup test server configuration
        TestFixtures.saveServerConfig(.init(
            host: "localhost",
            port: 8888,
            name: nil))
    }

    deinit {
        // Cleanup is handled by test framework
        // Main actor isolated methods cannot be called from deinit
    }

    @Test("Connects successfully with valid configuration", .timeLimit(.minutes(1)))
    func successfulConnection() async throws {
        // Act
        self.client.connect()
        try await self.waitFor { self.client.isConnected }

        // Assert
        #expect(self.mockFactory.createdWebSockets.count == 1)

        let mockWebSocket = try #require(mockFactory.lastCreatedWebSocket)
        #expect(mockWebSocket.isConnected)
        #expect(mockWebSocket.lastConnectURL?.absoluteString.contains("/ws") ?? false)
        #expect(self.client.isConnected)
        #expect(self.client.connectionError == nil)
    }

    @Test("WebSocket uses connectionURL for WSS with HTTPS")
    func websocketUsesConnectionURL() async throws {
        // Arrange - server with HTTPS available
        let httpsConfig = ServerConfig(
            host: "100.64.0.1",
            port: 4020,
            name: "Test Server",
            tailscaleHostname: "test-machine.tailnet.ts.net",
            tailscaleIP: "100.64.0.1",
            isTailscaleEnabled: true,
            preferTailscale: true,
            httpsAvailable: true,
            isPublic: false,
            preferSSL: true)
        TestFixtures.saveServerConfig(httpsConfig)

        // Create new client to pick up the config
        let client = BufferWebSocketClient(webSocketFactory: mockFactory)

        // Act
        client.connect()
        try await self.waitFor { client.isConnected }

        // Assert - should use WSS with HTTPS hostname
        #expect(self.mockFactory.createdWebSockets.count == 1)
        let mockWebSocket = try #require(mockFactory.lastCreatedWebSocket)
        #expect(mockWebSocket.lastConnectURL?.scheme == "wss")
        #expect(mockWebSocket.lastConnectURL?.host == "test-machine.tailnet.ts.net")
        #expect(mockWebSocket.lastConnectURL?.path == "/ws")
    }

    @Test("HTTPS profiles use WSS without Tailscale", arguments: ["https://example.com", "https://example.com:8443"])
    func httpsProfileUsesWSS(url: String) async throws {
        let profile = ServerProfile(name: "Secure server", url: url)
        let config = try #require(profile.toServerConfig())
        TestFixtures.saveServerConfig(config)
        defer { self.client.disconnect() }

        let webSocket = try await self.connectedSocket()
        #expect(webSocket.lastConnectURL?.scheme == "wss")
        #expect(webSocket.lastConnectURL?.host == "example.com")
        #expect(webSocket.lastConnectURL?.port == config.port)
        #expect(webSocket.lastConnectURL?.path == "/ws")
    }

    @Test("Handles connection failure gracefully")
    func connectionFailure() async throws {
        let mockWebSocket = try await self.connectedSocket()
        mockWebSocket.simulateError(WebSocketError.connectionFailed)

        // Assert (the mock reports the error synchronously)
        #expect(!self.client.isConnected)
        #expect(self.client.connectionError != nil)
    }

    @Test("Parses binary buffer messages", arguments: [
        (cols: 80, rows: 24),
        (cols: 120, rows: 30),
        (cols: 160, rows: 50),
    ])
    func binaryMessageParsing(cols: Int, rows: Int) async throws {
        // Arrange
        var receivedEvent: TerminalWebSocketEvent?
        let sessionId = "test-session-123"

        // Subscribe to events
        self.client.subscribe(to: sessionId) { event in
            receivedEvent = event
        }

        let mockWebSocket = try await self.connectedSocket()

        // Create test message
        let bufferData = TestFixtures.bufferSnapshot(cols: cols, rows: rows)
        let messageData = TestFixtures.wrappedV3SnapshotMessage(sessionId: sessionId, bufferData: bufferData)

        // Act - Simulate receiving the message
        mockWebSocket.simulateMessage(WebSocketMessage.data(messageData))

        try await self.waitFor { receivedEvent != nil }

        // Assert
        let event = try #require(receivedEvent)
        guard case let .bufferUpdate(snapshot) = event else {
            Issue.record("Expected buffer update event, got \(event)")
            return
        }

        #expect(snapshot.cols == cols)
        #expect(snapshot.rows == rows)
    }

    @Test("Subscribes to sessions correctly")
    func sessionSubscription() async throws {
        // Arrange
        let sessionId = "test-session-456"
        let mockWebSocket = try await self.connectedSocket()

        // Act - Subscribe after connection is established
        self.client.subscribe(to: sessionId) { _ in }

        // Assert - subscribe frame (v3 type 10) with snapshots + events
        #expect(try await self.subscribeFlags(on: mockWebSocket, sessionId: sessionId) == [0b110])
    }

    @Test("Interactive subscriptions request stdout without snapshots")
    func interactiveSessionSubscription() async throws {
        let sessionId = "interactive-session"
        let mockWebSocket = try await self.connectedSocket()

        self.client.subscribe(to: sessionId, mode: .stdout) { _ in }

        #expect(try await self.subscribeFlags(on: mockWebSocket, sessionId: sessionId) == [0b101])
    }

    @Test("Interactive subscriptions decode header and resize events")
    func interactiveSessionEvents() async throws {
        let sessionId = "interactive-session-events"
        var receivedEvents: [TerminalWebSocketEvent] = []

        self.client.subscribe(to: sessionId, mode: .stdout) { event in
            receivedEvents.append(event)
        }
        let mockWebSocket = try await self.connectedSocket()
        let headerPayload = try #require(
            #"{"kind":"header","header":{"version":2,"width":132,"height":43}}"#.data(using: .utf8))
        let resizePayload = try #require(
            #"{"kind":"resize","dimensions":"100x30"}"#.data(using: .utf8))

        mockWebSocket.simulateMessages([
            .data(TestFixtures.wrappedV3Frame(sessionId: sessionId, type: 22, payload: headerPayload)),
            .data(TestFixtures.wrappedV3Frame(sessionId: sessionId, type: 22, payload: resizePayload)),
        ])
        try await self.waitFor { receivedEvents.count == 2 }

        guard case let .header(width, height) = receivedEvents[0] else {
            Issue.record("Expected header event")
            return
        }
        #expect(width == 132)
        #expect(height == 43)

        guard case let .resize(_, dimensions) = receivedEvents[1] else {
            Issue.record("Expected resize event")
            return
        }
        #expect(dimensions == "100x30")
    }

    @Test("Handles reconnection after disconnection", .timeLimit(.minutes(1)))
    func reconnection() async throws {
        let sessionId = "reconnecting-session"
        var receivedEvents: [TerminalWebSocketEvent] = []
        self.client.subscribe(to: sessionId, mode: .stdout) { event in
            receivedEvents.append(event)
        }

        let firstWebSocket = try await self.connectedSocket()

        // Act - Simulate disconnection
        firstWebSocket.simulateDisconnection()

        // Wait for reconnection attempt
        try await self.waitFor { self.mockFactory.createdWebSockets.count > 1 }

        // Assert
        let secondWebSocket = try #require(mockFactory.lastCreatedWebSocket)
        #expect(secondWebSocket !== firstWebSocket)

        #expect(try await self.subscribeFlags(on: secondWebSocket, sessionId: sessionId) == [0b101])
        #expect(receivedEvents.contains { event in
            if case .replayStarted = event {
                return true
            }
            return false
        })
    }

    @Test("Sends ping messages periodically", .disabled("Ping timing is unpredictable in tests"))
    func pingMessages() async throws {
        let mockWebSocket = try await self.connectedSocket()
        let initialPingCount = mockWebSocket.pingCount

        // Wait longer to see if pings are sent
        try await Task.sleep(nanoseconds: 1_000_000_000) // 1 second

        // Assert - Should have sent at least one ping
        #expect(mockWebSocket.pingCount > initialPingCount)
    }

    @Test("Unsubscribes from sessions correctly")
    func sessionUnsubscription() async throws {
        // Arrange
        let sessionId = "test-session-789"
        let token = self.client.subscribe(to: sessionId) { _ in }
        let mockWebSocket = try await self.connectedSocket()

        // Act - Unsubscribe
        self.client.unsubscribe(token)

        // Assert - Should have sent the unsubscribe frame (v3 type 11)
        try await self.waitFor {
            self.frames(on: mockWebSocket).contains { $0.type == 11 && $0.sessionId == sessionId }
        }
    }

    @Test("Cleans up on disconnect")
    func cleanup() async throws {
        // Subscribe to a session
        self.client.subscribe(to: "test-session") { _ in }
        let mockWebSocket = try await self.connectedSocket()

        // Act
        self.client.disconnect()

        // Assert
        #expect(!self.client.isConnected)
        #expect(mockWebSocket.disconnectCalled)
        #expect(mockWebSocket.lastDisconnectCode == URLSessionWebSocketTask.CloseCode.goingAway)
    }

    // MARK: - Connection lifecycle (2026-11-10 audit)

    @Test("The first subscriber connects the socket on its own")
    func firstSubscriberConnects() async throws {
        // A session card's live preview subscribes without any terminal having called connect()
        self.client.subscribe(to: "preview-session") { _ in }

        try await self.waitFor { self.client.isConnected }
        let mockWebSocket = try #require(mockFactory.lastCreatedWebSocket)
        #expect(self.mockFactory.createdWebSockets.count == 1)
        #expect(try await self.subscribeFlags(on: mockWebSocket, sessionId: "preview-session") == [0b110])
    }

    @Test("A session's preview and terminal subscribe side by side")
    func previewAndTerminalShareASession() async throws {
        let sessionId = "shared-session"
        var previewEvents: [TerminalWebSocketEvent] = []
        var terminalEvents: [TerminalWebSocketEvent] = []

        // The card's preview is there first
        self.client.subscribe(to: sessionId) { previewEvents.append($0) }
        let mockWebSocket = try await self.connectedSocket()
        #expect(try await self.subscribeFlags(on: mockWebSocket, sessionId: sessionId) == [0b110])

        // Opening the terminal adds stdout to what the server sends, it does not replace the preview
        let terminal = self.client.subscribe(to: sessionId, mode: .stdout) { terminalEvents.append($0) }
        #expect(try await self.subscribeFlags(on: mockWebSocket, sessionId: sessionId, count: 2) == [0b110, 0b111])

        let snapshot = TestFixtures.wrappedV3SnapshotMessage(
            sessionId: sessionId,
            bufferData: TestFixtures.bufferSnapshot(cols: 80, rows: 24))
        let stdout = TestFixtures.wrappedV3Frame(sessionId: sessionId, type: 20, payload: Data("hello".utf8))
        mockWebSocket.simulateMessages([.data(snapshot), .data(stdout)])
        try await self.waitFor { previewEvents.count == 1 && terminalEvents.count == 1 }

        guard case .bufferUpdate = previewEvents[0] else {
            Issue.record("The preview expected the snapshot, got \(previewEvents[0])")
            return
        }
        guard case let .output(_, data) = terminalEvents[0] else {
            Issue.record("The terminal expected the output, got \(terminalEvents[0])")
            return
        }
        #expect(data == "hello")

        // Closing the terminal leaves the preview subscribed and receiving
        self.client.unsubscribe(terminal)
        #expect(
            try await self.subscribeFlags(on: mockWebSocket, sessionId: sessionId, count: 3)
                == [0b110, 0b111, 0b110])
        #expect(!self.frames(on: mockWebSocket).contains { $0.type == 11 })

        mockWebSocket.simulateMessage(.data(snapshot))
        try await self.waitFor { previewEvents.count == 2 }
        #expect(terminalEvents.count == 1)
    }

    @Test("disconnect() closes for good: no reconnection, no word from the old socket")
    func disconnectDoesNotReconnect() async throws {
        self.client.subscribe(to: "some-session") { _ in }
        let mockWebSocket = try await self.connectedSocket()

        self.client.disconnect()
        // What a real socket reports after being cancelled
        mockWebSocket.delegate = self.client
        mockWebSocket.isConnected = true
        mockWebSocket.simulateDisconnection(closeCode: .goingAway)
        mockWebSocket.isConnected = true
        mockWebSocket.simulateError(WebSocketError.connectionFailed)

        // Longer than the first reconnection delay (0.7-1 s)
        try await Task.sleep(for: .milliseconds(1_500))
        #expect(self.mockFactory.createdWebSockets.count == 1)
        #expect(!self.client.isConnected)
        #expect(self.client.connectionError == nil)
    }

    @Test("A replaced socket's late close does not take down the new one")
    func staleSocketCallbacksAreIgnored() async throws {
        self.client.subscribe(to: "some-session") { _ in }
        let first = try await self.connectedSocket()

        first.simulateDisconnection()
        try await self.waitFor { self.mockFactory.createdWebSockets.count == 2 && self.client.isConnected }

        // The first socket speaks again after the second took over
        first.delegate = self.client
        first.isConnected = true
        first.simulateDisconnection()

        #expect(self.client.isConnected)
        try await Task.sleep(for: .milliseconds(1_500))
        #expect(self.mockFactory.createdWebSockets.count == 2)
    }

    @Test("Close 4401 (token refused) stops and asks for a login instead of reconnecting")
    func tokenRefusedStopsReconnecting() async throws {
        var loginRequests = 0
        self.client.onAuthenticationRequired = { loginRequests += 1 }
        self.client.subscribe(to: "some-session") { _ in }
        let mockWebSocket = try await self.connectedSocket()

        let tokenInvalid = try #require(URLSessionWebSocketTask.CloseCode(rawValue: 4_401))
        mockWebSocket.simulateDisconnection(closeCode: tokenInvalid, reason: Data("Invalid or expired token".utf8))

        #expect(loginRequests == 1)
        #expect(self.client.authenticationRequired)
        #expect(!self.client.isConnected)

        // Neither the reconnection timer nor a new subscriber nor connect() tries again
        self.client.subscribe(to: "another-session") { _ in }
        self.client.connect()
        try await Task.sleep(for: .milliseconds(1_500))
        #expect(self.mockFactory.createdWebSockets.count == 1)
        #expect(loginRequests == 1)
    }

    @Test("After a refused token and a new login, whoever was subscribed is subscribed again")
    func subscribersSurviveANewLogin() async throws {
        var events = 0
        self.client.subscribe(to: "card-on-screen") { _ in events += 1 }
        let first = try await self.connectedSocket()
        let tokenInvalid = try #require(URLSessionWebSocketTask.CloseCode(rawValue: 4_401))
        first.simulateDisconnection(closeCode: tokenInvalid)
        #expect(self.client.authenticationRequired)

        // Still refused: nothing connects
        self.client.reconnectIfNeeded()
        #expect(self.mockFactory.createdWebSockets.count == 1)

        // The login installs its auth service and the app is connected again
        self.client.setAuthenticationService(AuthenticationService(
            apiClient: APIClient(session: URLSession(configuration: .mockConfiguration)),
            serverConfig: ServerConfig(host: "relogin-\(UUID().uuidString.lowercased()).local", port: 4_020),
            keychainService: MockKeychainService(),
            session: URLSession(configuration: .mockConfiguration)))
        self.client.reconnectIfNeeded()

        try await self.waitFor { self.mockFactory.createdWebSockets.count == 2 && self.client.isConnected }
        let second = try #require(mockFactory.lastCreatedWebSocket)
        #expect(try await self.subscribeFlags(on: second, sessionId: "card-on-screen") == [0b110])
        second.simulateMessage(.data(self.validSnapshotMessage("card-on-screen")))
        try await self.waitFor { events == 1 }
    }

    @Test("Without subscribers a dropped connection is not retried")
    func noSubscribersNoReconnection() async throws {
        let mockWebSocket = try await self.connectedSocket()
        mockWebSocket.simulateDisconnection()

        try await Task.sleep(for: .milliseconds(1_500))
        #expect(self.mockFactory.createdWebSockets.count == 1)

        // The next subscriber connects again
        self.client.subscribe(to: "later-session") { _ in }
        try await self.waitFor { self.mockFactory.createdWebSockets.count == 2 && self.client.isConnected }
    }

    // MARK: - Snapshot decoding against the server's encoding

    private func decode(cols: Int, lines: [String]) async throws -> BufferSnapshot {
        try await self.decode(TestFixtures.bufferSnapshot(cols: cols, lines: lines))
    }

    private func decode(_ bufferData: Data) async throws -> BufferSnapshot {
        let sessionId = "snapshot-session"
        var snapshots: [BufferSnapshot] = []
        self.client.subscribe(to: sessionId) { event in
            if case let .bufferUpdate(snapshot) = event { snapshots.append(snapshot) }
        }
        let mockWebSocket = try await self.connectedSocket()
        mockWebSocket.simulateMessage(.data(TestFixtures.wrappedV3SnapshotMessage(
            sessionId: sessionId,
            bufferData: bufferData)))
        try await self.waitFor { !snapshots.isEmpty }
        return snapshots[0]
    }

    @Test("Pure blue text and background are RGB, never a palette index")
    func lowRgbColoursDecode() async throws {
        // 2026-11-11: a colour whose value is <= 255 (#0000FF, #000080, black) travelled in
        // one byte as a palette index; every colour is three RGB bytes now
        let snapshot = try await self.decode(TestFixtures.bufferSnapshot(cols: 10, coloredCells: [
            (char: "F", attributes: 0, fg: [0, 0, 255], bg: nil),
            (char: "B", attributes: 0x01, fg: nil, bg: [0, 0, 255]),
            (char: "N", attributes: 0, fg: [0, 0, 128], bg: [0, 0, 0]),
            (char: "x", attributes: 0x08, fg: nil, bg: nil),
        ]))

        let cells = try #require(snapshot.cells.first)
        #expect(cells.map(\.char).joined() == "FBNx")
        #expect(cells[0].fg == 0x0000FF)
        #expect(cells[0].bg == nil)
        #expect(cells[1].fg == nil)
        #expect(cells[1].bg == 0x0000FF)
        #expect(cells[1].attributes == 0x01)
        #expect(cells[2].fg == 0x000080)
        #expect(cells[2].bg == 0x000000)
        #expect(cells[3].attributes == 0x08)
    }

    @Test("A snapshot of another version is not decoded")
    func otherVersionIsRefused() async throws {
        let sessionId = "old-version-session"
        var snapshots: [BufferSnapshot] = []
        self.client.subscribe(to: sessionId) { event in
            if case let .bufferUpdate(snapshot) = event {
                snapshots.append(snapshot)
            }
        }
        let mockWebSocket = try await self.connectedSocket()
        var old = TestFixtures.bufferSnapshot(cols: 10, lines: ["old"])
        old[2] = 0x01
        mockWebSocket.simulateMessage(.data(TestFixtures.wrappedV3SnapshotMessage(
            sessionId: sessionId,
            bufferData: old)))
        mockWebSocket.simulateMessage(.data(TestFixtures.wrappedV3SnapshotMessage(
            sessionId: sessionId,
            bufferData: TestFixtures.bufferSnapshot(cols: 10, lines: ["new"]))))
        try await self.waitFor { !snapshots.isEmpty }
        #expect(snapshots.map { self.text($0) } == [["new"]])
    }

    private func text(_ snapshot: BufferSnapshot) -> [String] {
        snapshot.cells.map { $0.map(\.char).joined() }
    }

    @Test("A row full of emoji-looking characters does not blank the rest of the snapshot")
    func rowsAfterWideLookingCharactersAreDecoded() async throws {
        // ⏺ © ™ ▶ have the Unicode 'emoji' property but take one column; counted as two, a
        // row of them 'passed' the 10 columns and everything after it was lost
        let lines = ["⏺⏺⏺⏺⏺⏺⏺⏺⏺⏺", "©™▶ ok", "", "last line"]
        let snapshot = try await self.decode(cols: 10, lines: lines)

        #expect(snapshot.rows == 4)
        #expect(self.text(snapshot) == lines)
    }

    @Test("Wide characters are one cell each, as the server sends them")
    func wideCharactersDecode() async throws {
        let lines = ["日本語 👍 ok", "second"]
        let snapshot = try await self.decode(cols: 12, lines: lines)

        #expect(self.text(snapshot) == lines)
    }

    @Test("A one-row snapshot is not rejected as too small")
    func oneRowSnapshot() async throws {
        // 28 bytes of header + 2 of an empty row = 30: the decoder asked for 32
        let snapshot = try await self.decode(cols: 80, lines: [""])
        #expect(snapshot.rows == 1)
        #expect(snapshot.cols == 80)
    }

    @Test("The bell of a snapshot rings for its own session only")
    func bellGoesToItsSession() async throws {
        var bells: [String] = []
        for sessionId in ["quiet", "ringing"] {
            self.client.subscribe(to: sessionId) { event in
                if case .bell = event { bells.append(sessionId) }
            }
        }
        let mockWebSocket = try await self.connectedSocket()
        var snapshot = TestFixtures.bufferSnapshot(cols: 80, rows: 2)
        snapshot[3] = 0x01 // flags: bell
        mockWebSocket.simulateMessage(.data(TestFixtures.wrappedV3SnapshotMessage(
            sessionId: "ringing",
            bufferData: snapshot)))

        try await self.waitFor { !bells.isEmpty }
        #expect(bells == ["ringing"])
    }

    // MARK: - Error Handling Tests

    @Test("Handles invalid magic byte in binary messages")
    func invalidMagicByte() async throws {
        // Arrange
        var receivedEvents: [TerminalWebSocketEvent] = []
        let sessionId = "test-session"

        self.client.subscribe(to: sessionId) { event in
            receivedEvents.append(event)
        }
        let mockWebSocket = try await self.connectedSocket()

        // Create message with wrong magic (v3 expects "VT" + version 3)
        var messageData = Data()
        messageData.append(0xFF)
        messageData.append(0x00)
        messageData.append(0x03) // version
        messageData.append(21) // snapshot type
        messageData.append(contentsOf: [0, 0, 0, 0]) // session id len
        messageData.append(contentsOf: [0, 0, 0, 0]) // payload len

        // Act: the bad message, then a good one to know the bad one was processed
        mockWebSocket.simulateMessages([.data(messageData), .data(self.validSnapshotMessage(sessionId))])
        try await self.waitFor { !receivedEvents.isEmpty }

        // Assert - only the good one produced an event
        #expect(receivedEvents.count == 1)
    }

    @Test("Handles malformed buffer data gracefully")
    func malformedBufferData() async throws {
        // Arrange
        var receivedEvents: [TerminalWebSocketEvent] = []
        let sessionId = "test-session"

        self.client.subscribe(to: sessionId) { event in
            receivedEvents.append(event)
        }
        let mockWebSocket = try await self.connectedSocket()

        // Create message with valid wrapper but invalid buffer data
        var bufferData = Data()
        bufferData.append(contentsOf: [0xFF, 0xFF]) // Invalid magic for buffer
        bufferData.append(contentsOf: [1, 2, 3, 4]) // Random data

        let messageData = TestFixtures.wrappedV3SnapshotMessage(sessionId: sessionId, bufferData: bufferData)

        // Act: the bad message, then a good one to know the bad one was processed
        mockWebSocket.simulateMessages([.data(messageData), .data(self.validSnapshotMessage(sessionId))])
        try await self.waitFor { !receivedEvents.isEmpty }

        // Assert - Should not crash; only the good one produced an event
        #expect(receivedEvents.count == 1)
    }
}

// MARK: - Test Extensions

extension BufferWebSocketClientTests {
    struct WaitTimeout: Error, CustomStringConvertible {
        let description = "Timeout waiting for condition"
    }

    /// Waits for the condition with a deadline (never a fixed sleep: under load a fixed wait is
    /// either too short or wasted) and throws when it runs out.
    func waitFor(
        _ condition: @escaping @MainActor () -> Bool,
        timeout: Duration = .seconds(10),
        pollingInterval: Duration = .milliseconds(10))
        async throws
    {
        let deadline = ContinuousClock.now.advanced(by: timeout)

        while ContinuousClock.now < deadline {
            if condition() {
                return
            }
            try await Task.sleep(for: pollingInterval)
        }

        throw WaitTimeout()
    }

    /// Connects (unless a subscriber already did) and returns the connected mock socket.
    func connectedSocket() async throws -> MockWebSocket {
        self.client.connect()
        try await self.waitFor { self.client.isConnected }
        return try #require(self.mockFactory.lastCreatedWebSocket)
    }

    func frames(on webSocket: MockWebSocket) -> [(type: UInt8, sessionId: String, payload: Data)] {
        webSocket.sentDataMessages().compactMap { TestFixtures.decodeV3Frame($0) }
    }

    /// The flags of the SUBSCRIBE frames (v3 type 10) sent for a session, once `count` are there.
    func subscribeFlags(on webSocket: MockWebSocket, sessionId: String, count: Int = 1) async throws -> [UInt32] {
        let sent = { self.frames(on: webSocket).filter { $0.type == 10 && $0.sessionId == sessionId } }
        try await self.waitFor { sent().count >= count }
        return sent().map { frame in
            frame.payload.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian }
        }
    }

    func validSnapshotMessage(_ sessionId: String) -> Data {
        TestFixtures.wrappedV3SnapshotMessage(
            sessionId: sessionId,
            bufferData: TestFixtures.bufferSnapshot(cols: 80, rows: 24))
    }
}
