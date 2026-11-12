import Foundation
import Testing
@testable import Untether

// The Mac side of the contract over ~/.untether/config.json, shared with the server of the
// same code (the server's side: web/src/server/services/app-server-config-contract.test.ts).
//
// 2026-11-11: an app built nine days before the server it ran could not decode the file that
// server wrote, and reset it in a loop. Two files in web/src/test/fixtures/config-contract tie
// the two sides: server-written.json is what the server's ConfigService writes today (its test
// fails when that changes) and is loaded here with ConfigManager; mac-written.json is what
// ConfigManager writes today (this suite fails when that changes) and is loaded there with
// ConfigService. Each test works in a folder of its own, never ~/.untether.
@Suite("Config contract with the server", .serialized)
@MainActor
struct ConfigContractTests {
    private static let contractDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // UntetherTests
        .deletingLastPathComponent() // mac
        .deletingLastPathComponent() // the repository
        .appendingPathComponent("web/src/test/fixtures/config-contract")

    private func makeDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("untether-config-contract-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func object(at url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test
    func theFileTheServerWritesLoadsAsItIs() throws {
        let golden = Self.contractDir.appendingPathComponent("server-written.json")
        let expected = try self.object(at: golden)
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")
        try FileManager.default.copyItem(at: golden, to: path)

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }

        // Loading never rewrites the server's file.
        #expect(try Data(contentsOf: path) == Data(contentsOf: golden))
        let commands = try #require(expected["quickStartCommands"] as? [[String: Any]])
        #expect(!commands.isEmpty)
        #expect(manager.quickStartCommands.map(\.command) == commands.compactMap { $0["command"] as? String })
        #expect(manager.quickStartCommands.map(\.name) == commands.map { $0["name"] as? String })
        #expect(manager.repositoryBasePath == expected["repositoryBasePath"] as? String)
        let preferences = try #require(expected["preferences"] as? [String: Any])
        let notifications = try #require(preferences["notifications"] as? [String: Any])
        #expect(manager.notificationsEnabled == notifications["enabled"] as? Bool)
        #expect(manager.notificationSessionStart == notifications["sessionStart"] as? Bool)
        #expect(manager.notificationSessionExit == notifications["sessionExit"] as? Bool)
        #expect(manager.notificationCommandCompletion == notifications["commandCompletion"] as? Bool)
        #expect(manager.notificationCommandError == notifications["commandError"] as? Bool)
        #expect(manager.notificationBell == notifications["bell"] as? Bool)
        #expect(manager.notificationSoundEnabled == notifications["soundEnabled"] as? Bool)
        #expect(manager.notificationVibrationEnabled == notifications["vibrationEnabled"] as? Bool)
    }

    @Test
    func aSaveOverTheServersFileKeepsEveryKeyThatIsTheServers() throws {
        let golden = Self.contractDir.appendingPathComponent("server-written.json")
        let expected = try self.object(at: golden)
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")
        try FileManager.default.copyItem(at: golden, to: path)

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }
        manager.updateRepositoryBasePath("~/Elsewhere")

        let saved = try self.object(at: path)
        #expect(saved["repositoryBasePath"] as? String == "~/Elsewhere")
        #expect(Set(saved.keys) == Set(expected.keys))
        for (key, value) in expected where key != "repositoryBasePath" {
            #expect(
                (saved[key] as? NSObject) == (value as? NSObject),
                "the app changed \(key), a key it was not asked to change")
        }
    }

    @Test
    func whatThisAppWritesIsTheFileTheServerTestsLoad() throws {
        let golden = Self.contractDir.appendingPathComponent("mac-written.json")
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")

        // A first launch (no file), then each kind of save this app makes.
        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }
        manager.updateQuickStartCommands([
            QuickStartCommand(id: "contract-1", name: "✨ claude", command: "claude"),
            QuickStartCommand(id: "contract-2", name: nil, command: "zsh"),
        ])
        manager.updateRepositoryBasePath("~/Projects")
        manager.updateNotificationPreferences(enabled: true, sessionStart: false, bell: false)

        let written = try self.object(at: path)
        let expected = try self.object(at: golden)
        let text = try String(decoding: Data(contentsOf: path), as: UTF8.self)
        #expect(
            (written as NSDictionary) == (expected as NSDictionary),
            """
            ConfigManager writes config.json differently now. Put this in \
            web/src/test/fixtures/config-contract/mac-written.json and run the server's \
            app-server-config-contract.test.ts, which says whether the server still reads it:
            \(text)
            """)
    }
}
