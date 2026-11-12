import Foundation

/// Terminal event types that match the server's output.
/// Represents various events that can occur during terminal interaction.
enum TerminalWebSocketEvent {
    case replayStarted
    case header(width: Int, height: Int)
    case output(timestamp: Double, data: String)
    case resize(timestamp: Double, dimensions: String)
    case exit(code: Int)
    case bufferUpdate(snapshot: BufferSnapshot)
    case bell
    case alert(title: String?, message: String)
}

enum TerminalSubscriptionMode: Equatable {
    case snapshots
    case stdout
}

/// Binary buffer snapshot data.
/// Contains the complete terminal buffer state including cells, cursor position, and viewport.
struct BufferSnapshot {
    let cols: Int
    let rows: Int
    let viewportY: Int
    let cursorX: Int
    let cursorY: Int
    let cells: [[BufferCell]]
}

/// Individual cell data.
/// Represents a single character cell in the terminal with its styling attributes.
/// `fg` and `bg` are always RGB (0xRRGGBB), nil for the terminal's default colour: the
/// server never sends a palette index (BufferCell in web/src/shared/terminal-text-formatter.ts).
struct BufferCell {
    let char: String
    let fg: Int?
    let bg: Int?
    let attributes: Int?
}

/// Errors that can occur during WebSocket operations.
enum WebSocketError: Error {
    case invalidURL
    case connectionFailed
    case invalidData
    case invalidMagicByte
}

/// WebSocket client for real-time terminal buffer streaming.
///
/// BufferWebSocketClient establishes a WebSocket connection to the server
/// to receive terminal output and events in real-time. It handles automatic
/// reconnection, binary message parsing, and event distribution to subscribers.
@MainActor
@Observable
class BufferWebSocketClient: NSObject {
    static let shared = BufferWebSocketClient()

    private let logger = Logger(category: "BufferWebSocket")
    // WebSocket v3 framing
    private static let v3Magic: UInt16 = 0x5654 // "VT" LE
    private static let v3Version: UInt8 = 0x03

    private enum V3Type: UInt8 {
        case welcome = 2

        case subscribe = 10
        case unsubscribe = 11

        case stdout = 20
        case snapshotVT = 21
        case event = 22
        case error = 23

        case inputText = 30
        case inputKey = 31
        case resize = 32
        case kill = 33
        case resetSize = 34

        case ping = 40
        case pong = 41
    }

    private enum V3SubscribeFlags: UInt32 {
        case stdout = 1
        case snapshots = 2
        case events = 4
    }

    private struct V3Frame {
        let type: UInt8
        let sessionId: String
        let payload: Data
    }

    private struct Subscription {
        let mode: TerminalSubscriptionMode
        let handler: @MainActor (TerminalWebSocketEvent) -> Void
    }

    /// One subscriber of a session. Several can watch the same session at once (its card's
    /// live preview and its open terminal): each gets its own token and leaves on its own.
    struct SubscriptionToken: Hashable {
        let sessionId: String
        fileprivate let id = UUID()
    }

    /// Close code the server sends when the token it was given is expired or invalid
    /// (web/src/server/middleware/ws-auth-reject.ts, WS_CLOSE_TOKEN_INVALID).
    static let tokenInvalidCloseCode = 4401

    private var webSocket: WebSocketProtocol?
    private let webSocketFactory: WebSocketFactory
    private var subscriptions = [String: [UUID: Subscription]]()
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    private var hasConnected = false
    private var isConnecting = false
    private var pingTask: Task<Void, Never>?
    private(set) var authenticationService: AuthenticationService?

    // Observable properties
    private(set) var isConnected = false
    private(set) var connectionError: Error?
    /// The server refused the token (close 4401). Reconnecting with the same token can only be
    /// refused again, so the client stays stopped until a new login installs its auth service.
    private(set) var authenticationRequired = false

    /// Called once when the server refuses the token, so the app can ask for a login.
    var onAuthenticationRequired: (@MainActor () -> Void)?

