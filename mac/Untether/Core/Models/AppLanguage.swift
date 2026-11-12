import AppKit
import Foundation
import OSLog

/// The language the Mac app's interface uses, chosen in Settings → General.
///
/// The choice is stored the way macOS stores a per-app language (System Settings →
/// General → Language & Region → Applications): `AppleLanguages` in the app's own
/// defaults domain. Foundation reads it once at launch, so a change applies after a
/// relaunch (`relaunch()`).
///
/// Right-to-left: AppKit and `NSHostingView` stay left-to-right for Arabic unless
/// `AppleTextDirection` and `NSForceRightToLeftWritingDirection` are also set, so
/// `apply()` writes those two keys alongside the language.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system
    case es
    case en
    case fr
    case ptBR = "pt-BR"
    case zhHans = "zh-Hans"
    case ar
    case bn
    case hi

    var id: String { self.rawValue }

    /// Language code written to `AppleLanguages`; nil follows the system.
    var code: String? {
        self == .system ? nil : self.rawValue
    }

    /// Each language's own name. Never translated, so people can find their language
    /// whatever the interface is in. Render with `Text(verbatim:)`.
    var endonym: String {
        switch self {
        case .system: ""
        case .es: "Español"
        case .en: "English"
        case .fr: "Français"
        case .ptBR: "Português (Brasil)"
        case .zhHans: "简体中文"
        case .ar: "العربية"
        case .bn: "বাংলা"
        case .hi: "हिन्दी"
        }
    }

    /// Name shown in the picker.
    var displayName: String {
        self == .system
            ? String(localized: "System Default", comment: "Language picker: follow the language set in macOS")
            : self.endonym
    }

    var isRightToLeft: Bool {
        self == .ar
    }

    private static let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "AppLanguage")

    private static var appDomain: [String: Any]? {
        guard let bundleID = Bundle.main.bundleIdentifier else { return nil }
        return appDefaults.persistentDomain(forName: bundleID)
    }

    /// The stored choice. Reads the app's own domain: `UserDefaults.array(forKey:)`
    /// would return the global language list when the app has no override.
    static var selected: AppLanguage {
        self.selected(in: self.appDomain)
    }

    /// The choice stored in a defaults domain (the app's own, or a test suite's).
    static func selected(in domain: [String: Any]?) -> AppLanguage {
        guard let languages = domain?[UserDefaultsKeys.appleLanguages] as? [String],
              let first = languages.first
        else { return .system }
        return self.matching(code: first) ?? .system
    }

    /// The language this process launched with, captured once. A different
    /// `selected` means a relaunch is pending.
    static let launchLanguage: AppLanguage = selected

    /// Maps a language identifier ("es-419", "zh-Hans-CN", "pt-BR") to a supported case.
    static func matching(code: String) -> AppLanguage? {
        if let exact = AppLanguage(rawValue: code), exact != .system { return exact }
        let lowered = code.lowercased()
        if lowered.hasPrefix("zh-hans") || lowered == "zh-cn" || lowered == "zh-sg" { return .zhHans }
        if lowered.hasPrefix("pt") { return .ptBR }
        let base = String(lowered.prefix { $0 != "-" && $0 != "_" })
        return AppLanguage(rawValue: base).flatMap { $0 == .system || $0 == .ptBR || $0 == .zhHans ? nil : $0 }
    }

    /// Stores this choice for the next launch.
    func apply(to defaults: UserDefaults = appDefaults) {
        if let code {
            defaults.set([code], forKey: UserDefaultsKeys.appleLanguages)
        } else {
            defaults.removeObject(forKey: UserDefaultsKeys.appleLanguages)
        }
        Self.writeLayoutDirection(rightToLeft: self.resolvedIsRightToLeft, defaults: defaults)
        Self.logger.info("App language set to \(self.rawValue, privacy: .public)")
    }

    /// For `.system`, whether the first system language is right-to-left.
    var resolvedIsRightToLeft: Bool {
        if self != .system { return self.isRightToLeft }
        guard let first = Locale.preferredLanguages.first else { return false }
        return Self.matching(code: first)?.isRightToLeft ?? false
    }

    private static func writeLayoutDirection(rightToLeft: Bool, defaults: UserDefaults = appDefaults) {
        if rightToLeft {
            defaults.set(true, forKey: UserDefaultsKeys.appleTextDirection)
            defaults.set(true, forKey: UserDefaultsKeys.forceRightToLeftWritingDirection)
        } else {
            defaults.removeObject(forKey: UserDefaultsKeys.appleTextDirection)
            defaults.removeObject(forKey: UserDefaultsKeys.forceRightToLeftWritingDirection)
        }
    }

    /// Called at launch: when following the system, keep the direction keys in step
    /// with the system language (takes effect on the next launch if it changed).
    static func syncLayoutDirectionAtLaunch() {
        let current = self.selected
        let wantsRTL = current.resolvedIsRightToLeft
        let hasRTL = self.appDomain?[UserDefaultsKeys.forceRightToLeftWritingDirection] as? Bool ?? false
        if wantsRTL != hasRTL {
            self.writeLayoutDirection(rightToLeft: wantsRTL)
        }
    }

    // MARK: - Relaunch

    /// Launch argument that tells the new instance which process it replaces.
    static let relaunchAfterArgument = "--relaunch-after"

    /// PID of the instance this process replaces, from `--relaunch-after <pid>`.
    static func relaunchParentPID(arguments: [String] = CommandLine.arguments) -> pid_t? {
        guard let index = arguments.firstIndex(of: relaunchAfterArgument),
              arguments.indices.contains(index + 1),
              let pid = pid_t(arguments[index + 1]), pid > 0
        else { return nil }
        return pid
    }

    /// In a relaunched instance, waits (up to `timeout`) for the previous instance to
    /// quit so it can stop its server and free the port before this one starts.
    static func waitForRelaunchParent(timeout: TimeInterval = 5) {
        guard let pid = relaunchParentPID(), pid != getpid() else { return }
        let deadline = Date().addingTimeInterval(timeout)
        while kill(pid, 0) == 0, Date() < deadline {
            usleep(50000)
        }
        self.logger.info("Relaunch: previous instance \(pid) \(kill(pid, 0) == 0 ? "still running" : "exited")")
    }

    /// Opens a new instance of the app and quits this one. The new instance waits for
    /// this process to exit (see `waitForRelaunchParent`). Quitting stops the server,
    /// which ends sessions that aren't shielded: confirm with the user first.
    @MainActor
    static func relaunch() {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.arguments = [self.relaunchAfterArgument, String(getpid())]
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, error in
            Task { @MainActor in
                if let error {
                    self.logger.error("Relaunch failed: \(error.localizedDescription, privacy: .public)")
                    return
                }
                NSApp.terminate(nil)
            }
        }
    }
}
