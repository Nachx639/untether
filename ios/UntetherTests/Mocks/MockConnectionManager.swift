import Foundation
@testable import Untether

/// Mock implementation for testing ConnectionManager functionality
@MainActor
class MockConnectionManager {
    var disconnectCallCount = 0

    func disconnect() async {
        self.disconnectCallCount += 1
    }
}

extension ConnectionManager {
    /// A real ConnectionManager cut off from the world: its requests go to MockURLProtocol
    /// (a host without a handler fails at once, nothing leaves the simulator), its keychain
    /// is in memory and its socket client is its own.
    @MainActor
    static func forTests(storage: PersistentStorage = MockStorage()) -> ConnectionManager {
        self.createForTesting(
            storage: storage,
            urlSession: URLSession(configuration: .mockConfiguration),
            keychainService: MockKeychainService())
    }
}