    /// A fixed server for this client (tests); the shared client follows the saved connection.
    private let fixedBaseURL: URL?

    private var baseURL: URL? {
        if let fixedBaseURL { return fixedBaseURL }
        guard let config = UserDefaults.standard.data(forKey: "savedServerConfig"),
              let serverConfig = try? JSONDecoder().decode(ServerConfig.self, from: config)
        else {
            return nil
        }
        // Use connectionURL to get the best URL (HTTPS when available)
        return serverConfig.connectionURL()
    }

    init(webSocketFactory: WebSocketFactory = DefaultWebSocketFactory(), baseURL: URL? = nil) {
        self.webSocketFactory = webSocketFactory
        self.fixedBaseURL = baseURL
        super.init()
    }

    /// Set the authentication service for WebSocket connections
    func setAuthenticationService(_ authService: AuthenticationService) {
        self.authenticationService = authService
        self.authenticationRequired = false
    }

    func connect() {
        guard !self.isConnecting else {
            self.logger.warning("Already connecting, ignoring connect() call")
            return
        }
        guard !self.isConnected else {
            self.logger.warning("Already connected, ignoring connect() call")
            return
        }
        guard !self.authenticationRequired else {
            self.logger.warning("Token refused by the server, not connecting until the next login")
            return
        }
        guard let baseURL else {
            self.connectionError = WebSocketError.invalidURL
            return
        }

        self.isConnecting = true
        self.connectionError = nil

        // Convert HTTP URL to WebSocket URL
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        components?.path = "/ws"

        // Add authentication token as query parameter (not header)
        if let token = authenticationService?.getTokenForQuery() {
            components?.queryItems = [URLQueryItem(name: "token", value: token)]
        }

        guard let wsURL = components?.url else {
            self.connectionError = WebSocketError.invalidURL
            self.isConnecting = false
            return
        }

        // Never log wsURL itself: its query carries the auth token
        self.logger.info("Connecting to \(wsURL.scheme ?? "ws")://\(wsURL.host ?? "?")\(wsURL.path)")

        // Disconnect existing WebSocket if any
        self.dropWebSocket()

        // Create new WebSocket
        let webSocket = self.webSocketFactory.createWebSocket()
        webSocket.delegate = self
        self.webSocket = webSocket

        // Build headers
        var headers: [String: String] = [:]

        // Add authentication header from authentication service
        if let authHeaders = authenticationService?.getAuthHeader() {
            headers.merge(authHeaders) { _, new in new }
        }

        // Connect
        Task {
            do {
                try await webSocket.connect(to: wsURL, with: headers)
            } catch {
                // A socket that was replaced or dropped meanwhile is no longer ours to retry
                guard webSocket === self.webSocket else { return }
                self.logger.error("Connection failed: \(error)")
                self.connectionError = error
                self.handleDisconnection()
            }
        }
    }

    private func handleMessage(_ message: WebSocketMessage) {
        switch message {
        case let .data(data):
            self.handleBinaryMessage(data)

        case let .string(text):
            self.handleTextMessage(text)
        }
    }

    private func handleTextMessage(_ text: String) {
        // v3 is binary-framed. Keep logging for debugging only.
        self.logger.debug("Received text WS message (ignored): \(text.prefix(80))")
    }

    private func handleBinaryMessage(_ data: Data) {
        guard let frame = self.decodeV3Frame(data) else {
            self.logger.debug("Failed to decode v3 frame (\(data.count) bytes)")
            return
        }

        guard let type = V3Type(rawValue: frame.type) else {
            self.logger.debug("Unknown v3 message type: \(frame.type)")
            return
        }

        let sessionId = frame.sessionId
        let payload = frame.payload

        switch type {
        case .snapshotVT:
            if let event = decodeTerminalEvent(from: payload) {
                // Byte 3 of the snapshot header carries the flags; bit 0 is the bell
                if payload.count > 3, payload[payload.startIndex + 3] & 0x01 != 0 {
                    self.deliver(.bell, to: sessionId, mode: .snapshots)
                }
                self.deliver(event, to: sessionId, mode: .snapshots)
            }

        case .event:
            self.handleV3Event(sessionId: sessionId, payload: payload)

        case .stdout:
            if let text = String(data: payload, encoding: .utf8) {
                self.deliver(
                    .output(timestamp: Date().timeIntervalSince1970, data: text),
                    to: sessionId,
                    mode: .stdout)
            }

        case .error:
            // The payload is JSON: {"message": "..."}
            struct ServerError: Decodable { let message: String }
            let message = (try? JSONDecoder().decode(ServerError.self, from: payload))?.message
                ?? String(data: payload, encoding: .utf8) ?? "Unknown error"
            self.logger.warning("Server error: \(message)")
            self.deliver(.alert(title: "Server Error", message: message), to: sessionId)

        default:
            break
        }
    }

