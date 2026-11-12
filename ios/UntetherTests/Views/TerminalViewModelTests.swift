import Testing
@testable import Untether

@MainActor
private final class RecordingTerminalCoordinator: TerminalCoordinating {
    private(set) var events: [String] = []

    func feedData(_ data: String) {
        self.events.append("output:\(data)")
    }

    func resetForReplay() {
        self.events.append("reset")
    }

    func scrollToBottom() {
        _ = ()
    }

    func setMaxWidth(_ maxWidth: Int) {
        _ = maxWidth
    }

    func getBufferContent() async -> String? {
        nil
    }
}

@Suite("TerminalViewModel Tests")
@MainActor
struct TerminalViewModelTests {
    @Test("Flushes pre-coordinator terminal events in arrival order")
    func flushesPendingTerminalEvents() {
        let viewModel = TerminalViewModel(session: TestFixtures.validSession)
        viewModel.handleWebSocketEvent(.output(timestamp: 0, data: "first"))
        viewModel.handleWebSocketEvent(.output(timestamp: 1, data: "second"))

        let coordinator = RecordingTerminalCoordinator()
        viewModel.terminalCoordinator = coordinator

        #expect(coordinator.events == [
            "output:first",
            "output:second",
        ])

        viewModel.handleWebSocketEvent(.output(timestamp: 2, data: "third"))
        #expect(coordinator.events.last == "output:third")
    }

    @Test("Resets terminal before rendering reconnect replay")
    func resetsBeforeReconnectReplay() {
        let viewModel = TerminalViewModel(session: TestFixtures.validSession)
        let coordinator = RecordingTerminalCoordinator()
        viewModel.terminalCoordinator = coordinator

        viewModel.handleWebSocketEvent(.output(timestamp: 0, data: "old"))
        viewModel.handleWebSocketEvent(.replayStarted)
        viewModel.handleWebSocketEvent(.output(timestamp: 1, data: "complete history"))

        #expect(coordinator.events == [
            "output:old",
            "reset",
            "output:complete history",
        ])
    }

    // MARK: - Connection and exit state (2026-11-10 audit)

    private struct WaitTimeout: Error {}

    private func waitFor(_ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while ContinuousClock.now < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw WaitTimeout()
    }

    private func connectedViewModel() async throws -> (TerminalViewModel, MockWebSocketFactory, BufferWebSocketClient) {
        TestFixtures.saveServerConfig(.init(host: "localhost", port: 8_888, name: nil))
        let factory = MockWebSocketFactory()
        let client = BufferWebSocketClient(webSocketFactory: factory)
        let viewModel = TerminalViewModel(session: TestFixtures.validSession, bufferWebSocketClient: client)
        viewModel.connect()
        try await self.waitFor { viewModel.isConnected }
        #expect(!viewModel.isConnecting)
        #expect(viewModel.errorMessage == nil)
        return (viewModel, factory, client)
    }

    @Test("A session that exits with a code other than 0 keeps its output on screen", arguments: [0, 1, 130])
    func exitKeepsTheTerminal(code: Int) async throws {
        let (viewModel, _, _) = try await self.connectedViewModel()
        let coordinator = RecordingTerminalCoordinator()
        viewModel.terminalCoordinator = coordinator
        let terminalBefore = viewModel.terminalViewId

        viewModel.handleWebSocketEvent(.output(timestamp: 0, data: "make: *** [build] Error 1"))
        viewModel.handleWebSocketEvent(.exit(code: code))

        // The error view replaces the terminal only when errorMessage is set
        #expect(viewModel.errorMessage == nil)
        #expect(!viewModel.isConnecting)
        #expect(viewModel.exitCode == code)
        #expect(!viewModel.isConnected)
        #expect(viewModel.statusBanner == (code == 0 ? "Session ended" : "Session exited with code \(code)"))

        // And it stays so: the old 0.5 s poll rewrote this state
        try await Task.sleep(for: .milliseconds(800))
        #expect(viewModel.errorMessage == nil)
        #expect(viewModel.exitCode == code)
        #expect(!viewModel.isConnected)
        #expect(viewModel.terminalViewId == terminalBefore)
        #expect(coordinator.events == ["output:make: *** [build] Error 1"])
        viewModel.disconnect()
    }

    @Test("A dropped connection keeps the terminal and says it is reconnecting")
    func dropKeepsTheTerminal() async throws {
        let (viewModel, factory, _) = try await self.connectedViewModel()
        let first = try #require(factory.lastCreatedWebSocket)

        first.simulateDisconnection()
        try await self.waitFor { viewModel.isReconnecting }
        #expect(viewModel.errorMessage == nil)
        #expect(!viewModel.isConnecting)
        #expect(viewModel.statusBanner == "Reconnecting…")

        // The socket comes back by itself
        try await self.waitFor { viewModel.isConnected }
        #expect(!viewModel.isReconnecting)
        #expect(viewModel.statusBanner == nil)
        #expect(factory.createdWebSockets.count == 2)
        viewModel.disconnect()
    }

    @Test("Closing the terminal leaves the session's other subscribers alone")
    func closingKeepsOtherSubscribers() async throws {
        let (viewModel, factory, client) = try await self.connectedViewModel()
        var previewSnapshots = 0
        client.subscribe(to: TestFixtures.validSession.id) { event in
            if case .bufferUpdate = event { previewSnapshots += 1 }
        }

        viewModel.disconnect()

        let webSocket = try #require(factory.lastCreatedWebSocket)
        webSocket.simulateMessage(.data(TestFixtures.wrappedV3SnapshotMessage(
            sessionId: TestFixtures.validSession.id,
            bufferData: TestFixtures.bufferSnapshot(cols: 80, rows: 24))))
        try await self.waitFor { previewSnapshots == 1 }
    }
}
