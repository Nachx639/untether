import AppKit
import Foundation
import Testing
@testable import Untether

// 2026-11-10: the tests run inside the real debug app. They changed its preferences
// (tailscaleServeEnabled, serverPort, dashboardAccessMode, showInDock), replaced what the user
// had copied and talked to the server on the user's port. The app now reaches all three
// through one place each (appDefaults, appPasteboard, the port in appDefaults), which the test
// host points away from the user's. These tests keep it that way.
@Suite("Test host isolation")
struct AppIsolationGuardTests {
    private static let macDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()

    private static func swiftFiles(in folder: String) throws -> [URL] {
        let root = self.macDir.appendingPathComponent(folder)
        let enumerator = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        return enumerator.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }

    @Test
    func theTestHostHasPreferencesOfItsOwn() {
        #expect(isRunningTests)
        #expect(appDefaults !== UserDefaults.standard)
        let key = "isolation-probe-\(UUID().uuidString)"
        appDefaults.set(true, forKey: key)
        defer { appDefaults.removeObject(forKey: key) }
        #expect(UserDefaults.standard.object(forKey: key) == nil)
    }

    @Test
    func theTestHostNeverTalksToTheUsersPort() throws {
        let port = try #require(appDefaults.string(forKey: AppConstants.UserDefaultsKeys.serverPort))
        #expect(port != String(NetworkConstants.defaultPort))
        #expect(port != UserDefaults.standard.string(forKey: AppConstants.UserDefaultsKeys.serverPort))
    }

    @Test
    func theTestHostHasAPasteboardOfItsOwn() {
        #expect(appPasteboard !== NSPasteboard.general)
        #expect(appPasteboard.name != NSPasteboard.general.name)
    }

    @Test
    func aServerStartedFromTheTestHostGetsAHomeOfItsOwn() throws {
        let real = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin"]
        #expect(BunServer.launchEnvironment(real, testHost: false) == real)
        let isolated = BunServer.launchEnvironment(real, testHost: true)
        let home = try #require(isolated["HOME"])
        #expect(home != NSHomeDirectory())
        #expect(home.hasPrefix(FileManager.default.temporaryDirectory.path))
        #expect(isolated["PATH"] == "/usr/bin")
    }

    /// Any new code (app or tests) that goes back to the user's preferences or pasteboard.
    @Test
    func nothingReachesTheUsersPreferencesOrPasteboardDirectly() throws {
        // The one file that defines appDefaults / appPasteboard, and this one.
        let allowed: Set = ["IsRunningPreviews.swift", "AppIsolationGuardTests.swift"]
        let standardDefaults = ["UserDefaults", "standard"].joined(separator: ".")
        let generalPasteboard = ["NSPasteboard", "general"].joined(separator: ".")
        var offenders: [String] = []

        for folder in ["Untether", "UntetherTests"] {
            for file in try Self.swiftFiles(in: folder) where !allowed.contains(file.lastPathComponent) {
                let source = try String(contentsOf: file, encoding: .utf8)
                for (index, line) in source.components(separatedBy: "\n").enumerated() {
                    let code = line.trimmingCharacters(in: .whitespaces)
                    guard !code.hasPrefix("//") else { continue }
                    let location = "\(file.lastPathComponent):\(index + 1)"
                    if code.contains(standardDefaults) || code.contains("UserDefaults = .standard") {
                        offenders.append("\(location) uses the standard preferences, use appDefaults")
                    }
                    if code.contains(generalPasteboard) {
                        offenders.append("\(location) uses the general pasteboard, use appPasteboard")
                    }
                    if code.contains("@AppStorage("), !code.contains("store: appDefaults") {
                        offenders.append("\(location) has an @AppStorage without store: appDefaults")
                    }
                }
            }
        }
        #expect(offenders.isEmpty, "\(offenders.joined(separator: "\n"))")
    }
}