    private func handleV3Event(sessionId: String, payload: Data) {
        guard self.subscriptions[sessionId] != nil else { return }
        struct V3Event: Decodable {
            let kind: String
            let exitCode: Int?
            let dimensions: String?
            let header: AsciinemaHeader?
        }

        guard let event = try? JSONDecoder().decode(V3Event.self, from: payload) else {
            return
        }

        switch event.kind {
        case "exit":
            self.deliver(.exit(code: event.exitCode ?? 0), to: sessionId)
        case "header":
            if let header = event.header {
                self.deliver(.header(width: header.width, height: header.height), to: sessionId)
            }
        case "resize":
            if let dimensions = event.dimensions {
                self.deliver(
                    .resize(timestamp: Date().timeIntervalSince1970, dimensions: dimensions),
                    to: sessionId)
            }
        default:
            break
        }
    }

    /// Hands an event to the session's subscribers: all of them, or only those of one stream
    /// (stdout goes to terminals, snapshots to previews).
    private func deliver(
        _ event: TerminalWebSocketEvent,
        to sessionId: String,
        mode: TerminalSubscriptionMode? = nil)
    {
        guard let subscribers = subscriptions[sessionId] else { return }
        for subscription in subscribers.values where mode == nil || subscription.mode == mode {
            subscription.handler(event)
        }
    }

    private func decodeTerminalEvent(from data: Data) -> TerminalWebSocketEvent? {
        // This is binary buffer data, not JSON
        // Decode the binary terminal buffer
        guard let bufferSnapshot = decodeBinaryBuffer(data) else {
            self.logger.debug("Failed to decode binary buffer")
            return nil
        }

        self.logger.verbose("Decoded buffer: \(bufferSnapshot.cols)x\(bufferSnapshot.rows)")

        // Return buffer update event
        return .bufferUpdate(snapshot: bufferSnapshot)
    }

    /// Version byte of the binary snapshot and the bits of a cell's type byte: the mirror of
    /// SNAPSHOT_VERSION and CELL_TYPE in web/src/shared/terminal-text-formatter.ts, which the
    /// server encodes with. They change together (2026-11-11: colours are always three RGB
    /// bytes; a low value such as pure blue, 0x0000FF, used to travel as a palette index).
    private static let snapshotVersion: UInt8 = 0x02
    private enum CellType {
        static let extended: UInt8 = 0x80
        static let unicode: UInt8 = 0x40
        static let hasFg: UInt8 = 0x20
        static let hasBg: UInt8 = 0x10
        static let charMask: UInt8 = 0x03
    }

