import Foundation
import Observation
import OSLog

/// Manager for Untether configuration stored in ~/.untether/config.json
/// Provides centralized configuration management for all app settings
@MainActor
@Observable
final class ConfigManager {
    static let shared = ConfigManager()

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "ConfigManager")
    private let configDir: URL
    private let configPath: URL
    private var fileMonitor: DispatchSourceFileSystemObject?
    private var monitoringWanted = false
    private var reloadGeneration = 0
    private var hasLoadedFromDisk = false
    private var failedReads = 0
    private var failedSaves = 0
    private var pendingChanges: Set<Change> = []

    private static let maxReadRetries = 5
    private static let maxSaveRetries = 3
    private static let retryDelay: TimeInterval = 0.5
    private static let reopenDelay: TimeInterval = 1

    // Core configuration
    private(set) var quickStartCommands: [QuickStartCommand] = []
    var repositoryBasePath: String = FilePathConstants.defaultRepositoryBasePath

    // Notification preferences. The master switch is off until config.json says otherwise,
    // like the server's default (web/src/types/config.ts DEFAULT_NOTIFICATION_PREFERENCES):
    // 2026-11-10, with a config.json that had no notification section the app took them as
    // on while the server and the web interface showed them off.
    var notificationsEnabled: Bool = false
    var notificationSessionStart: Bool = true
    var notificationSessionExit: Bool = true
    var notificationCommandCompletion: Bool = true
    var notificationCommandError: Bool = true
    var notificationBell: Bool = true
    var notificationSoundEnabled: Bool = true
    var notificationVibrationEnabled: Bool = true

    /// What this app reads of config.json. The other keys are the server's: they are kept
    /// as they are when this app saves (see saveConfiguration).
    ///
    /// 2026-11-11: this struct also decoded the sections server, development, remoteAccess and
    /// sessionDefaults and four switches of preferences into properties that nothing read
    /// (those settings live in UserDefaults); they are gone here and in the server's schema.
    private struct UntetherConfig: Codable {
        let version: Int
        var quickStartCommands: [QuickStartCommand]
        var repositoryBasePath: String?

        var preferences: PreferencesConfig?
    }

    private struct PreferencesConfig: Codable {
        var notifications: NotificationConfig?
    }

    private struct NotificationConfig: Codable {
        var enabled: Bool
        var sessionStart: Bool
        var sessionExit: Bool
        var commandCompletion: Bool
        var commandError: Bool
        var bell: Bool
        var soundEnabled: Bool
        var vibrationEnabled: Bool
    }

    /// Default commands matching web/src/types/config.ts
    private let defaultCommands = [
        QuickStartCommand(name: "✨ codex", command: "codex"),
        QuickStartCommand(name: "✨ claude", command: "claude"),
        QuickStartCommand(name: "✨ auggie", command: "auggie"),
        QuickStartCommand(name: nil, command: "gemini3"),
        QuickStartCommand(name: nil, command: "opencode 4"),
        QuickStartCommand(name: nil, command: "zsh"),
        QuickStartCommand(name: nil, command: "node"),
    ]

    private convenience init() {
        if isRunningTests {
            // Never the real ~/.untether from the test host (see isRunningTests).
            self.init(configDir: FileManager.default.temporaryDirectory
                .appendingPathComponent("untether-test-config-\(ProcessInfo.processInfo.processIdentifier)"))
        } else {
            self.init(configDir: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".untether"))
        }
    }

    /// `configDir` is `~/.untether` in the app; the tests give a folder of their own.
    init(configDir: URL) {
        self.configDir = configDir
        self.configPath = configDir.appendingPathComponent("config.json")

        // Load initial configuration
        self.loadConfiguration()

        // Start monitoring for changes
        self.startFileMonitoring()
    }

    // MARK: - Configuration Loading

    /// Reads config.json into memory. A file that cannot be read is never replaced.
    ///
    /// 2026-11-10: any failure to read (the server writes config.json in place, so a read in the
    /// middle of its write sees half a file; or a half-finished edit by hand) used to call
    /// useDefaults(), which WROTE the defaults over the file: quick start commands, repository
    /// path and notification settings were lost. Now what is in memory stays, nothing is
    /// written, and the read is tried again a few times.
    func loadConfiguration() {
        // Ensure directory exists
        try? FileManager.default.createDirectory(at: self.configDir, withIntermediateDirectories: true)

        guard FileManager.default.fileExists(atPath: self.configPath.path) else {
            self.logger.info("No config file found, creating with defaults")
            self.useDefaults()
            self.writeNewConfigurationFile()
            return
        }

        do {
            let data = try Data(contentsOf: configPath)
            let config = try JSONDecoder().decode(UntetherConfig.self, from: data)
            self.apply(config)
            self.hasLoadedFromDisk = true
            self.failedReads = 0
            self.logger.info("Loaded configuration from disk")
        } catch {
            self.logger.error(
                "Failed to load config, keeping what is in memory: \(error.localizedDescription, privacy: .public)")
            if !self.hasLoadedFromDisk, self.quickStartCommands.isEmpty {
                // First read of this run: defaults in memory only, the file is left alone.
                self.useDefaults()
            }
            self.retryLoadLater()
        }
    }

    private func apply(_ config: UntetherConfig) {
        self.quickStartCommands = config.quickStartCommands
        self.repositoryBasePath = config.repositoryBasePath ?? FilePathConstants.defaultRepositoryBasePath

        if let notif = config.preferences?.notifications {
            self.notificationsEnabled = notif.enabled
            self.notificationSessionStart = notif.sessionStart
            self.notificationSessionExit = notif.sessionExit
            self.notificationCommandCompletion = notif.commandCompletion
            self.notificationCommandError = notif.commandError
            self.notificationBell = notif.bell
            self.notificationSoundEnabled = notif.soundEnabled
            self.notificationVibrationEnabled = notif.vibrationEnabled
        }
    }

    /// A failed read is usually a write in progress: look again shortly, a few times.
    private func retryLoadLater() {
        guard self.failedReads < Self.maxReadRetries else { return }
        self.failedReads += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.retryDelay) { [weak self] in
            guard let self, self.failedReads > 0 else { return }
            self.loadConfiguration()
        }
    }

    /// The defaults, in memory only.
    private func useDefaults() {
        self.quickStartCommands = self.defaultCommands
        self.repositoryBasePath = FilePathConstants.defaultRepositoryBasePath

        // Set notification defaults to match TypeScript defaults
        // Master switch is OFF by default, but individual preferences are set to true
        self.notificationsEnabled = false // Changed from true to match web defaults
        self.notificationSessionStart = true
        self.notificationSessionExit = true
        self.notificationCommandCompletion = true
        self.notificationCommandError = true
        self.notificationBell = true
        self.notificationSoundEnabled = true
        self.notificationVibrationEnabled = true
    }

    // MARK: - Configuration Saving

    /// What a save changes in config.json; every other key of the file stays as it is.
    private enum Change {
        case quickStartCommands
        case repositoryBasePath
        case notifications
    }

    private enum ExistingFile {
        case missing
        case object([String: Any])
        case unreadable
    }

    private func readExistingFile() -> ExistingFile {
        guard FileManager.default.fileExists(atPath: self.configPath.path) else { return .missing }
        guard let data = try? Data(contentsOf: self.configPath),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return .unreadable
        }
        return .object(object)
    }

    /// The first config.json of an install: what the server would write (types/config.ts DEFAULT_CONFIG).
    private func writeNewConfigurationFile() {
        var object: [String: Any] = ["version": 2]
        self.put(.quickStartCommands, into: &object)
        self.put(.repositoryBasePath, into: &object)
        self.write(object)
    }

    /// Saves one change by merging it into the JSON on disk.
    ///
    /// 2026-11-10: saving used to re-encode the whole file from the keys this app knows, which
    /// dropped every key only the server writes (autoApprove, modelProviders, taskModels…) and
    /// wrote back sections this app only holds a copy of. Now the file is read, the changed keys
    /// are set and the rest is written back untouched. A file that cannot be read right now is
    /// not replaced: the save is tried again, and only if it stays unreadable is it kept aside
    /// as config.json.unreadable before a new one is written.
    private func saveConfiguration(_ changes: Set<Change>) {
        self.pendingChanges.formUnion(changes)

        var object: [String: Any]
        switch self.readExistingFile() {
        case .missing:
            object = ["version": 2]
            self.pendingChanges.formUnion([.quickStartCommands, .repositoryBasePath])
        case let .object(existing):
            object = existing
        case .unreadable:
            if self.failedSaves < Self.maxSaveRetries {
                self.failedSaves += 1
                self.logger.warning("config.json cannot be read right now, saving again shortly")
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.retryDelay) { [weak self] in
                    guard let self, !self.pendingChanges.isEmpty else { return }
                    self.saveConfiguration([])
                }
                return
            }
            let aside = self.configDir.appendingPathComponent("config.json.unreadable")
            try? FileManager.default.removeItem(at: aside)
            do {
                try FileManager.default.copyItem(at: self.configPath, to: aside)
            } catch {
                self.logger.error(
                    "Could not keep the unreadable config.json aside, not saving: \(error.localizedDescription, privacy: .public)")
                return
            }
            self.logger.error("config.json stayed unreadable: kept as config.json.unreadable, writing a new one")
            object = ["version": 2]
            self.pendingChanges.formUnion([.quickStartCommands, .repositoryBasePath])
        }

        for change in self.pendingChanges {
            self.put(change, into: &object)
        }
        if object["version"] == nil { object["version"] = 2 }
        if self.write(object) {
            self.pendingChanges = []
            self.failedSaves = 0
        }
    }

    private func put(_ change: Change, into object: inout [String: Any]) {
        switch change {
        case .quickStartCommands:
            object["quickStartCommands"] = self.quickStartCommands.map { command -> [String: Any] in
                var entry: [String: Any] = ["id": command.id, "command": command.command]
                if let name = command.name { entry["name"] = name }
                return entry
            }
        case .repositoryBasePath:
            object["repositoryBasePath"] = self.repositoryBasePath
        case .notifications:
            var preferences = object["preferences"] as? [String: Any] ?? [:]
            var notifications = preferences["notifications"] as? [String: Any] ?? [:]
            notifications["enabled"] = self.notificationsEnabled
            notifications["sessionStart"] = self.notificationSessionStart
            notifications["sessionExit"] = self.notificationSessionExit
            notifications["commandCompletion"] = self.notificationCommandCompletion
            notifications["commandError"] = self.notificationCommandError
            notifications["bell"] = self.notificationBell
            notifications["soundEnabled"] = self.notificationSoundEnabled
            notifications["vibrationEnabled"] = self.notificationVibrationEnabled
            preferences["notifications"] = notifications
            object["preferences"] = preferences
        }
    }

    @discardableResult
    private func write(_ object: [String: Any]) -> Bool {
        do {
            let data = try JSONSerialization.data(
                withJSONObject: object,
                options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])

            // Ensure directory exists
            try FileManager.default.createDirectory(at: self.configDir, withIntermediateDirectories: true)

            // Write atomically to prevent corruption
            try data.write(to: self.configPath, options: .atomic)
            // The server keeps config.json at 0600; an atomic write makes a new file.
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: self.configPath.path)
            self.logger.info("Saved configuration to disk")
            // The atomic write put a new file in place: the monitor has to follow it.
            if self.fileMonitor != nil { self.startFileMonitoring() }
            return true
        } catch {
            self.logger.error("Failed to save config: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    // MARK: - File Monitoring

    /// Watches config.json and reloads it when it changes.
    ///
    /// 2026-11-10: the descriptor watches a file, not a path. Every atomic write (this app's
    /// own saves, an editor's) puts a NEW file at the path, so after this app's first save the
    /// monitor watched a file nobody would write again and changes made from the web interface
    /// did not reach the app until it was restarted. Now a delete or rename opens the path
    /// again, and a path that is not there yet is looked for until it is.
    private func startFileMonitoring() {
        // Stop any existing monitor
        self.stopFileMonitoring()
        self.monitoringWanted = true

        // Create file descriptor
        let fileDescriptor = open(configPath.path, O_EVTONLY)
        guard fileDescriptor != -1 else {
            self.logger.warning("Could not open config file for monitoring, trying again")
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.reopenDelay) { [weak self] in
                guard let self, self.monitoringWanted, self.fileMonitor == nil else { return }
                self.startFileMonitoring()
            }
            return
        }

        // Create dispatch source on main queue since ConfigManager is @MainActor
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fileDescriptor,
            eventMask: [.write, .delete, .rename],
            queue: .main)

        source.setEventHandler { [weak self, weak source] in
            guard let self, let source else { return }
            let replaced = !source.data.intersection([.delete, .rename]).isEmpty
            MainActor.assumeIsolated {
                if replaced, self.fileMonitor === source {
                    self.startFileMonitoring()
                }
                self.reloadGeneration += 1
                let generation = self.reloadGeneration

                // Debounce rapid changes
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self, self.reloadGeneration == generation else { return }

                    self.logger.info("Configuration file changed, reloading...")
                    let oldCommands = self.quickStartCommands
                    self.loadConfiguration()

                    // Only log if commands actually changed
                    if oldCommands != self.quickStartCommands {
                        self.logger.info("Quick start commands updated")
                    }
                }
            }
        }

        source.setCancelHandler {
            close(fileDescriptor)
        }

        source.resume()
        self.fileMonitor = source

        self.logger.info("Started monitoring configuration file")
    }

    func stopFileMonitoring() {
        self.monitoringWanted = false
        self.fileMonitor?.cancel()
        self.fileMonitor = nil
    }

    // MARK: - Public API

    /// Update quick start commands
    func updateQuickStartCommands(_ commands: [QuickStartCommand]) {
        guard commands != self.quickStartCommands else { return }

        self.quickStartCommands = commands
        self.saveConfiguration([.quickStartCommands])
        self.logger.info("Updated quick start commands: \(commands.count) items")
    }

    /// Reset to default commands
    func resetToDefaults() {
        self.updateQuickStartCommands(self.defaultCommands)
        self.logger.info("Reset quick start commands to defaults")
    }

    /// Add a new command
    func addCommand(name: String?, command: String) {
        var commands = self.quickStartCommands
        commands.append(QuickStartCommand(name: name, command: command))
        self.updateQuickStartCommands(commands)
    }

    /// Update an existing command
    func updateCommand(id: String, name: String?, command: String) {
        var commands = self.quickStartCommands
        if let index = commands.firstIndex(where: { $0.id == id }) {
            commands[index].name = name
            commands[index].command = command
            self.updateQuickStartCommands(commands)
        }
    }

    /// Delete a command
    func deleteCommand(id: String) {
        var commands = self.quickStartCommands
        commands.removeAll { $0.id == id }
        self.updateQuickStartCommands(commands)
    }

    /// Update repository base path
    func updateRepositoryBasePath(_ path: String) {
        guard path != self.repositoryBasePath else { return }

        self.repositoryBasePath = path
        self.saveConfiguration([.repositoryBasePath])
        self.logger.info("Updated repository base path to: \(path)")
    }

    /// Update notification preferences
    func updateNotificationPreferences(
        enabled: Bool? = nil,
        sessionStart: Bool? = nil,
        sessionExit: Bool? = nil,
        commandCompletion: Bool? = nil,
        commandError: Bool? = nil,
        bell: Bool? = nil,
        soundEnabled: Bool? = nil,
        vibrationEnabled: Bool? = nil)
    {
        // Update only the provided values
        if let enabled { self.notificationsEnabled = enabled }
        if let sessionStart { self.notificationSessionStart = sessionStart }
        if let sessionExit { self.notificationSessionExit = sessionExit }
        if let commandCompletion { self.notificationCommandCompletion = commandCompletion }
        if let commandError { self.notificationCommandError = commandError }
        if let bell { self.notificationBell = bell }
        if let soundEnabled { self.notificationSoundEnabled = soundEnabled }
        if let vibrationEnabled { self.notificationVibrationEnabled = vibrationEnabled }

        self.saveConfiguration([.notifications])
        self.logger.info("Updated notification preferences")
    }
}
