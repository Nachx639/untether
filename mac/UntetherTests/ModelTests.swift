import Foundation
import Testing
@testable import Untether

// MARK: - Model Tests Suite

@Suite("Model Tests", .tags(.models))
struct ModelTests {
    // MARK: - DashboardAccessMode Tests

    @Suite("DashboardAccessMode Tests")
    struct DashboardAccessModeTests {
        @Test(arguments: DashboardAccessMode.allCases)
        func dashboardaccessmodeValidation(mode: DashboardAccessMode) {
            // Each mode should have valid properties
            #expect(!mode.displayName.isEmpty)
            #expect(!mode.description.isEmpty)

            // Verify bind addresses
            switch mode {
            case .localhost:
                #expect(mode.fixedBindAddress?.value == "127.0.0.1")
            case .network:
                #expect(mode.fixedBindAddress?.value == "0.0.0.0")
            case .custom:
                #expect(mode.fixedBindAddress == nil)
                #expect(mode.resolvedBindAddress(customAddress: "::").value == "::")
                #expect(mode.resolvedBindAddress(customAddress: "invalid").value == "127.0.0.1")
            }
        }

        @Test
        func dashboardaccessmodeRawValues() {
            #expect(DashboardAccessMode.localhost.rawValue == AppConstants.DashboardAccessModeRawValues.localhost)
            #expect(DashboardAccessMode.network.rawValue == AppConstants.DashboardAccessModeRawValues.network)
            #expect(DashboardAccessMode.custom.rawValue == AppConstants.DashboardAccessModeRawValues.custom)
        }

        @Test
        func dashboardaccessmodeDescriptions() {
            #expect(DashboardAccessMode.localhost.description.contains("this Mac"))
            #expect(DashboardAccessMode.network.description.contains("other devices"))
            #expect(DashboardAccessMode.custom.description.contains("IPv4 or IPv6"))
        }

        @Test
        func dashboardaccessmodeDefaultValue() {
            // Verify the default is network mode
            #expect(AppConstants.Defaults.dashboardAccessMode == DashboardAccessMode.network.rawValue)

            // Verify we can create a mode from the default
            let mode = DashboardAccessMode(rawValue: AppConstants.Defaults.dashboardAccessMode)
            #expect(mode == .network)
            #expect(mode?.fixedBindAddress?.value == "0.0.0.0")
        }

        @Test
        func dashboardaccessmodeFromInvalidRawValue() {
            let mode = DashboardAccessMode(rawValue: "invalid")
            #expect(mode == nil)

            let emptyMode = DashboardAccessMode(rawValue: "")
            #expect(emptyMode == nil)
        }
    }

    // MARK: - ServerBindAddress Tests

    @Suite("ServerBindAddress Tests")
    struct ServerBindAddressTests {
        @Test(arguments: [
            ("127.0.0.1", ServerBindAddress.Family.ipv4),
            ("0.0.0.0", ServerBindAddress.Family.ipv4),
            ("::1", ServerBindAddress.Family.ipv6),
            ("::", ServerBindAddress.Family.ipv6),
            ("2001:db8::1", ServerBindAddress.Family.ipv6),
        ])
        func acceptsIPv4AndIPv6(value: String, family: ServerBindAddress.Family) {
            let address = ServerBindAddress(value)
            #expect(address?.value == value)
            #expect(address?.family == family)
        }

        @Test(arguments: ["", "localhost", "256.0.0.1", "192.168.1", "[::1]", "2001:db8:::1"])
        func rejectsInvalidAddressLiterals(value: String) {
            #expect(ServerBindAddress(value) == nil)
        }

        @Test
        func trimsAddressWhitespace() {
            #expect(ServerBindAddress("  ::1 \n")?.value == "::1")
        }