    private func decodeBinaryBuffer(_ data: Data) -> BufferSnapshot? {
        var offset = 0

        // Read header: 28 bytes (magic 2, version 1, flags 1, then six 32-bit fields), as
        // encodeSnapshot writes it in web/src/server/services/terminal-manager.ts
        guard data.count >= 28 else {
            self.logger.debug("Buffer too small for header: \(data.count) bytes (need 28)")
            return nil
        }

        // Magic bytes "VT" (0x5654 in little endian)
        let magic = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: offset, as: UInt16.self).littleEndian
        }
        offset += 2

        guard magic == 0x5654 else {
            self.logger.warning("Invalid magic bytes: \(String(format: "0x%04X", magic)), expected 0x5654")
            return nil
        }

        // Version
        let version = data[offset]
        offset += 1

        guard version == Self.snapshotVersion else {
            self.logger.warning("Unsupported version: 0x\(String(format: "%02X", version)), expected 0x02")
            return nil
        }

        // Flags
        let flags = data[offset]
        offset += 1

        // The bell flag (bit 0) is handled by the caller, which knows the session
        _ = flags

        // Dimensions and cursor - validate before reading
        guard offset + 20 <= data.count else {
            self.logger.debug("Insufficient data for header fields")
            return nil
        }

        let cols = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian
        }
        offset += 4

        let rows = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian
        }
        offset += 4

        // Validate dimensions
        guard cols > 0 && cols <= 1000 && rows > 0 && rows <= 1000 else {
            self.logger.warning("Invalid dimensions: \(cols)x\(rows)")
            return nil
        }

        let viewportY = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: offset, as: Int32.self).littleEndian
        }
        offset += 4

        let cursorX = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: offset, as: Int32.self).littleEndian
        }
        offset += 4

        let cursorY = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: offset, as: Int32.self).littleEndian
        }
        offset += 4

        // Skip reserved
        offset += 4

        // Validate cursor position
        if cursorX < 0 || cursorX > Int32(cols) || cursorY < 0 || cursorY > Int32(rows) {
            self.logger.debug(
                "Warning: cursor position out of bounds: (\(cursorX),\(cursorY)) for \(cols)x\(rows)")
        }

        // Decode cells
        var cells: [[BufferCell]] = []
        var totalRows = 0

        while offset < data.count, totalRows < Int(rows) {
            guard offset < data.count else {
                self.logger.debug("Unexpected end of data at offset \(offset)")
                break
            }

            let marker = data[offset]
            offset += 1

            if marker == 0xFE {
                // Empty row(s)
                guard offset < data.count else {
                    self.logger.debug("Missing count byte for empty rows")
                    break
                }

                let count = Int(data[offset])
                offset += 1

                for _ in 0..<min(count, Int(rows) - totalRows) {
                    cells.append([])
                    totalRows += 1
                }
            } else if marker == 0xFD {
                // Row with content
                guard offset + 2 <= data.count else {
                    self.logger.debug("Insufficient data for cell count")
                    break
                }

                let cellCount = data.withUnsafeBytes { bytes in
                    bytes.loadUnaligned(fromByteOffset: offset, as: UInt16.self).littleEndian
                }
                offset += 2

                // Validate cell count (the server sends one cell per character, a wide one
                // included, so never more than the columns)
                guard cellCount <= cols else {
                    self.logger.debug("Invalid cell count: \(cellCount) for \(cols) columns")
                    break
                }

                var rowCells: [BufferCell] = []
                var rowIsComplete = true

                // Every cell the row announces is read: the bytes of the next row start right
                // after the last one. 2026-11-10: the loop stopped when an estimated display
                // width passed the columns (an emoji-looking character such as ⏺ counted
                // double), the next read landed in the middle of the row and the rest of the
                // snapshot came out blank.
                for i in 0..<cellCount {
                    if let (cell, newOffset) = decodeCell(data, offset: offset) {
                        rowCells.append(cell)
                        offset = newOffset
                    } else {
                        rowIsComplete = false
                        self.logger.debug("Failed to decode cell \(i) in row \(totalRows) at offset \(offset)")
                        // Log the type byte for debugging
                        if offset < data.count {
                            let typeByte = data[offset]
                            self.logger.verbose("Type byte: 0x\(String(format: "%02X", typeByte))")
                            self.logger
                                .verbose(
                                    "Bits: hasExt=\((typeByte & CellType.extended) != 0), isUni=\((typeByte & CellType.unicode) != 0), hasFg=\((typeByte & CellType.hasFg) != 0), hasBg=\((typeByte & CellType.hasBg) != 0), charType=\(typeByte & CellType.charMask)")
                        }
                        break
                    }
                }

                cells.append(rowCells)
                totalRows += 1
                // A row cut short leaves the offset inside it: nothing after it can be read
                if !rowIsComplete { break }
            } else {
                self.logger.debug(
                    "Unknown row marker: 0x\(String(format: "%02X", marker)) at offset \(offset - 1)")
                // Log surrounding bytes for debugging
                let context = 10
                let start = max(0, offset - 1 - context)
                let end = min(data.count, offset - 1 + context)
                var contextBytes = ""
                for i in start..<end {
                    if i == offset - 1 {
                        contextBytes += "[\(String(format: "%02X", data[i]))] "
                    } else {
                        contextBytes += "\(String(format: "%02X", data[i])) "
                    }
                }
                self.logger.verbose("Context bytes: \(contextBytes)")
                // Skip this byte and try to continue parsing
                break
            }
        }

        // Fill missing rows with empty rows if needed
        while cells.count < Int(rows) {
            cells.append([])
        }

        self.logger.verbose("Successfully decoded buffer: \(cols)x\(rows), \(cells.count) rows")

        return BufferSnapshot(
            cols: Int(cols),
            rows: Int(rows),
            viewportY: Int(viewportY),
            cursorX: Int(cursorX),
            cursorY: Int(cursorY),
            cells: cells)
    }

    private func decodeCell(_ data: Data, offset: Int) -> (BufferCell, Int)? {
        guard offset < data.count else {
            self.logger.debug("Cell decode failed: offset \(offset) beyond data size \(data.count)")
            return nil
        }

        var currentOffset = offset
        let typeByte = data[currentOffset]
        currentOffset += 1

        // Simple space optimization
        if typeByte == 0x00 {
            return (BufferCell(char: " ", fg: nil, bg: nil, attributes: nil), currentOffset)
        }

        // Decode type byte
        let hasExtended = (typeByte & CellType.extended) != 0
        let isUnicode = (typeByte & CellType.unicode) != 0
        let hasFg = (typeByte & CellType.hasFg) != 0
        let hasBg = (typeByte & CellType.hasBg) != 0
        let charType = typeByte & CellType.charMask

        // Read character
        var char: String

        if charType == 0x00 {
            // Simple space
            char = " "
        } else if isUnicode {
            // Unicode character
            // Read character length first
            guard currentOffset < data.count else {
                self.logger.debug("Unicode char decode failed: missing length byte")
                return nil
            }
            let charLen = Int(data[currentOffset])
            currentOffset += 1

            guard currentOffset + charLen <= data.count else {
                self.logger.debug("Unicode char decode failed: insufficient data for char length \(charLen)")
                return nil
            }

            let charData = data.subdata(in: currentOffset..<(currentOffset + charLen))
            char = String(data: charData, encoding: .utf8) ?? "?"
            currentOffset += charLen
        } else {
            // ASCII character
            guard currentOffset < data.count else {
                self.logger.debug("ASCII char decode failed: missing char byte")
                return nil
            }
            let charCode = data[currentOffset]
            currentOffset += 1

            if charCode < 32 || charCode > 126 {
                // Control character or extended ASCII
                char = charCode == 0 ? " " : "?"
            } else {
                char = String(Character(UnicodeScalar(charCode)))
            }
        }

        // Read extended data if present
        var fg: Int?
        var bg: Int?
        var attributes: Int?

        if hasExtended {
            // Read attributes byte
            guard currentOffset < data.count else {
                self.logger.debug("Extended data decode failed: missing attributes byte")
                return nil
            }
            attributes = Int(data[currentOffset])
            currentOffset += 1

            // Colours: three bytes each (red, green, blue), foreground first
            if hasFg {
                guard let color = self.readRgb(data, offset: currentOffset) else {
                    self.logger.debug("Foreground decode failed: insufficient data")
                    return nil
                }
                fg = color
                currentOffset += 3
            }
            if hasBg {
                guard let color = self.readRgb(data, offset: currentOffset) else {
                    self.logger.debug("Background decode failed: insufficient data")
                    return nil
                }
                bg = color
                currentOffset += 3
            }
        }

        return (BufferCell(char: char, fg: fg, bg: bg, attributes: attributes), currentOffset)
    }

    private func readRgb(_ data: Data, offset: Int) -> Int? {
        guard offset + 3 <= data.count else { return nil }
        return (Int(data[offset]) << 16) | (Int(data[offset + 1]) << 8) | Int(data[offset + 2])
    }

    /// Adds a subscriber to a session and returns its token (pass it to `unsubscribe`).
    /// The socket connects on its own with the first subscriber: the session list's live
    /// previews must not depend on a terminal having been opened first.
    @discardableResult
    func subscribe(
        to sessionId: String,
        mode: TerminalSubscriptionMode = .snapshots,
        handler: @escaping @MainActor (TerminalWebSocketEvent) -> Void)
        -> SubscriptionToken
    {
        let token = SubscriptionToken(sessionId: sessionId)
        let streamsBefore = self.streams(for: sessionId)
        self.subscriptions[sessionId, default: [:]][token.id] = Subscription(mode: mode, handler: handler)

        if self.isConnected {
            // Only when this subscriber adds a stream: a repeated SUBSCRIBE with the same
            // flags would make the server replay the session
            if self.streams(for: sessionId) != streamsBefore {
                self.sendSubscriptionState(for: sessionId)
            }
        } else if !self.isConnecting, self.reconnectTask == nil {
            self.connect()
        }
        return token
    }

    /// Removes one subscriber. The session's other subscribers keep receiving.
    func unsubscribe(_ token: SubscriptionToken) {
        let sessionId = token.sessionId
        guard var subscribers = subscriptions[sessionId], subscribers[token.id] != nil else { return }
        let streamsBefore = self.streams(for: sessionId)
        subscribers.removeValue(forKey: token.id)
        self.subscriptions[sessionId] = subscribers.isEmpty ? nil : subscribers

        if self.isConnected, self.streams(for: sessionId) != streamsBefore {
            self.sendSubscriptionState(for: sessionId)
        }
    }

    /// The streams the session's subscribers need between them.
    private func streams(for sessionId: String) -> Set<TerminalSubscriptionMode> {
        Set((self.subscriptions[sessionId] ?? [:]).values.map(\.mode))
    }

    /// Tells the server what this client wants of a session now: the union of its subscribers'
    /// streams (the server keeps one subscription per session and socket), or nothing.
    private func sendSubscriptionState(for sessionId: String) {
        let streams = self.streams(for: sessionId)
        Task { @MainActor [weak self] in
            guard let self else { return }
            if streams.isEmpty {
                try? await self.sendV3Unsubscribe(sessionId: sessionId)
            } else {
                try? await self.sendV3Subscribe(sessionId: sessionId, streams: streams)
            }
        }
    }

    private func sendV3Subscribe(sessionId: String, streams: Set<TerminalSubscriptionMode>) async throws {
        var flags = V3SubscribeFlags.events.rawValue
        if streams.contains(.snapshots) { flags |= V3SubscribeFlags.snapshots.rawValue }
        if streams.contains(.stdout) { flags |= V3SubscribeFlags.stdout.rawValue }
        var payload = Data(count: 12)
        payload.withUnsafeMutableBytes { bytes in
            bytes.storeBytes(of: flags.littleEndian, toByteOffset: 0, as: UInt32.self)
            bytes.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 4, as: UInt32.self)
            bytes.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 8, as: UInt32.self)
        }
        try await self.sendV3Frame(type: .subscribe, sessionId: sessionId, payload: payload)
    }

    private func sendV3Unsubscribe(sessionId: String) async throws {
        try await self.sendV3Frame(type: .unsubscribe, sessionId: sessionId, payload: Data())
    }

    func sendInput(sessionId: String, text: String) async -> Bool {
        guard let webSocket else {
            return false
        }

        guard let payload = text.data(using: .utf8) else { return false }
        do {
            let frame = try self.encodeV3Frame(type: .inputText, sessionId: sessionId, payload: payload)
            try await webSocket.send(.data(frame))
            return true
        } catch {
            self.logger.error("Failed to send input over v3 socket: \(error)")
            return false
        }
    }

    func resize(sessionId: String, cols: Int, rows: Int) async -> Bool {
        guard let webSocket else { return false }
        // cols u32, rows u32, flags u32 (0: this app never claims the size). The server takes
        // no shorter RESIZE (web/src/shared/ws-v3.ts).
        var payload = Data(count: 12)
        payload.withUnsafeMutableBytes { bytes in
            bytes.storeBytes(of: UInt32(cols).littleEndian, toByteOffset: 0, as: UInt32.self)
            bytes.storeBytes(of: UInt32(rows).littleEndian, toByteOffset: 4, as: UInt32.self)
            bytes.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 8, as: UInt32.self)
        }
        do {
            let frame = try self.encodeV3Frame(type: .resize, sessionId: sessionId, payload: payload)
            try await webSocket.send(.data(frame))
            return true
        } catch {
            self.logger.error("Failed to send resize over v3 socket: \(error)")
            return false
        }
    }

    private func sendV3Frame(type: V3Type, sessionId: String, payload: Data) async throws {
        guard let webSocket else { throw WebSocketError.connectionFailed }
        let frame = try self.encodeV3Frame(type: type, sessionId: sessionId, payload: payload)
        try await webSocket.send(.data(frame))
    }

    private func encodeV3Frame(type: V3Type, sessionId: String, payload: Data) throws -> Data {
        guard let sessionIdData = sessionId.data(using: .utf8) else { throw WebSocketError.invalidData }
        var out = Data()

        var magicLE = Self.v3Magic.littleEndian
        out.append(Data(bytes: &magicLE, count: 2))
        out.append(Self.v3Version)
        out.append(type.rawValue)

        var sessionLenLE = UInt32(sessionIdData.count).littleEndian
        out.append(Data(bytes: &sessionLenLE, count: 4))
        out.append(sessionIdData)

        var payloadLenLE = UInt32(payload.count).littleEndian
        out.append(Data(bytes: &payloadLenLE, count: 4))
        out.append(payload)

        return out
    }

    private func decodeV3Frame(_ data: Data) -> V3Frame? {
        guard data.count >= 2 + 1 + 1 + 4 + 4 else { return nil }
        var offset = 0

        let magic = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: offset, as: UInt16.self).littleEndian
        }
        offset += 2
        guard magic == Self.v3Magic else { return nil }

        let version = data[offset]
        offset += 1
        guard version == Self.v3Version else { return nil }

        let type = data[offset]
        offset += 1

        let sessionLen = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian
        }
        offset += 4

        guard data.count >= offset + Int(sessionLen) + 4 else { return nil }
        let sessionIdData = data.subdata(in: offset..<(offset + Int(sessionLen)))
        offset += Int(sessionLen)
        guard let sessionId = String(data: sessionIdData, encoding: .utf8) else { return nil }

        let payloadLen = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian
        }
        offset += 4

        guard data.count >= offset + Int(payloadLen) else { return nil }
        let payload = data.subdata(in: offset..<(offset + Int(payloadLen)))
        return V3Frame(type: type, sessionId: sessionId, payload: payload)
    }

    private func sendPing() async throws {
        guard let webSocket else {
            throw WebSocketError.connectionFailed
        }
        try await webSocket.sendPing()
    }

    private func startPingTask() {
        self.stopPingTask()

        self.pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000) // 30 seconds
                if !Task.isCancelled {
                    try? await self?.sendPing()
                }
            }
        }
    }

    private func stopPingTask() {
        self.pingTask?.cancel()
        self.pingTask = nil
    }

    private func handleDisconnection() {
        self.isConnected = false
        self.isConnecting = false
        self.dropWebSocket()
        self.stopPingTask()
        // Nobody is listening: the next subscriber connects again
        guard !self.subscriptions.isEmpty else { return }
        self.scheduleReconnect()
    }

    /// Lets go of the current socket without hearing from it again: its late callbacks (the
    /// close it reports when cancelled) must not count as the end of the socket that replaces it.
    private func dropWebSocket() {
        guard let old = webSocket else { return }
        self.webSocket = nil
        old.delegate = nil
        old.disconnect(with: .goingAway, reason: nil)
    }

    private func scheduleReconnect() {
        guard self.reconnectTask == nil else { return }

        let delay = ReconnectionManager.calculateBackoff(
            attempt: self.reconnectAttempts + 1,
            maxDelay: 30.0)
        self.reconnectAttempts += 1

        self.logger.info("Reconnecting in \(delay)s (attempt \(self.reconnectAttempts))")

        self.reconnectTask = Task { @MainActor [weak self] in
            let nanoseconds = UInt64(delay * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanoseconds)

            if !Task.isCancelled {
                self?.reconnectTask = nil
                self?.connect()
            }
        }
    }

    /// Closes the connection (logout, another server, a refused token) and does not reconnect
    /// by itself. The subscribers stay: they belong to the views, which leave on their own
    /// when they go away, and whatever is still on screen (a card's preview, an open
    /// terminal) is subscribed again by the next connection (`reconnectIfNeeded`, a new
    /// subscriber or `connect`). Dropping them here left those views frozen after a new login.
    func disconnect() {
        self.reconnectTask?.cancel()
        self.reconnectTask = nil
        self.stopPingTask()
        self.dropWebSocket()

        self.isConnected = false
        self.isConnecting = false
        self.hasConnected = false
        self.reconnectAttempts = 0
        self.connectionError = nil
    }

    /// Connects again when somebody is still subscribed (after a login, or once the app is
    /// connected to a server again).
    func reconnectIfNeeded() {
        guard !self.subscriptions.isEmpty, !self.isConnected, !self.isConnecting else { return }
        self.connect()
    }

    /// The server refused the token: stop for good and let the app ask for a login.
    private func stopForRefusedToken() {
        self.logger.warning("Server refused the token (close 4401): stopping until the next login")
        self.disconnect()
        self.authenticationRequired = true
        self.onAuthenticationRequired?()
    }

    deinit {
        // Tasks will be cancelled automatically when the object is deallocated
        // WebSocket cleanup happens in disconnect()
    }
}

