import Foundation
@testable import Untether

/// Mock URLProtocol for intercepting and stubbing network requests in tests
class MockURLProtocol: URLProtocol {
    typealias Handler = (URLRequest) throws -> (HTTPURLResponse, Data?)

    nonisolated(unsafe) static var requestHandler: Handler?

    /// Handlers by host: suites run in parallel, and one shared handler would answer another
    /// suite's requests. A suite that uses its own host is independent of the rest.
    private static let lock = NSLock()
    nonisolated(unsafe) private static var hostHandlers: [String: Handler] = [:]

    static func setHandler(forHost host: String, _ handler: Handler?) {
        self.lock.withLock { self.hostHandlers[host] = handler }
    }

    private static func handler(for request: URLRequest) -> Handler? {
        let byHost = self.lock.withLock { request.url?.host.flatMap { self.hostHandlers[$0] } }
        return byHost ?? self.requestHandler
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = MockURLProtocol.handler(for: request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)

            if let data {
                client?.urlProtocol(self, didLoad: data)
            }

            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {
        // No-op
    }
}

// MARK: - Helper Methods

extension MockURLProtocol {
    /// The body of a request as URLProtocol sees it: URLSession hands it over as a stream,
    /// `httpBody` is nil here.
    static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }

    /// The JSON object a request carries. Handlers run on URLSession's thread: a closure written
    /// inside a @MainActor test would trap there, so they call this instead of decoding inline.
    static func jsonBody(of request: URLRequest) -> [String: JSONValue]? {
        guard let data = self.body(of: request) else { return nil }
        return JSONValue.decodeObject(from: data)
    }

    static func successResponse(
        for url: URL,
        statusCode: Int = 200,
        data: Data? = nil,
        headers: [String: String] = [:])
        -> (HTTPURLResponse, Data?)
    {
        let response = HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: headers)!
        return (response, data)
    }

    static func jsonResponse(
        for url: URL,
        statusCode: Int = 200,
        json: Any)
        throws -> (HTTPURLResponse, Data?)
    {
        let data = try self.encodeJSON(json)
        let headers = ["Content-Type": "application/json"]
        return self.successResponse(for: url, statusCode: statusCode, data: data, headers: headers)
    }

    static func errorResponse(
        for url: URL,
        statusCode: Int,
        message: String? = nil)
        -> (HTTPURLResponse, Data?)
    {
        var data: Data?
        if let message {
            let json = ["error": message]
            data = try? self.encodeJSON(json)
        }
        return self.successResponse(for: url, statusCode: statusCode, data: data)
    }

    private static func encodeJSON(_ json: Any) throws -> Data {
        guard let value = JSONValue(any: json) else {
            throw URLError(.cannotParseResponse)
        }
        return try JSONEncoder().encode(value)
    }
}

// MARK: - Test Configuration

extension URLSessionConfiguration {
    static var mockConfiguration: URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return config
    }
}
