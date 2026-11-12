import Darwin
import Foundation
import OSLog

/// Manages UNIX socket connection for screen capture communication with automatic reconnection
@MainActor
final class UnixSocketConnection {
    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "UnixSocket")

    // MARK: - Properties

    private nonisolated(unsafe) var socketFD: Int32 = -1
    private let socketPath: String
    private let queue = DispatchQueue(label: "com.nachx639.untether.unix-socket", qos: .userInitiated)

    /// Socket state
    private(set) var isConnected = false
    private var isConnecting = false

    /// Buffer for accumulating partial messages
    private var receiveBuffer = Data()

    /// Read source delivering incoming data (replaces a 10 ms polling loop on the main actor)
    private var readSource: DispatchSourceRead?
    /// Identifies the current connection; events from a torn-down connection are ignored
    private var connectionGeneration = 0

    /// Keep-alive timer
    private var keepAliveTimer: Timer?
    private let keepAliveInterval: TimeInterval = 30.0
    private var lastPongTime = Date()

    /// Reconnection management
    private var reconnectTask: Task<Void, Never>?
    private var reconnectDelay: TimeInterval = 1.0
    private let initialReconnectDelay: TimeInterval = 1.0
    private let maxReconnectDelay: TimeInterval = 30.0
    private var isReconnecting = false
    private var shouldReconnect = true
    private var consecutiveFailures = 0

    /// Message handler callback
    var onMessage: ((Data) -> Void)?

    /// Connection state change callback
    var onStateChange: ((ConnectionState) -> Void)?

    /// Connection states for the Unix socket.
    ///
    /// Represents the various states of the socket connection lifecycle,
    /// similar to `NWConnection.State` for consistency with Network framework patterns.
    enum ConnectionState {
        case setup
        case preparing
        case ready
        case failed(Error)
        case cancelled
        case waiting(Error)
    }

    // MARK: - Initialization

    init(socketPath: String? = nil) {
        // Use socket path in user's home directory to avoid /tmp issues
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        self.socketPath = socketPath ?? "\(home)/.untether/control.sock"
        self.logger.info("Unix socket initialized with path: \(self.socketPath)")
    }

    deinit {
        shouldReconnect = false
        // Close socket directly in deinit since we can't call @MainActor methods
        if socketFD >= 0 {
            close(socketFD)
            socketFD = -1
        }
    }

    // MARK: - Public Methods

    /// Connect to the UNIX socket with automatic reconnection
    func connect() {
        self.logger.info("🔌 Connecting to UNIX socket at \(self.socketPath)")

        guard !self.isConnecting, !self.isConnected else {
            self.logger.debug("Already connected or connecting.")
            return
        }

        // A top-level call starts a fresh backoff
        self.shouldReconnect = true
        self.reconnectDelay = self.initialReconnectDelay
        self.consecutiveFailures = 0
        self.reconnectTask?.cancel()
        self.reconnectTask = nil
        self.isReconnecting = false

        self.beginConnection()
    }

    /// Reconnect immediately with a fresh backoff (the server just started), unless connected.
    func reconnectNow() {
        guard !self.isConnected else { return }
        self.logger.info("🔁 Server (re)started, reconnecting control socket now")
        self.shouldReconnect = true
        self.reconnectTask?.cancel()
        self.reconnectTask = nil
        self.isReconnecting = false
        self.reconnectDelay = self.initialReconnectDelay
        self.consecutiveFailures = 0
        self.beginConnection()
    }

    /// Start one connection attempt without touching the backoff state
    private func beginConnection() {
        guard !self.isConnecting else {
            self.logger.debug("Connection attempt already in progress.")
            return
        }

        self.isConnecting = true
        self.onStateChange?(.preparing)

        // Connect on background queue
        self.queue.async { [weak self] in
            self?.establishConnection()
        }
    }

    /// Close the half-built socket and report the failure (on the connect queue)
    private nonisolated func failConnection(_ error: Error) {
        if self.socketFD >= 0 {
            close(self.socketFD)
            self.socketFD = -1
        }
        Task { @MainActor in
            self.handleConnectionError(error)
        }
    }

    /// Establish the actual connection using C socket API
    private nonisolated func establishConnection() {
        // Close any existing socket
        if self.socketFD >= 0 {
            close(self.socketFD)
            self.socketFD = -1
        }

        // Create socket
        self.socketFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard self.socketFD >= 0 else {
            let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .ECONNREFUSED)
            self.logger.error("Failed to create socket: \(error.localizedDescription)")
            Task { @MainActor in
                self.handleConnectionError(error)
            }
            return
        }

        // Set socket buffer sizes for large messages
        var bufferSize: Int32 = 1024 * 1024 // 1MB buffer
        if setsockopt(self.socketFD, SOL_SOCKET, SO_SNDBUF, &bufferSize, socklen_t(MemoryLayout<Int32>.size)) < 0 {
            self.logger.warning("Failed to set send buffer size: \(String(cString: strerror(errno)))")
        }

        if setsockopt(self.socketFD, SOL_SOCKET, SO_RCVBUF, &bufferSize, socklen_t(MemoryLayout<Int32>.size)) < 0 {
            self.logger.warning("Failed to set receive buffer size: \(String(cString: strerror(errno)))")
        }

        // Set socket to non-blocking mode. Every failure below goes through
        // handleConnectionError: returning silently left isConnecting stuck at true, so no
        // later connect() was ever attempted (2026-10-12).
        let flags = fcntl(socketFD, F_GETFL, 0)
        if flags < 0 {
            self.logger.error("Failed to get socket flags")
            self.failConnection(POSIXError(POSIXErrorCode(rawValue: errno) ?? .EBADF))
            return
        }

        if fcntl(self.socketFD, F_SETFL, flags | O_NONBLOCK) < 0 {
            self.logger.error("Failed to set non-blocking mode")
            self.failConnection(POSIXError(POSIXErrorCode(rawValue: errno) ?? .EBADF))
            return
        }

        // Create socket address
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)

        // Copy socket path
        let pathBytes = self.socketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            self.logger.error("Socket path too long")
            self.failConnection(POSIXError(.ENAMETOOLONG))
            return
        }

        withUnsafeMutableBytes(of: &address.sun_path) { ptr in
            pathBytes.withUnsafeBytes { pathPtr in
                ptr.copyMemory(from: pathPtr)
            }
        }

        // Connect to socket
        let result = withUnsafePointer(to: &address) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                Darwin.connect(self.socketFD, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }

        if result < 0 {
            let errorCode = errno
            if errorCode == EINPROGRESS {
                // Connection in progress (non-blocking)
                self.logger.info("Connection in progress...")
                self.waitForConnection()
            } else {
                let error = POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .ECONNREFUSED)
                self.logger.error("Failed to connect: \(error.localizedDescription) (errno: \(errorCode))")
                close(self.socketFD)
                self.socketFD = -1
                Task { @MainActor in
                    self.handleConnectionError(error)
                }
            }
        } else {
            // Connected immediately
            Task { @MainActor in
                self.handleConnectionSuccess()
            }
        }
    }

    /// Wait for non-blocking connection to complete
    private nonisolated func waitForConnection() {
        self.queue.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self else { return }
            guard self.socketFD >= 0 else {
                self.failConnection(UnixSocketError.notConnected)
                return
            }

            var error: Int32 = 0
            var errorLen = socklen_t(MemoryLayout<Int32>.size)

            let result = getsockopt(self.socketFD, SOL_SOCKET, SO_ERROR, &error, &errorLen)

            if result < 0 {
                self.logger.error("Failed to get socket error")
                self.failConnection(POSIXError(POSIXErrorCode(rawValue: errno) ?? .EBADF))
                return
            }

            if error == 0 {
                // Connected successfully
                Task { @MainActor in
                    self.handleConnectionSuccess()
                }
            } else if error == EINPROGRESS {
                // Still connecting
                self.waitForConnection()
            } else {
                // Connection failed
                let posixError = POSIXError(POSIXErrorCode(rawValue: error) ?? .ECONNREFUSED)
                self.logger.error("Connection failed: \(posixError.localizedDescription)")
                close(self.socketFD)
                self.socketFD = -1
                Task { @MainActor in
                    self.handleConnectionError(posixError)
                }
            }
        }
    }

    /// Handle successful connection
    private func handleConnectionSuccess() {
        self.logger.info("✅ UNIX socket connected")
        self.isConnected = true
        self.isConnecting = false
        self.consecutiveFailures = 0
        self.reconnectDelay = self.initialReconnectDelay

        self.onStateChange?(.ready)

        // Start receiving
        self.startReceiving()

        // A new connection starts its pong clock afresh. Without this, one long outage (a
        // server restart over 60 s) left every later connection judged dead at its first
        // keep-alive tick, before it ever sent a ping: a reconnect every ~31 s for good
        // (2026-10-03; the server now also greets with a pong, for builds without this fix).
        self.lastPongTime = Date()

        // Start keep-alive timer
        self.startKeepAlive()
    }

    /// Handle connection error: tear the connection down and schedule a reconnect
    private func handleConnectionError(_ error: Error) {
        // Already torn down by an earlier report of the same failure
        guard self.isConnected || self.isConnecting else { return }
        self.logger.error("❌ Connection failed: \(error)")
        self.isConnected = false
        self.isConnecting = false
        self.consecutiveFailures += 1

        self.onStateChange?(.failed(error))

        // Clean up
        self.cleanupConnection()

        // Schedule reconnection if appropriate
        if self.shouldReconnect {
            self.scheduleReconnect()
        }
    }

    /// Send a message with automatic retry on failure
    func send(_ message: some Encodable) async throws {
        let encoder = JSONEncoder()
        let data = try encoder.encode(message)

        // Log the message content for debugging
        if let str = String(data: data, encoding: .utf8) {
            self.logger.debug("📤 Sending control message: \(String(str.prefix(500)))")
        }

        try await self.sendData(data)
    }

    /// Serial queue for message sending to prevent concurrent writes
    private let sendQueue = DispatchQueue(label: "com.nachx639.untether.unix-socket.send", qos: .userInitiated)

    /// Send raw data with error handling
    func sendRawData(_ data: Data) async throws {
        try await self.sendData(data)
    }

    /// Send data with proper error handling and reconnection
    private func sendData(_ data: Data) async throws {
        guard self.isConnected, self.socketFD >= 0 else {
            throw UnixSocketError.notConnected
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.sendQueue.async { [weak self] in
                guard let self else {
                    continuation.resume(throwing: UnixSocketError.notConnected)
                    return
                }

                // Ensure socket is still valid
                guard self.socketFD >= 0 else {
                    continuation.resume(throwing: UnixSocketError.notConnected)
                    return
                }

                // Create message with 4-byte length header
                let lengthValue = UInt32(data.count).bigEndian
                var headerData = Data()
                withUnsafeBytes(of: lengthValue) { bytes in
                    headerData.append(contentsOf: bytes)
                }
                let fullData = headerData + data

                // Send data in chunks if needed
                var totalSent = 0
                var remainingData = fullData

                while totalSent < fullData.count {
                    let result = remainingData.withUnsafeBytes { ptr in
                        Darwin.send(self.socketFD, ptr.baseAddress, remainingData.count, 0)
                    }

                    if result < 0 {
                        let errorCode = errno
                        // Check if it's EAGAIN (would block) - that's okay for non-blocking
                        if errorCode == EAGAIN || errorCode == EWOULDBLOCK {
                            // Socket buffer is full, wait a bit and retry
                            usleep(1000) // Wait 1ms
                            continue
                        }

                        let error = POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .ECONNREFUSED)
                        Task { @MainActor in
                            self.handleSendError(error, errorCode: errorCode)
                        }
                        continuation.resume(throwing: error)
                        return
                    } else if result == 0 {
                        // Connection closed
                        let error = UnixSocketError.connectionClosed
                        Task { @MainActor in
                            self.logger.error("Connection closed during send")
                        }
                        continuation.resume(throwing: error)
                        return
                    } else {
                        totalSent += result
                        if result < remainingData.count {
                            // Partial send - remove sent bytes and continue
                            remainingData = remainingData.dropFirst(result)
                            let currentTotal = totalSent
                            Task { @MainActor in
                                self.logger.debug("Partial send: \(result) bytes, total: \(currentTotal)/\(data.count)")
                            }
                        } else {
                            // All data sent
                            break
                        }
                    }
                }

                continuation.resume()
            }
        }

        // Add a small delay between messages to prevent concatenation
        try? await Task.sleep(nanoseconds: 5_000_000) // 5ms
    }

    /// Handle send errors and trigger reconnection if needed
    private func handleSendError(_ error: Error, errorCode: Int32) {
        self.logger.error("Failed to send message: \(error)")
        self.logger.error("  Error code: \(errorCode)")

        // Broken pipe, reset, refused, not connected: tear down and reconnect
        if errorCode == EPIPE || errorCode == ECONNRESET || errorCode == ECONNREFUSED || errorCode == ENOTCONN {
            self.logger.warning("🔥 Connection error detected (errno \(errorCode)), triggering reconnection")
            self.handleConnectionError(error)
        }
    }

    /// Disconnect from the socket
    func disconnect() {
        self.logger.info("🔌 Disconnecting from UNIX socket")

        // Stop reconnection attempts
        self.shouldReconnect = false

        // Cancel timers and tasks
        self.keepAliveTimer?.invalidate()
        self.keepAliveTimer = nil

        self.reconnectTask?.cancel()
        self.reconnectTask = nil
        self.isReconnecting = false

        // Stop receiving and close the socket
        self.cleanupConnection()

        self.isConnected = false
        self.isConnecting = false

        self.onStateChange?(.cancelled)
    }

    // MARK: - Private Methods

    /// Clean up connection resources: stop timers and receiving, close the socket
    private func cleanupConnection() {
        self.keepAliveTimer?.invalidate()
        self.keepAliveTimer = nil

        self.connectionGeneration += 1
        self.receiveBuffer.removeAll()

        // The read source's cancel handler closes its descriptor (closing it earlier would
        // let a new socket reuse the number under the source); otherwise close it here.
        let fd = self.socketFD
        self.socketFD = -1
        if let source = self.readSource {
            self.readSource = nil
            source.cancel()
        } else if fd >= 0 {
            self.queue.async {
                close(fd)
            }
        }
    }

    /// Schedule a reconnection attempt
    private func scheduleReconnect() {
        guard self.shouldReconnect, !self.isReconnecting else {
            self.logger
                .debug(
                    "Skipping reconnect: shouldReconnect=\(self.shouldReconnect), isReconnecting=\(self.isReconnecting)")
            return
        }

        self.isReconnecting = true

        // Cancel any existing reconnect task
        self.reconnectTask?.cancel()

        self.logger
            .info(
                "🔄 Scheduling reconnection in \(String(format: "%.1f", self.reconnectDelay)) seconds (attempt #\(self.consecutiveFailures + 1))")

        self.reconnectTask = Task { [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: UInt64(self.reconnectDelay * 1_000_000_000))

                guard !Task.isCancelled, self.shouldReconnect else {
                    self.isReconnecting = false
                    return
                }

                self.logger.info("🔁 Attempting reconnection...")
                self.isReconnecting = false
                // Increase delay for next attempt (exponential backoff). connect() used to
                // reset it here, so the backoff never grew.
                self.reconnectDelay = min(self.reconnectDelay * 1.5, self.maxReconnectDelay)
                self.beginConnection()
            } catch {
                self.isReconnecting = false
                if !Task.isCancelled {
                    self.logger.error("Reconnection task error: \(error)")
                }
            }
        }
    }

    // MARK: - Keep-Alive

    /// Start keep-alive mechanism
    private func startKeepAlive() {
        self.keepAliveTimer?.invalidate()

        self.keepAliveTimer = Timer
            .scheduledTimer(withTimeInterval: self.keepAliveInterval, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in
                    await self?.sendKeepAlive()
                }
            }
    }

    /// Send keep-alive ping
    private func sendKeepAlive() async {
        guard self.isConnected else { return }

        let timeSinceLastPong = Date().timeIntervalSince(self.lastPongTime)
        if timeSinceLastPong > self.keepAliveInterval * 2 {
            self.logger
                .warning("⚠️ No pong received for \(String(format: "%.0f", timeSinceLastPong))s, connection may be dead")
            // Tear the dead connection down before reconnecting: scheduling a reconnect alone
            // left isConnected true, so the new attempt was skipped or raced the old socket.
            self.handleConnectionError(UnixSocketError.connectionClosed)
            return
        }

        let pingMessage = ControlProtocol.systemPingRequest()
        Task {
            do {
                try await self.send(pingMessage)
                self.logger.debug("🏓 Sent keep-alive ping")
            } catch {
                self.logger.error("Failed to send keep-alive ping: \(error)")
            }
        }
    }

    /// Start receiving with a read source on the connect queue
    private func startReceiving() {
        self.readSource?.cancel()

        let fd = self.socketFD
        guard fd >= 0 else { return }
        let generation = self.connectionGeneration

        let source = Self.makeReceiveSource(fd: fd, queue: self.queue) { [weak self] event in
            guard let self, self.connectionGeneration == generation else { return }
            switch event {
            case let .data(data):
                self.processReceivedData(data)
            case .closed:
                self.logger.warning("⚠️ Connection closed by peer (recv returned 0)")
                self.handleConnectionError(UnixSocketError.connectionClosed)
            case let .failed(errorCode):
                let error = POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .ECONNRESET)
                self.logger.error("Receive error: \(error) (errno: \(errorCode))")
                self.handleConnectionError(error)
            }
        }
        self.readSource = source
        source.activate()
    }

    private enum ReceiveEvent: Sendable {
        case data(Data)
        case closed
        case failed(Int32)
    }

    /// Built outside the main actor on purpose: a handler closure written inside this @MainActor
    /// class inherits main-actor isolation, and running it on `queue` trips Swift 6's runtime
    /// isolation check (2026-10-12: Untether crashed with EXC_BREAKPOINT in
    /// `closure #1 in startReceiving()` on its first control-socket read).
    private nonisolated static func makeReceiveSource(
        fd: Int32,
        queue: DispatchQueue,
        onEvent: @escaping @MainActor @Sendable (ReceiveEvent) -> Void)
        -> DispatchSourceRead
    {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak source] in
            var buffer = [UInt8](repeating: 0, count: 65536)
            let bytesRead = recv(fd, &buffer, buffer.count, 0)

            let event: ReceiveEvent
            if bytesRead > 0 {
                event = .data(Data(buffer[0..<bytesRead]))
            } else {
                let errorCode = errno
                if bytesRead < 0, errorCode == EAGAIN || errorCode == EWOULDBLOCK || errorCode == EINTR {
                    return
                }
                // Peer closed or a receive error: stop this source and tear down on the main actor
                source?.cancel()
                event = bytesRead == 0 ? .closed : .failed(errorCode)
            }
            // main.async keeps chunks in arrival order (Task hops to the main actor need not).
            DispatchQueue.main.async {
                MainActor.assumeIsolated { onEvent(event) }
            }
        }
        source.setCancelHandler {
            close(fd)
        }
        return source
    }

    /// Process received data with proper message framing
    private func processReceivedData(_ data: Data) {
        self.logger.debug("📥 Received \(data.count) bytes of data")
        self.receiveBuffer.append(data)
        self.logger.debug("📦 Buffer now contains \(self.receiveBuffer.count) bytes")

        // Process as many messages as we can from the buffer
        while self.receiveBuffer.count >= 4 {
            // Read the message length header (4 bytes, big-endian UInt32)
            let messageLength = self.receiveBuffer.prefix(4)
                .withUnsafeBytes { UInt32(bigEndian: $0.loadUnaligned(as: UInt32.self)) }

            self.logger.debug("📏 Next message length from header: \(messageLength) bytes")

            // Check against reasonable upper bound to guard against corrupted headers
            guard messageLength < 10_000_000 else { // 10MB max message size (matching Node.js peer)
                self.logger.error("Corrupted message header: length=\(messageLength)")
                self.receiveBuffer.removeAll() // Clear corrupted buffer
                break
            }

            let needed = Int(messageLength) + 4
            guard self.receiveBuffer.count >= needed else { break }

            // Extract the complete message body (skip the 4-byte header)
            let body = Data(receiveBuffer.dropFirst(4).prefix(Int(messageLength)))
            self.receiveBuffer.removeFirst(needed)

            // Check for keep-alive pong
            if let msgDict = JSONValue.decodeObject(from: body),
               msgDict["type"]?.string == "response",
               msgDict["category"]?.string == "system",
               msgDict["action"]?.string == "ping"
            {
                self.lastPongTime = Date()
                self.logger.debug("🏓 Received keep-alive pong")
                continue
            }

            // Deliver the complete message
            if let str = String(data: body, encoding: .utf8) {
                self.logger.debug("📨 Delivering message (\(body.count) bytes): \(String(str.prefix(500)))")
            }

            if let handler = onMessage {
                handler(body)
            } else {
                self.logger.warning("⚠️ No message handler registered - message will be dropped!")
            }
        }

        // If buffer grows too large, clear it to prevent memory issues
        if self.receiveBuffer.count > 10 * 1024 * 1024 { // 10MB limit (matching Node.js peer)
            self.logger.warning("Receive buffer exceeded 10MB, clearing to prevent memory issues")
            self.receiveBuffer.removeAll()
        }
    }
}

// MARK: - Errors

/// Errors specific to Unix socket operations.
///
/// Provides detailed error information for Unix socket connection failures,
/// data transmission issues, and connection state problems.
enum UnixSocketError: LocalizedError {
    case notConnected
    case connectionFailed(Error)
    case sendFailed(Error)
    case connectionClosed

    var errorDescription: String? {
        switch self {
        case .notConnected:
            String(localized: "UNIX socket not connected", comment: "Error: connection to the local server")
        case let .connectionFailed(error):
            String(localized: "Connection failed: \(error.localizedDescription)", comment: "Error: connection to the local server")
        case let .sendFailed(error):
            String(localized: "Send failed: \(error.localizedDescription)", comment: "Error: connection to the local server")
        case .connectionClosed:
            String(localized: "Connection closed by peer", comment: "Error: connection to the local server")
        }
    }
}
