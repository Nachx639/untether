import Foundation

/// Centralized API endpoints for the Untether server
enum APIEndpoints {
    // MARK: - Session Management

    static let sessions = "/api/sessions"

    // MARK: - Cleanup

    static let cleanupExited = "/api/cleanup-exited"

    // MARK: - WebSocket

    static let ws = "/ws"
}
