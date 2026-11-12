import Foundation
import Testing
@testable import Untether

// 2026-11-10: ConfigManager wrote the defaults over a config.json it could not read, dropped
// the keys only the server knows on every save, and stopped seeing changes after its own
// first save. Each test works in a folder of its own, never ~/.untether.
@Suite("ConfigManager", .serialized)
@MainActor
struct ConfigManagerTests {
    private static let serverConfig = """
    {
      "version": 2,
      "quickStartCommands": [{ "id": "mine", "name": "Mine", "command": "my-agent --flag" }],
      "repositoryBasePath": "~/Work",
      "autoApprove": true,
      "modelProviders": [{ "id": "p1", "baseUrl": "https://example.test/a/b" }],
      "server": { "port": 4999, "dashboardAccessMode": "localhost", "cleanupOnStartup": false, "authenticationMode": "os", "serverOnly": 1 },
      "preferences": {
        "showInDock": true,
        "preventSleepWhenRunning": false,
        "futureKey": "kept",
        "notifications": {
          "enabled": false, "sessionStart": false, "sessionExit": false, "commandCompletion": false,
          "commandError": true, "bell": false, "soundEnabled": true, "vibrationEnabled": false,
          "claudeTurn": true
        }
      }
    }
    """

    private func makeDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("untether-config-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func object(at url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// Waits in turns of the main queue, not by the clock: another suite may hold the main
    /// thread for a long time, and what is waited for needs the main queue to happen.
    private func waitUntil(turns: Int = 200, _ condition: () -> Bool) async -> Bool {
        for _ in 0..<turns {
            if condition() {
                return true
            }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return condition()
    }

    @Test
    func unreadableFileIsNotOverwrittenOnLaunch() throws {
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")
        // Half a file: what a read in the middle of the server's write sees.
        let half = Data(Self.serverConfig.utf8.prefix(120))
        try half.write(to: path)

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }

        #expect(try Data(contentsOf: path) == half)
        #expect(!manager.quickStartCommands.isEmpty) // defaults, in memory only
    }

    @Test
    func unreadableFileKeepsWhatIsInMemory() throws {
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")
        try Data(Self.serverConfig.utf8).write(to: path)

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }
        #expect(manager.quickStartCommands.map(\.command) == ["my-agent --flag"])
        #expect(manager.repositoryBasePath == "~/Work")

        let broken = Data("{ \"version\": 2, \"quickStartCommands\": [".utf8)
        try broken.write(to: path)
        manager.loadConfiguration()

        #expect(manager.quickStartCommands.map(\.command) == ["my-agent --flag"])
        #expect(manager.repositoryBasePath == "~/Work")
        #expect(try Data(contentsOf: path) == broken)
    }

    @Test
    func halfWrittenFileIsReadOnceItIsWhole() async throws {
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")
        try Data(Self.serverConfig.utf8.prefix(120)).write(to: path)

        let manager = ConfigManager(configDir: dir)
        manager.stopFileMonitoring() // only the retry of the failed read is under test
        try Data(Self.serverConfig.utf8).write(to: path)

        #expect(await self.waitUntil { manager.repositoryBasePath == "~/Work" })
        #expect(manager.quickStartCommands.map(\.command) == ["my-agent --flag"])
    }

    @Test
    func savingKeepsTheKeysThisAppDoesNotKnow() throws {
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")
        try Data(Self.serverConfig.utf8).write(to: path)

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }
        manager.updateRepositoryBasePath("~/Elsewhere")
        manager.addCommand(name: nil, command: "zsh")
        manager.updateNotificationPreferences(enabled: true, bell: true)

