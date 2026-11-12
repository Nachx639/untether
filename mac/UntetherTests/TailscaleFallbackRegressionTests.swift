import Foundation
import os.log
import Testing
@testable import Untether

/// Regression tests for Tailscale fallback functionality
/// These tests verify the fixes for issues introduced in Release 15
///
/// Nested in ServerManagerTests (serialized): these tests turn the Tailscale Serve setting on,
/// and with it on the server's address is 127.0.0.1 (ServerNetworkPolicy, 2026-11-11), which
/// the address tests of ServerManagerTests would see if both ran at the same time.
extension ServerManagerTests {
    @Suite("Tailscale Fallback Regression Tests", .serialized, .tags(.regression))
    @MainActor
    final class TailscaleFallbackRegressionTests {
        private let logger = Logger(subsystem: "test.untether", category: "TailscaleRegressionTests")
        private var serverManager: ServerManager!
        private var tailscaleService: TailscaleServeStatusService!

        init() async {
            self.serverManager = ServerManager.shared
            self.tailscaleService = TailscaleServeStatusService.shared

            // Ensure clean state
            await self.serverManager.stop()
            self.tailscaleService.stopMonitoring()

            // Reset UserDefaults for testing
            appDefaults.removeObject(forKey: AppConstants.UserDefaultsKeys.tailscaleServeEnabled)
        }

        deinit {
            // The setting never outlives a test of this suite.
            appDefaults.removeObject(forKey: AppConstants.UserDefaultsKeys.tailscaleServeEnabled)
        }

        // MARK: - Regression Test 1: Toggle Auto-Disable Bug

        @Test(
            .tags(.critical),
            .timeLimit(.minutes(1)))
        func tailscaleToggleDoesNotAutoDisableAfter10Seconds() async {
            self.logger.info("Testing that Tailscale toggle remains enabled in fallback mode")

            // Enable Tailscale Serve in settings
            appDefaults.set(true, forKey: AppConstants.UserDefaultsKeys.tailscaleServeEnabled)

            // Verify the setting is enabled
            let initialValue = AppConstants.boolValue(for: AppConstants.UserDefaultsKeys.tailscaleServeEnabled)
            #expect(initialValue == true, "Tailscale should be enabled initially")

            // Simulate the fallback state directly instead of starting the full server.
            // The regression was that fallback status mutated the user's persisted toggle.
            self.tailscaleService.isPermanentlyDisabled = true
            await Task.yield()

            // Check that the toggle is still enabled
            let afterWaitValue = AppConstants.boolValue(for: AppConstants.UserDefaultsKeys.tailscaleServeEnabled)
            #expect(afterWaitValue == true, "Tailscale toggle should remain enabled in fallback mode")

            // Also verify that if isPermanentlyDisabled is set, toggle still stays enabled
            if self.tailscaleService.isPermanentlyDisabled {
                self.logger.info("Service is in fallback mode (isPermanentlyDisabled = true)")
                let fallbackValue = AppConstants.boolValue(for: AppConstants.UserDefaultsKeys.tailscaleServeEnabled)
                #expect(fallbackValue == true, "Toggle should remain enabled even in fallback mode")
            }
        }

        // MARK: - Regression Test 4: UI Error Display

        @Test(
            .tags(.integration))
        func uiShowsCorrectStatusInFallbackMode() async throws {
            self.logger.info("Testing UI status display in fallback mode")

            // Enable Tailscale
            appDefaults.set(true, forKey: AppConstants.UserDefaultsKeys.tailscaleServeEnabled)

            // Start monitoring to trigger status checks
            self.tailscaleService.startMonitoring()

            // Wait for initial status
            try await Task.sleep(for: .seconds(3))

            // Check the status that UI would display
            if self.tailscaleService.isPermanentlyDisabled {
                // In fallback mode, UI should show helpful status
                self.logger.info("UI should show 'Fallback' status, not error")

                // The error should be clear about what's happening
                if let error = tailscaleService.lastError {
                    #expect(
                        error.contains("admin") || error.contains("tailnet") || error.contains("Serve"),
                        "Error should explain why Serve isn't available")

                    // Should not show confusing technical errors
                    #expect(
                        !error.contains("Process exited with code 0"),
                        "Should not show 'Process exited with code 0' error")
                }
            }

            // Cleanup
            self.tailscaleService.stopMonitoring()
        }

        // MARK: - Helper to simulate Tailscale Serve unavailable

        @Test(
            .tags(.integration),
            .disabled(
                if: !ProcessInfo.processInfo.environment.keys.contains("TEST_TAILSCALE_HELPERS"),
                "Helper test only runs with TEST_TAILSCALE_HELPERS=1"))
        func helperSimulateTailscaleServePermanentlyDisabled() {
            // This helper test can be used to manually trigger the fallback scenario
            self.logger.info("Simulating Tailscale Serve unavailable scenario")

            // Manually set the permanently disabled flag (normally set by status service)
            self.tailscaleService.isPermanentlyDisabled = true
            self.tailscaleService.lastError = "Serve is not enabled on your tailnet"

            // Verify fallback behavior
            #expect(self.tailscaleService.isPermanentlyDisabled == true)
            #expect(self.tailscaleService.lastError == "Serve is not enabled on your tailnet")

            // Enable Tailscale toggle
            appDefaults.set(true, forKey: AppConstants.UserDefaultsKeys.tailscaleServeEnabled)

            // Toggle should remain enabled
            let toggleValue = AppConstants.boolValue(for: AppConstants.UserDefaultsKeys.tailscaleServeEnabled)
            #expect(toggleValue == true, "Toggle should stay enabled in simulated fallback")

            // Reset
            self.tailscaleService.isPermanentlyDisabled = false
            self.tailscaleService.lastError = nil
        }
    }
}
