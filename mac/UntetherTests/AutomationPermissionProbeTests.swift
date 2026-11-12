import ApplicationServices
import Testing
@testable import Untether

// 2026-11-11: Automation was "granted" for everybody: the check ran a script that targets no
// application. The answer now comes from AEDeterminePermissionToAutomateTarget.
@Suite("Automation Permission Probe Tests")
struct AutomationPermissionProbeTests {
    @Test
    func macOSAnswersMapToStatuses() {
        #expect(AutomationPermissionProbe.status(of: noErr) == .granted)
        #expect(AutomationPermissionProbe.status(of: OSStatus(errAEEventNotPermitted)) == .denied)
        #expect(AutomationPermissionProbe.status(of: -1744) == .notDetermined)
        #expect(AutomationPermissionProbe.status(of: OSStatus(procNotFound)) == .unknown)
    }

    @Test
    func refusedOrUndecidedIsNeverGranted() {
        #expect(AutomationPermissionProbe.evaluate([.denied]) == false)
        #expect(AutomationPermissionProbe.evaluate([.granted, .denied]) == false)
        #expect(AutomationPermissionProbe.evaluate([.notDetermined]) == false)
        #expect(AutomationPermissionProbe.evaluate([.granted, .notDetermined]) == false)
    }

    @Test
    func grantedNeedsARealAnswer() {
        #expect(AutomationPermissionProbe.evaluate([.granted]) == true)
        #expect(AutomationPermissionProbe.evaluate([.granted, .unknown]) == true)
        // Nothing running, nothing known: not "granted".
        #expect(AutomationPermissionProbe.evaluate([.unknown, .unknown]) == nil)
        #expect(AutomationPermissionProbe.evaluate([]) == nil)
    }

    @Test
    func theTargetsAreTheApplicationsUntetherScripts() {
        #expect(AutomationPermissionProbe.targets(preferredTerminal: nil) == ["com.apple.Terminal"])
        #expect(AutomationPermissionProbe.targets(preferredTerminal: "Terminal") == ["com.apple.Terminal"])
        #expect(AutomationPermissionProbe.targets(preferredTerminal: "iTerm2")
            == ["com.googlecode.iterm2", "com.apple.systemevents"])
        #expect(AutomationPermissionProbe.targets(preferredTerminal: "Ghostty")
            == ["com.mitchellh.ghostty", "com.apple.systemevents"])
    }

    @Test
    func anApplicationThatIsNotRunningGivesNoAnswer() {
        // A real call to macOS, without a consent dialog (askUserIfNeeded is false).
        #expect(AutomationPermissionProbe.status(forBundleIdentifier: "com.nachx639.untether.tests.not-installed")
            == .unknown)
    }
}
