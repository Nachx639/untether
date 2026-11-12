import Foundation
import Testing
@testable import Untether

// MARK: - Server Manager Tests

@Suite("Server Manager Tests", .serialized, .tags(.serverManager))
@MainActor
final class ServerManagerTests {
    /// We'll use the shared ServerManager instance since it's a singleton
    let manager = ServerManager.shared

    init() async {
        // Ensure clean state before each test
        await self.manager.stop()
    }

    deinit {
        // Clean up is handled in init() of next test since we can't use async in deinit
    }

    @Test
    func portConfiguration() {
        // Store original port
        let originalPort = self.manager.port

        // Test setting different ports
        let testPorts = ["8080", "3000", "9999"]

        for port in testPorts {
            self.manager.port = port
            #expect(self.manager.port == port)
            #expect(appDefaults.string(forKey: "serverPort") == port)
        }

        // Restore original port
        self.manager.port = originalPort
    }

    @Test(arguments: [
        DashboardAccessMode.localhost,
        DashboardAccessMode.network,
    ])
    func bindAddressConfiguration(mode: DashboardAccessMode) {
        // Store original mode
        let originalMode = appDefaults.string(forKey: "dashboardAccessMode") ?? ""

        // Set the mode via UserDefaults (as bindAddress setter does)
        appDefaults.set(mode.rawValue, forKey: "dashboardAccessMode")

        // Check bind address reflects the mode
        #expect(self.manager.bindAddress == mode.fixedBindAddress?.value)

        // Restore original mode
        appDefaults.set(originalMode, forKey: "dashboardAccessMode")
    }

    @Test
    func bindAddressDefaultValue() {
        // Store original value
        let originalMode = appDefaults.string(forKey: "dashboardAccessMode")

        // Remove the key to test default behavior
        appDefaults.removeObject(forKey: "dashboardAccessMode")
        appDefaults.synchronize()

        // Should default to network mode (0.0.0.0)
        #expect(self.manager.bindAddress == "0.0.0.0")

        // Restore original value
        if let originalMode {
            appDefaults.set(originalMode, forKey: "dashboardAccessMode")
        }
    }

    @Test
    func bindAddressSetter() {
        // Store original value
        let originalMode = appDefaults.string(forKey: "dashboardAccessMode")
        let originalCustomAddress = appDefaults.string(forKey: UserDefaultsKeys.customBindAddress)

        defer {
            if let originalMode {
                appDefaults.set(originalMode, forKey: "dashboardAccessMode")
            } else {
                appDefaults.removeObject(forKey: "dashboardAccessMode")
            }

            if let originalCustomAddress {
                appDefaults.set(originalCustomAddress, forKey: UserDefaultsKeys.customBindAddress)
            } else {
                appDefaults.removeObject(forKey: UserDefaultsKeys.customBindAddress)
            }
        }

        // Test setting via bind address
        self.manager.bindAddress = "127.0.0.1"
        #expect(
            appDefaults.string(forKey: "dashboardAccessMode") == AppConstants.DashboardAccessModeRawValues
                .localhost)
        #expect(self.manager.bindAddress == "127.0.0.1")

        self.manager.bindAddress = "0.0.0.0"
        #expect(
            appDefaults.string(forKey: "dashboardAccessMode") == AppConstants.DashboardAccessModeRawValues
                .network)
        #expect(self.manager.bindAddress == "0.0.0.0")

        self.manager.bindAddress = "::"
        #expect(
            appDefaults.string(forKey: "dashboardAccessMode") == AppConstants.DashboardAccessModeRawValues
                .custom)
        #expect(appDefaults.string(forKey: UserDefaultsKeys.customBindAddress) == "::")
        #expect(self.manager.bindAddress == "::")

        self.manager.bindAddress = "192.168.1.1"
        #expect(self.manager.bindAddress == "192.168.1.1")

        // Invalid bind addresses should not change the last valid configuration.
        self.manager.bindAddress = "not-an-address"
        #expect(self.manager.bindAddress == "192.168.1.1")
    }

    @Test
    func customIPv6ConfigurationPersistsAndBuildsValidURLs() {
        let originalMode = appDefaults.string(forKey: UserDefaultsKeys.dashboardAccessMode)
        let originalCustomAddress = appDefaults.string(forKey: UserDefaultsKeys.customBindAddress)
        let originalPort = self.manager.port

        defer {
            self.manager.port = originalPort
            if let originalMode {
                appDefaults.set(originalMode, forKey: UserDefaultsKeys.dashboardAccessMode)
            } else {
                appDefaults.removeObject(forKey: UserDefaultsKeys.dashboardAccessMode)
            }
            if let originalCustomAddress {
                appDefaults.set(originalCustomAddress, forKey: UserDefaultsKeys.customBindAddress)
            } else {
                appDefaults.removeObject(forKey: UserDefaultsKeys.customBindAddress)
            }
        }

        self.manager.port = "4567"
        #expect(self.manager.updateBindConfiguration(mode: .custom, customAddress: "::"))
        #expect(self.manager.dashboardAccessMode == .custom)
        #expect(self.manager.customBindAddress == "::")
        #expect(self.manager.bindAddress == "::")
        #expect(self.manager.buildURL(endpoint: "/api/health")?.absoluteString == "http://[::1]:4567/api/health")
        #expect(self.manager.dashboardURL()?.absoluteString == "http://[::1]:4567/")
        #expect(self.manager.dashboardEndpoint == "[::1]:4567")
    }

    @Test
    func rejectsInvalidCustomConfiguration() {
        let originalMode = appDefaults.string(forKey: UserDefaultsKeys.dashboardAccessMode)
        defer {
            if let originalMode {
                appDefaults.set(originalMode, forKey: UserDefaultsKeys.dashboardAccessMode)
            } else {
                appDefaults.removeObject(forKey: UserDefaultsKeys.dashboardAccessMode)
            }
        }

        appDefaults.set(DashboardAccessMode.network.rawValue, forKey: UserDefaultsKeys.dashboardAccessMode)
        #expect(!self.manager.updateBindConfiguration(mode: .custom, customAddress: "localhost"))
        #expect(self.manager.dashboardAccessMode == .network)
    }

    // MARK: - Enhanced Server Management Tests with Attachments

    @Test(
        .tags(.attachmentTests, .requiresServerBinary),
        .enabled(if: ServerBinaryAvailableCondition.isAvailable()))
    func serverConfigurationManagementWithDiagnostics() {
        // Test server configuration without actually starting it
        let originalPort = self.manager.port
        self.manager.port = "4567"

        #expect(self.manager.port == "4567")

        // Restore original configuration
        self.manager.port = originalPort
    }
}