        let saved = try self.object(at: path)
        #expect(saved["repositoryBasePath"] as? String == "~/Elsewhere")
        #expect((saved["quickStartCommands"] as? [[String: Any]])?.compactMap { $0["command"] as? String }
            == ["my-agent --flag", "zsh"])
        #expect((saved["quickStartCommands"] as? [[String: Any]])?.first?["id"] as? String == "mine")
        // Top-level keys only the server writes.
        #expect(saved["autoApprove"] as? Bool == true)
        let providers = try #require(saved["modelProviders"] as? [[String: Any]])
        #expect(providers.first?["baseUrl"] as? String == "https://example.test/a/b")
        // Sections this app holds a copy of are written back as they were.
        let server = try #require(saved["server"] as? [String: Any])
        #expect(server["port"] as? Int == 4999)
        #expect(server["serverOnly"] as? Int == 1)
        // Nested keys next to the ones this app changes.
        let preferences = try #require(saved["preferences"] as? [String: Any])
        #expect(preferences["futureKey"] as? String == "kept")
        #expect(preferences["showInDock"] as? Bool == true)
        let notifications = try #require(preferences["notifications"] as? [String: Any])
        #expect(notifications["enabled"] as? Bool == true)
        #expect(notifications["bell"] as? Bool == true)
        #expect(notifications["commandCompletion"] as? Bool == false)
        #expect(notifications["claudeTurn"] as? Bool == true)
        // The server keeps the file private.
        let mode = try FileManager.default.attributesOfItem(atPath: path.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }

    @Test
    func savingOverAnUnreadableFileKeepsItAside() async throws {
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")
        try Data(Self.serverConfig.utf8).write(to: path)

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }
        let broken = Data("not json at all".utf8)
        try broken.write(to: path)

        manager.updateRepositoryBasePath("~/Elsewhere")
        // Not replaced at once: it may be a write in progress.
        #expect(try Data(contentsOf: path) == broken)

        let aside = dir.appendingPathComponent("config.json.unreadable")
        #expect(await self.waitUntil { FileManager.default.fileExists(atPath: aside.path) })
        #expect(try Data(contentsOf: aside) == broken)
        let saved = try self.object(at: path)
        #expect(saved["repositoryBasePath"] as? String == "~/Elsewhere")
        #expect((saved["quickStartCommands"] as? [[String: Any]])?.count == 1)
    }

    @Test
    func aSaveInterruptedByAWriteInProgressMergesIntoTheWholeFile() async throws {
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")
        try Data(Self.serverConfig.utf8).write(to: path)

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }
        try Data(Self.serverConfig.utf8.prefix(200)).write(to: path)
        manager.updateRepositoryBasePath("~/Elsewhere")
        try Data(Self.serverConfig.utf8).write(to: path) // the server finishes its write

        #expect(await self.waitUntil {
            (try? self.object(at: path))?["repositoryBasePath"] as? String == "~/Elsewhere"
        })
        #expect(try self.object(at: path)["autoApprove"] as? Bool == true)
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("config.json.unreadable").path))
    }

    @Test
    func missingFileIsCreatedWithDefaults() throws {
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }

        let saved = try self.object(at: dir.appendingPathComponent("config.json"))
        #expect(saved["version"] as? Int == 2)
        #expect((saved["quickStartCommands"] as? [[String: Any]])?.count == manager.quickStartCommands.count)
        #expect(saved["repositoryBasePath"] as? String == manager.repositoryBasePath)
        // Nothing the server would have to validate beyond its own defaults.
        #expect(Set(saved.keys) == ["version", "quickStartCommands", "repositoryBasePath"])
    }

    @Test
    func changesFromTheServerArriveAfterThisAppSaved() async throws {
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")
        try Data(Self.serverConfig.utf8).write(to: path)

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }

        // This app's save is atomic: a new file takes the path.
        manager.updateRepositoryBasePath("~/Elsewhere")

        // The server writes in place (fs.writeFileSync).
        let fromServer = Self.serverConfig.replacingOccurrences(of: "my-agent --flag", with: "from-the-web")
        let handle = try FileHandle(forWritingTo: path)
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: Data(fromServer.utf8))
        try handle.close()
        #expect(await self.waitUntil { manager.quickStartCommands.map(\.command) == ["from-the-web"] })

        // An editor (or any atomic writer) replaces the file: still followed.
        let fromEditor = Self.serverConfig.replacingOccurrences(of: "my-agent --flag", with: "from-an-editor")
        try Data(fromEditor.utf8).write(to: path, options: .atomic)
        #expect(await self.waitUntil { manager.quickStartCommands.map(\.command) == ["from-an-editor"] })

        // And once more in place, on the file the editor left.
        let again = Self.serverConfig.replacingOccurrences(of: "my-agent --flag", with: "from-the-web-again")
        try Data(again.utf8).write(to: path)
        #expect(await self.waitUntil { manager.quickStartCommands.map(\.command) == ["from-the-web-again"] })
    }

    @Test
    func theMasterSwitchIsSavedWhenItIsFlipped() throws {
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("config.json")
        try Data(Self.serverConfig.replacingOccurrences(of: "\"enabled\": false", with: "\"enabled\": true").utf8)
            .write(to: path)

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }
        #expect(manager.notificationsEnabled)

        manager.updateNotificationPreferences(enabled: false)

        // A new launch reads what was saved: still off.
        let relaunched = ConfigManager(configDir: dir)
        defer { relaunched.stopFileMonitoring() }
        #expect(!relaunched.notificationsEnabled)
    }

    @Test
    func withoutANotificationSectionTheyAreOffLikeOnTheServer() throws {
        let dir = try self.makeDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try Data(#"{"version":2,"quickStartCommands":[],"repositoryBasePath":"~/Work"}"#.utf8)
            .write(to: dir.appendingPathComponent("config.json"))

        let manager = ConfigManager(configDir: dir)
        defer { manager.stopFileMonitoring() }
        #expect(!manager.notificationsEnabled)
    }
}
