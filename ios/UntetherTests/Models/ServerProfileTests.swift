import Foundation
import Testing
@testable import Untether

@Suite("ServerProfile Tests", .tags(.models))
struct ServerProfileTests {
    @Test("Rejects profile URLs with unsupported or missing schemes", arguments: [
        "ftp://example.com", "ws://example.com", "//example.com",
    ])
    func rejectsUnsupportedScheme(url: String) {
        #expect(ServerProfile(name: "Invalid server", url: url).toServerConfig() == nil)
    }

    @Test("HTTPS profiles preserve TLS for authentication and saved connections", arguments: [
        "https://example.com", "https://example.com:8443", "HTTPS://example.com:443", "https://[::1]:8443",
    ])
    func httpsProfilePreservesTransport(url: String) throws {
        let profile = ServerProfile(name: "Secure server", url: url)
        let config = try #require(profile.toServerConfig())
        let restored = try JSONDecoder().decode(ServerConfig.self, from: JSONEncoder().encode(config))
        let components = try #require(URLComponents(string: url))

        #expect(restored.baseURL.scheme == "https")
        #expect(restored.connectionURL().scheme == "https")
        #expect(restored.connectionURL().port == (components.port ?? 443))
        for path in ["/api/auth/config", "/api/auth/password", "/api/auth/verify", "/api/auth/logout"] {
            #expect(restored.apiURL(path: path).scheme == "https")
            #expect(restored.apiURL(path: path).path == path)
        }
    }

    @Test("HTTPS profiles cannot fall back to HTTP through Tailscale preferences", arguments: [true, false])
    func httpsProfilePreventsTailscaleDowngrade(hasHostname: Bool) throws {
        let profile = ServerProfile(
            name: "Secure server",
            url: "https://example.com:8443",
            tailscaleHostname: hasHostname ? "server.example.ts.net" : nil,
            tailscaleIP: "100.64.0.1",
            isTailscaleEnabled: true,
            preferTailscale: true,
            httpsAvailable: true)
        var config = try #require(profile.toServerConfig())

        // These preferences are cleared by the existing HTTP fallback path.
        config.httpsAvailable = false
        config.preferSSL = false
        #expect(config.connectionURL().scheme == "https")
        #expect(config.connectionURL(useTailscale: false).scheme == "https")
        #expect(config.apiURL(path: "/api/auth/password").scheme == "https")
    }

    @Test("Creates ServerConfig with correct Tailscale properties")
    func toServerConfigWithTailscaleProperties() {
        // Arrange
        let profile = ServerProfile(
            id: UUID(),
            name: "Test Server",
            url: "https://test-machine.tail1234.ts.net",
            host: "100.64.0.1",
            port: 4_020,
            tailscaleHostname: "test-machine.tail1234.ts.net",
            tailscaleIP: "100.64.0.1",
            isTailscaleEnabled: true,
            preferTailscale: true,
            httpsAvailable: true,
            isPublic: false,
            preferSSL: true
        )

        // Act
        let config = profile.toServerConfig()

        // Assert
        #expect(config != nil)
        guard let config else { return }

        #expect(config.host == "test-machine.tail1234.ts.net")
        #expect(config.port == 443) // HTTPS URL should extract port 443
        #expect(config.tailscaleHostname == "test-machine.tail1234.ts.net")
        #expect(config.tailscaleIP == "100.64.0.1")
        #expect(config.isTailscaleEnabled == true)
        #expect(config.preferTailscale == true)
        #expect(config.httpsAvailable == true)
        #expect(config.isPublic == false)
        #expect(config.preferSSL == true)

        // Connection URL should use HTTPS
        let connectionUrl = config.connectionURL()
        #expect(connectionUrl.scheme == "https")
        #expect(connectionUrl.host == "test-machine.tail1234.ts.net")
    }

    @Test("Creates ServerConfig from HTTP URL")
    func toServerConfigFromHTTPURL() {
        // Arrange
        let profile = ServerProfile(
            id: UUID(),
            name: "Local Server",
            url: "http://localhost:4020"
        )

        // Act
        let config = profile.toServerConfig()

        // Assert
        #expect(config != nil)
        guard let config else { return }

        #expect(config.host == "localhost")
        #expect(config.port == 4_020)
        #expect(config.isTailscaleEnabled == false)
        #expect(config.httpsAvailable == false)

        // Connection URL should use HTTP
        let connectionUrl = config.connectionURL()
        #expect(connectionUrl.scheme == "http")
        #expect(connectionUrl.host == "localhost")
        #expect(connectionUrl.port == 4_020)
    }

    @Test("Handles IPv6 addresses correctly")
    func toServerConfigWithIPv6() {
        // Arrange
        let profile = ServerProfile(
            id: UUID(),
            name: "IPv6 Server",
            url: "http://[::1]:8080"
        )

        // Act
        let config = profile.toServerConfig()

        // Assert
        #expect(config != nil)
        guard let config else { return }

        #expect(config.host == "::1") // Brackets should be removed
        #expect(config.port == 8_080)
    }

