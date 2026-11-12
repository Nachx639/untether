import Foundation
import Testing
@testable import Untether

/// The language picker's stored choice, the relaunch hand-off and the error mapping that
/// must not depend on the interface language.
@Suite("Localization")
struct LocalizationTests {
    // MARK: - AppLanguage

    @Test(arguments: [
        ("es", AppLanguage.es),
        ("es-419", .es),
        ("es-ES", .es),
        ("en-US", .en),
        ("fr-CA", .fr),
        ("pt-BR", .ptBR),
        ("pt-PT", .ptBR),
        ("zh-Hans", .zhHans),
        ("zh-Hans-CN", .zhHans),
        ("zh-CN", .zhHans),
        ("ar", .ar),
        ("ar-SA", .ar),
        ("bn-BD", .bn),
        ("hi-IN", .hi),
    ])
    func languageCodesMapToSupportedLanguages(code: String, expected: AppLanguage) {
        #expect(AppLanguage.matching(code: code) == expected)
    }

    @Test(arguments: ["de", "ja", "zh-Hant", "system", ""])
    func unsupportedCodesMapToNothing(code: String) {
        #expect(AppLanguage.matching(code: code) == nil)
    }

    @Test
    func onlyArabicIsRightToLeft() {
        #expect(AppLanguage.allCases.filter(\.isRightToLeft) == [.ar])
    }

    @Test
    func pickerOrderStartsWithSystemThenSpanish() {
        #expect(AppLanguage.allCases.first == .system)
        #expect(AppLanguage.allCases.dropFirst().first == .es)
        #expect(AppLanguage.allCases.count == 9)
    }

    @Test
    func endonymsAreNeverEmptyForRealLanguages() {
        for language in AppLanguage.allCases where language != .system {
            #expect(!language.endonym.isEmpty)
        }
    }

    @Test
    func applyWritesLanguageAndDirectionKeys() throws {
        let suiteName = "untether-localization-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        AppLanguage.ar.apply(to: defaults)
        var domain = defaults.persistentDomain(forName: suiteName)
        #expect(domain?[UserDefaultsKeys.appleLanguages] as? [String] == ["ar"])
        #expect(domain?[UserDefaultsKeys.appleTextDirection] as? Bool == true)
        #expect(domain?[UserDefaultsKeys.forceRightToLeftWritingDirection] as? Bool == true)
        #expect(AppLanguage.selected(in: domain) == .ar)

        AppLanguage.fr.apply(to: defaults)
        domain = defaults.persistentDomain(forName: suiteName)
        #expect(domain?[UserDefaultsKeys.appleLanguages] as? [String] == ["fr"])
        #expect(domain?[UserDefaultsKeys.appleTextDirection] == nil)
        #expect(domain?[UserDefaultsKeys.forceRightToLeftWritingDirection] == nil)
        #expect(AppLanguage.selected(in: domain) == .fr)
    }

    @Test
    func systemChoiceRemovesTheOverride() throws {
        let suiteName = "untether-localization-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        AppLanguage.es.apply(to: defaults)
        AppLanguage.system.apply(to: defaults)
        let domain = defaults.persistentDomain(forName: suiteName)
        #expect(domain?[UserDefaultsKeys.appleLanguages] == nil)
        #expect(AppLanguage.selected(in: domain) == .system)
        #expect(AppLanguage.selected(in: nil) == .system)
    }

    @Test
    func relaunchArgumentIsParsed() {
        #expect(AppLanguage.relaunchParentPID(arguments: ["Untether", "--relaunch-after", "4242"]) == 4242)
        #expect(AppLanguage.relaunchParentPID(arguments: ["Untether"]) == nil)
        #expect(AppLanguage.relaunchParentPID(arguments: ["Untether", "--relaunch-after"]) == nil)
        #expect(AppLanguage.relaunchParentPID(arguments: ["Untether", "--relaunch-after", "abc"]) == nil)
        #expect(AppLanguage.relaunchParentPID(arguments: ["Untether", "--relaunch-after", "-1"]) == nil)
    }

    // MARK: - Error mapping

    /// 2026-10-12: the status check matched English words in `localizedDescription`, which
    /// Foundation translates once the app has other languages. The mapping uses codes now.
    @Test(arguments: [
        (URLError.Code.cannotConnectToHost, "Untether server not responding"),
        (.networkConnectionLost, "Connection to server lost"),
        (.timedOut, "Server response timeout"),
        (.badURL, "Invalid server configuration"),
        (.notConnectedToInternet, "Network connectivity issue"),
        (.cancelled, "Unable to check Tailscale Serve status"),
    ])
    func tailscaleStatusErrorsMapByCode(code: URLError.Code, expected: String) {
        #expect(TailscaleServeStatusService.statusCheckErrorMessage(for: URLError(code)) == expected)
    }

    @Test
    func tailscaleStatusRefusedConnectionMapsByPOSIXCode() {
        let error = NSError(domain: NSPOSIXErrorDomain, code: Int(ECONNREFUSED))
        #expect(TailscaleServeStatusService.statusCheckErrorMessage(for: error) == "Untether server not responding")
    }

    // MARK: - Durations

    @Test
    func relativeTimesReadInEnglishUnderTheTestScheme() {
        let now = Date()
        #expect(DS.Time.ago(now.addingTimeInterval(-10), now: now) == "just now")
        #expect(DS.Time.ago(now.addingTimeInterval(-300), now: now) == "5 min ago")
        #expect(DS.Time.ago(now.addingTimeInterval(-7200), now: now) == "2 h ago")
    }
}