        @Test
        func buildsBracketedIPv6URLs() {
            let loopback = ServerBindAddress("::1")
            #expect(loopback?.endpoint(port: "4020") == "[::1]:4020")
            #expect(
                loopback?.url(port: "4020", endpoint: "/api/health")?.absoluteString ==
                    "http://[::1]:4020/api/health")
        }

        @Test
        func mapsWildcardAddressesToUsableLoopbackURLs() {
            let ipv4Wildcard = ServerBindAddress("0.0.0.0")
            let ipv6Wildcard = ServerBindAddress("::")

            #expect(ipv4Wildcard?.connectableAddress.value == "127.0.0.1")
            #expect(ipv6Wildcard?.connectableAddress.value == "::1")
            #expect(ipv6Wildcard?.connectableAddress.url(port: "4020")?.absoluteString == "http://[::1]:4020/")
        }
    }

    // MARK: - AppConstants Tests

    @Suite("AppConstants Tests")
    struct AppConstantsTests {
        @Test
        func welcomeVersionConstant() {
            #expect(AppConstants.currentWelcomeVersion > 0)
            #expect(AppConstants.currentWelcomeVersion == 5)
        }

        @Test
        func userdefaultsKeys() {
            #expect(AppConstants.UserDefaultsKeys.welcomeVersion == "welcomeVersion")
            #expect(AppConstants.UserDefaultsKeys.dashboardAccessMode == "dashboardAccessMode")
            #expect(AppConstants.UserDefaultsKeys.serverPort == "serverPort")
        }

        @Test
        func appconstantsDefaultValues() {
            // Verify dashboard access mode default
            #expect(AppConstants.Defaults.dashboardAccessMode == DashboardAccessMode.network.rawValue)

            // Verify server port default
            #expect(AppConstants.Defaults.serverPort == 4020)

            // Verify other defaults
            // 2026-10-20: the startup cleanup deleted exited sessions users still needed
            // (Resume Claude, task sessions), so it is off by default now.
            #expect(AppConstants.Defaults.cleanupOnStartup == false)
            // The Dock icon is shown until the user hides it (one default, 2026-11-11).
            #expect(AppConstants.Defaults.showInDock == true)
        }

        @Test
        func appconstantsStringvalueHelperWithDashboardaccessmode() {
            // Store original value
            let originalValue = appDefaults.string(forKey: AppConstants.UserDefaultsKeys.dashboardAccessMode)

            defer {
                // Restore original value
                if let originalValue {
                    appDefaults.set(originalValue, forKey: AppConstants.UserDefaultsKeys.dashboardAccessMode)
                } else {
                    appDefaults.removeObject(forKey: AppConstants.UserDefaultsKeys.dashboardAccessMode)
                }
            }

            // When key doesn't exist, should return default
            appDefaults.removeObject(forKey: AppConstants.UserDefaultsKeys.dashboardAccessMode)
            let defaultValue = AppConstants.stringValue(for: AppConstants.UserDefaultsKeys.dashboardAccessMode)
            #expect(defaultValue == AppConstants.Defaults.dashboardAccessMode)
            #expect(defaultValue == AppConstants.DashboardAccessModeRawValues.network) // Our default is network

            // When key exists with localhost, should return localhost
            appDefaults.set(
                AppConstants.DashboardAccessModeRawValues.localhost,
                forKey: AppConstants.UserDefaultsKeys.dashboardAccessMode)
            let localhostValue = AppConstants.stringValue(for: AppConstants.UserDefaultsKeys.dashboardAccessMode)
            #expect(localhostValue == AppConstants.DashboardAccessModeRawValues.localhost)

            // When key exists with network, should return network
            appDefaults.set(
                AppConstants.DashboardAccessModeRawValues.network,
                forKey: AppConstants.UserDefaultsKeys.dashboardAccessMode)
            let networkValue = AppConstants.stringValue(for: AppConstants.UserDefaultsKeys.dashboardAccessMode)
            #expect(networkValue == AppConstants.DashboardAccessModeRawValues.network)
        }
    }
}