    @Test("ServerProfile storage and retrieval")
    func storageAndRetrieval() {
        // Arrange
        let testDefaults = UserDefaults(suiteName: "test.serverprofile")!
        testDefaults.removePersistentDomain(forName: "test.serverprofile")

        let profile1 = ServerProfile(
            name: "Server 1",
            url: "http://localhost:4020"
        )
        let profile2 = ServerProfile(
            name: "Server 2",
            url: "https://test.example.com"
        )

        // Act - Save profiles
        ServerProfile.save(profile1, to: testDefaults)
        ServerProfile.save(profile2, to: testDefaults)

        // Assert - Load profiles
        let loadedProfiles = ServerProfile.loadAll(from: testDefaults)
        #expect(loadedProfiles.count == 2)
        #expect(loadedProfiles.contains { $0.name == "Server 1" })
        #expect(loadedProfiles.contains { $0.name == "Server 2" })

        // Act - Delete profile
        ServerProfile.delete(profile1, from: testDefaults)

        // Assert - Profile deleted
        let remainingProfiles = ServerProfile.loadAll(from: testDefaults)
        #expect(remainingProfiles.count == 1)
        #expect(remainingProfiles.first?.name == "Server 2")

        // Cleanup
        testDefaults.removePersistentDomain(forName: "test.serverprofile")
    }

    @Test("Updates last connected time")
    func updateLastConnectedTime() {
        // Arrange
        let testDefaults = UserDefaults(suiteName: "test.serverprofile.time")!
        testDefaults.removePersistentDomain(forName: "test.serverprofile.time")

        let profile = ServerProfile(
            name: "Test Server",
            url: "http://localhost:4020"
        )
        ServerProfile.save(profile, to: testDefaults)

        // Act
        ServerProfile.updateLastConnected(for: profile.id, in: testDefaults)

        // Assert
        let updatedProfiles = ServerProfile.loadAll(from: testDefaults)
        #expect(updatedProfiles.count == 1)
        #expect(updatedProfiles.first?.lastConnected != nil)

        // Cleanup
        testDefaults.removePersistentDomain(forName: "test.serverprofile.time")
    }

    // MARK: - 2026-11-10 audit

    private func scratchDefaults() -> UserDefaults {
        let name = "ServerProfileTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test("A result that arrives after the profile was deleted does not bring it back")
    func lateResultDoesNotResurrect() {
        let defaults = self.scratchDefaults()
        let kept = ServerProfile(name: "Kept", url: "http://10.0.0.1:4020")
        var deleted = ServerProfile(name: "Deleted", url: "http://10.0.0.2:4020")
        ServerProfile.save(kept, to: defaults)
        ServerProfile.save(deleted, to: defaults)

        // A health check started, the user deleted the profile, the check came back
        ServerProfile.delete(deleted, from: defaults)
        deleted.httpsAvailable = true
        ServerProfile.replaceExisting(deleted, in: defaults)
        ServerProfile.update(id: deleted.id, in: defaults) { $0.isPublic = true }

        #expect(ServerProfile.loadAll(from: defaults).map(\.name) == ["Kept"])
    }

    @Test("A late result changes only its own fields of the saved profile")
    func lateResultKeepsOtherChanges() {
        let defaults = self.scratchDefaults()
        let profile = ServerProfile(name: "Mac", url: "http://10.0.0.1:4020")
        ServerProfile.save(profile, to: defaults)

        // While the check was running the user logged in (the profile needs auth now)
        ServerProfile.update(id: profile.id, in: defaults) { $0.requiresAuth = true }
        ServerProfile.update(id: profile.id, in: defaults) { $0.httpsAvailable = true }

        let saved = ServerProfile.loadAll(from: defaults)[0]
        #expect(saved.requiresAuth)
        #expect(saved.httpsAvailable)
    }

    @Test("Without a port the profile and its connection agree", arguments: [
        ("http://mac.local", 80), ("https://mac.tail1234.ts.net", 443), ("http://mac.local:4020", 4_020),
    ])
    func portWithoutPortInURL(url: String, port: Int) {
        let profile = ServerProfile(name: "Mac", url: url)
        #expect(profile.port == port)
        #expect(profile.toServerConfig()?.port == port)
    }

    @Test("An https Tailscale profile connects by name even when it was marked HTTP-only")
    func httpsTailscaleNeverByAddress() throws {
        // What a failed connection used to leave saved: httpsAvailable and preferSSL false
        let profile = ServerProfile(
            name: "Mac",
            url: "https://mac.tail1234.ts.net",
            tailscaleHostname: "mac.tail1234.ts.net",
            tailscaleIP: "100.64.0.1",
            isTailscaleEnabled: true,
            preferTailscale: true,
            httpsAvailable: false,
            preferSSL: false)

        let url = try #require(profile.toServerConfig()).connectionURL()
        #expect(url.scheme == "https")
        // The certificate is for the name; https to 100.64.0.1 can never validate
        #expect(url.host == "mac.tail1234.ts.net")
    }
}
