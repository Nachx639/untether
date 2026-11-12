import Foundation

/// Protocol for WebSocket operations to enable testing.
/// Defines the interface for WebSocket connections and messaging.
@MainActor
protocol WebSocketProtocol: AnyObject {
    var delegate: WebSocketDelegate? { get set }

    func connect(to url: URL, with headers: [String: String]) async throws
    func send(_ message: WebSocketMessage) async throws
    func sendPing() async throws
    func disconnect(with code: URLSessionWebSocketTask.CloseCode, reason: Data?)
}

/// WebSocket message types.
/// Represents different types of messages that can be sent over WebSocket.
enum WebSocketMessage {
    case string(String)
    case data(Data)
}

/// Delegate protocol for WebSocket events.
/// Provides callbacks for connection state changes and message reception.
@MainActor
protocol WebSocketDelegate: AnyObject {
    func webSocketDidConnect(_ webSocket: WebSocketProtocol)
    func webSocket(_ webSocket: WebSocketProtocol, didReceiveMessage message: WebSocketMessage)
    func webSocket(_ webSocket: WebSocketProtocol, didFailWithError error: Error)
    func webSocketDidDisconnect(
        _ webSocket: WebSocketProtocol,
        closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?)
}

/// Real implementation of WebSocketProtocol using URLSessionWebSocketTask.
/// One instance is one connection: it reports its end exactly once (a close code or an error)
/// and invalidates its URLSession then, because a URLSession retains its delegate until it is
/// invalidated (2026-11-10: every reconnection leaked a session and its socket object).
@MainActor
class URLSessionWebSocket: NSObject, WebSocketProtocol {
    weak var delegate: WebSocketDelegate?
    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private var isReceiving = false
    private var hasEnded = false

    func connect(to url: URL, with headers: [String: String]) async throws {
        var request = URLRequest(url: url)
        headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }

        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        self.session = session
        self.webSocketTask = session.webSocketTask(with: request)
        self.webSocketTask?.resume()

        // Start receiving messages
        self.isReceiving = true
        self.receiveNextMessage()

        // Send initial ping to verify connection
        do {
            try await self.sendPing()
        } catch {
            self.end(closeCode: nil, reason: nil, error: error)
            throw error
        }
        if !self.hasEnded {
            self.delegate?.webSocketDidConnect(self)
        }
    }

    func send(_ message: WebSocketMessage) async throws {
        guard let task = webSocketTask else {
            throw WebSocketError.connectionFailed
        }

        switch message {
        case let .string(text):
            try await task.send(.string(text))
        case let .data(data):
            try await task.send(.data(data))
        }
    }

    func sendPing() async throws {
        guard let task = webSocketTask else {
            throw WebSocketError.connectionFailed
        }

        return try await withCheckedThrowingContinuation { continuation in
            task.sendPing { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    func disconnect(with code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard !self.hasEnded else { return }
        self.hasEnded = true
        self.isReceiving = false
        self.webSocketTask?.cancel(with: code, reason: reason)
        // Lets the close frame go out, then frees the session (and this object)
        self.session?.finishTasksAndInvalidate()
        self.session = nil
        self.delegate?.webSocketDidDisconnect(self, closeCode: code, reason: reason)
    }

    /// The connection ended on its own. A close code sent by the server wins over the transport
    /// error it causes: a refused token arrives as close 4401 and, depending on timing, also as
    /// a failed ping or receive.
    private func end(closeCode: URLSessionWebSocketTask.CloseCode?, reason: Data?, error: Error?) {
        guard !self.hasEnded else { return }
        self.hasEnded = true
        self.isReceiving = false

        var code = closeCode
        var closeReason = reason
        if code == nil, let task = webSocketTask, task.closeCode != .invalid {
            code = task.closeCode
            closeReason = task.closeReason
        }

        self.session?.invalidateAndCancel()
        self.session = nil

        if let code {
            self.delegate?.webSocketDidDisconnect(self, closeCode: code, reason: closeReason)
        } else if let error {
            self.delegate?.webSocket(self, didFailWithError: error)
        }
    }

    private func receiveNextMessage() {
        guard self.isReceiving, let task = webSocketTask else { return }

        task.receive { [weak self] result in
            guard let self else { return }

            switch result {
            case let .success(message):
                let wsMessage: WebSocketMessage
                switch message {
                case let .string(text):
                    wsMessage = .string(text)
                case let .data(data):
                    wsMessage = .data(data)
                @unknown default:
                    return
                }

                Task { @MainActor in
                    guard !self.hasEnded else { return }
                    self.delegate?.webSocket(self, didReceiveMessage: wsMessage)
                    // Continue receiving
                    self.receiveNextMessage()
                }

            case let .failure(error):
                Task { @MainActor in
                    self.end(closeCode: nil, reason: nil, error: error)
                }
            }
        }
    }
}

extension URLSessionWebSocket: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void)
    {
        SecureRedirectDelegate.shared.urlSession(
            session,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: request,
            completionHandler: completionHandler)
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?)
    {
        // Connection opened - already handled in connect()
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?)
    {
        Task { @MainActor in
            self.end(closeCode: closeCode, reason: reason, error: nil)
        }
    }
}
