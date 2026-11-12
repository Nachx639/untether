import Foundation
import Testing
@testable import Untether

@Suite("Secure Redirect Tests", .tags(.networking, .security))
struct SecureRedirectDelegateTests {
    @Test("HTTP and WebSocket delegates reject TLS downgrades", arguments: [301, 302, 303, 307, 308])
    @MainActor
    func rejectsDowngrades(status: Int) async throws {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }

        for (source, target) in [("https", "http"), ("wss", "ws"), ("wss", "http")] {
            let originalURL = try #require(URL(string: "\(source)://example.com/api/auth/password"))
            let targetURL = try #require(URL(string: "\(target)://example.com/api/auth/password"))
            var request = URLRequest(url: targetURL)
            request.httpMethod = "POST"
            request.httpBody = Data([1, 2, 3])
            let response = try #require(HTTPURLResponse(
                url: originalURL, statusCode: status, httpVersion: nil,
                headerFields: ["Location": targetURL.absoluteString]))
            let task: URLSessionTask = source == "wss"
                ? session.webSocketTask(with: originalURL)
                : session.dataTask(with: originalURL)

            let redirected: URLRequest? = await withCheckedContinuation { continuation in
                if source == "wss" {
                    URLSessionWebSocket().urlSession(
                        session, task: task, willPerformHTTPRedirection: response,
                        newRequest: request)
                    {
                        continuation.resume(returning: $0)
                    }
                } else {
                    SecureRedirectDelegate.shared.urlSession(
                        session, task: task, willPerformHTTPRedirection: response,
                        newRequest: request)
                    {
                        continuation.resume(returning: $0)
                    }
                }
            }
            #expect(redirected == nil)
        }
    }

    @Test("Allows secure redirects and explicit HTTP connections", arguments: [
        ("https", "https"), ("wss", "wss"), ("http", "http"), ("http", "https"),
    ])
    func allowsSafeRedirects(source: String, target: String) async throws {
        let session = SecureRedirectDelegate.session
        #expect(session.delegate === SecureRedirectDelegate.shared)
        let originalURL = try #require(URL(string: "\(source)://example.com"))
        let task = session.dataTask(with: originalURL)
        let response = try #require(HTTPURLResponse(
            url: originalURL, statusCode: 307, httpVersion: nil, headerFields: nil))
        let request = try URLRequest(url: #require(URL(string: "\(target)://example.com/redirected")))

        let redirected: URLRequest? = await withCheckedContinuation { continuation in
            SecureRedirectDelegate.shared.urlSession(
                session, task: task, willPerformHTTPRedirection: response, newRequest: request)
            {
                continuation.resume(returning: $0)
            }
        }
        #expect(redirected == request)
    }

    @Test("An HTTP connection upgraded to HTTPS cannot redirect back to HTTP")
    func rejectsDowngradeAfterUpgrade() async throws {
        let session = SecureRedirectDelegate.session
        let task = try session.dataTask(with: #require(URL(string: "http://example.com")))
        let secureURL = try #require(URL(string: "https://example.com"))
        let response = try #require(HTTPURLResponse(
            url: secureURL,
            statusCode: 307, httpVersion: nil, headerFields: nil))
        let request = try URLRequest(url: #require(URL(string: "http://example.com/redirected")))

        let redirected: URLRequest? = await withCheckedContinuation { continuation in
            SecureRedirectDelegate.shared.urlSession(
                session, task: task, willPerformHTTPRedirection: response, newRequest: request)
            {
                continuation.resume(returning: $0)
            }
        }
        #expect(redirected == nil)
    }
}
