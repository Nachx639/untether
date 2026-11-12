import Foundation

/// Refuse redirects that would send a TLS request's credentials over a cleartext connection.
final class SecureRedirectDelegate: NSObject, URLSessionTaskDelegate {
    static let shared = SecureRedirectDelegate()
    static let session = URLSession(configuration: .default, delegate: shared, delegateQueue: nil)

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void)
    {
        let secureSchemes = ["https", "wss"]
        let requiresTLS = [task.originalRequest?.url, response.url].contains {
            secureSchemes.contains($0?.scheme?.lowercased() ?? "")
        }
        let isSecure = secureSchemes.contains(request.url?.scheme?.lowercased() ?? "")
        completionHandler(requiresTLS && !isSecure ? nil : request)
    }
}
