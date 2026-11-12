import Foundation

// MARK: - Error Response

/// Unified error response structure for API errors
public struct ErrorResponse: Codable, Sendable {
    public let error: String
    public let code: String?
    public let details: String?

    public init(error: String, code: String? = nil, details: String? = nil) {
        self.error = error
        self.code = code
        self.details = details
    }
}

// MARK: - Network Errors

/// Common network errors for API requests
public enum NetworkError: LocalizedError {
    case invalidResponse
    case serverError(statusCode: Int, message: String)
    case decodingError(Error)
    case noData

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            String(localized: "Invalid server response", comment: "Error: talking to the local server")
        case let .serverError(statusCode, message):
            String(localized: "Server error (\(statusCode)): \(message)", comment: "Error: talking to the local server")
        case let .decodingError(error):
            String(localized: "Failed to decode response: \(error.localizedDescription)", comment: "Error: talking to the local server")
        case .noData:
            String(localized: "No data received from server", comment: "Error: talking to the local server")
        }
    }
}