// MARK: - WebSocketDelegate

extension BufferWebSocketClient: WebSocketDelegate {
    // Every callback checks that it comes from the current socket: one that was replaced or
    // dropped still reports its own end later.

    func webSocketDidConnect(_ webSocket: WebSocketProtocol) {
        guard webSocket === self.webSocket else { return }
        self.logger.info("Connected")
        let isReconnect = self.hasConnected
        self.hasConnected = true
        self.isConnected = true
        self.isConnecting = false
        self.reconnectAttempts = 0
        self.connectionError = nil
        self.startPingTask()

        // Re-subscribe to all sessions that have handlers
        for (sessionId, subscribers) in self.subscriptions {
            if isReconnect {
                for subscription in subscribers.values where subscription.mode == .stdout {
                    subscription.handler(.replayStarted)
                }
            }
            self.sendSubscriptionState(for: sessionId)
        }
    }

    func webSocket(_ webSocket: WebSocketProtocol, didReceiveMessage message: WebSocketMessage) {
        guard webSocket === self.webSocket else { return }
        self.handleMessage(message)
    }

    func webSocket(_ webSocket: WebSocketProtocol, didFailWithError error: Error) {
        guard webSocket === self.webSocket else { return }
        self.logger.error("Error: \(error)")
        self.connectionError = error
        self.handleDisconnection()
    }

    func webSocketDidDisconnect(
        _ webSocket: WebSocketProtocol,
        closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?)
    {
        guard webSocket === self.webSocket else { return }
        self.logger.info("Disconnected with code: \(closeCode.rawValue)")
        if closeCode.rawValue == Self.tokenInvalidCloseCode {
            self.stopForRefusedToken()
            return
        }
        self.handleDisconnection()
    }
}
