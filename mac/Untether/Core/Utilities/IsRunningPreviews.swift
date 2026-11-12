import AppKit
import Foundation

func isRunningPreviews() -> Bool {
    ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] != nil
}

/// True inside the test host (the app launched by `xcodebuild test`).
///
/// 2026-11-10: the tests run inside Untether.app without a sandbox, and several reached the
/// real install: NotificationServiceTests rewrote ~/.untether/config.json, CloudflareServiceTests
/// ran `pkill` on the user's cloudflared tunnels, NgrokServiceTests deleted the ngrok token from
/// the Keychain and StartupManagerTests registered the test host as a login item. The owners of
/// that state (ConfigManager, CloudflareService, KeychainConstants, StartupManager) ask this
/// and keep the test host away from it, whatever a test does.
let isRunningTests: Bool = {
    let processInfo = ProcessInfo.processInfo
    return processInfo.environment["XCTestConfigurationFilePath"] != nil ||
        processInfo.environment["XCTestBundlePath"] != nil ||
        processInfo.environment["XCTestSessionIdentifier"] != nil ||
        processInfo.arguments.contains("-XCTest") ||
        NSClassFromString("XCTestCase") != nil
}()

/// The app's preferences. Everything in the app reads and writes through this, never
/// `UserDefaults.standard` (AppIsolationGuardTests fails otherwise).
///
/// 2026-11-10: the test host is the real debug app, so tests that set preferences
/// (tailscaleServeEnabled, serverPort, dashboardAccessMode, showInDock…) changed the user's
/// own, and a debug app running at the same time saw them change live. In the app this is
/// `UserDefaults.standard`; in the test host it is a suite of its own, emptied at launch,
/// whose server port is a free one: no test can reach the server on the user's port.
nonisolated(unsafe) let appDefaults: UserDefaults = {
    guard isRunningTests else { return .standard }
    let suiteName = "com.nachx639.untether.test-host"
    guard let defaults = UserDefaults(suiteName: suiteName) else {
        fatalError("The test host could not open its own preferences (\(suiteName))")
    }
    defaults.removePersistentDomain(forName: suiteName)
    defaults.set(String(freeLoopbackPort()), forKey: "serverPort")
    return defaults
}()

/// The pasteboard the app copies to: the general one, or one of its own in the test host
/// (tests used to replace what the user had copied).
nonisolated(unsafe) let appPasteboard: NSPasteboard = isRunningTests
    ? NSPasteboard(name: NSPasteboard.Name("com.nachx639.untether.test-host"))
    : .general

/// A TCP port nothing listens on right now (the system picks it).
private func freeLoopbackPort() -> Int {
    let descriptor = socket(AF_INET, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return 49_152 }
    defer { close(descriptor) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    address.sin_port = 0
    let bound = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bound == 0 else { return 49_152 }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let named = withUnsafeMutablePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descriptor, $0, &length) }
    }
    return named == 0 ? Int(UInt16(bigEndian: address.sin_port)) : 49_152
}
