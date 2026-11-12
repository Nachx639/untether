import Foundation
import Testing
@testable import Untether

// 2026-11-10: when a session ended, its window was looked up again by folder name (or "a
// window of that terminal app") and closed: with two sessions in one project the wrong window
// went, and opening Session Details marked a session Untether never opened as closable.
@Suite("Window tracker: closing windows", .serialized)
@MainActor
struct WindowTrackerCloseTests {
    private let sessionID = "0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab"

    @Test
    func terminalWindowIsFoundByTheSessionTitleOnly() throws {
        let script = try #require(WindowTracker.closeWindowScript(
            sessionID: self.sessionID,
            opened: .init(terminalApp: .terminal, iTermWindowID: nil)))
        #expect(script.contains("custom title of tab 1 of w) is \"Session \(self.sessionID)\""))
        // A window that holds other tabs is not ours to close.
        #expect(script.contains("(count of tabs of w) is 1"))
        // Never "the window with this number": that number came from a lookup by folder name.
        #expect(!script.contains("whose id is"))
    }

    @Test
    func iTermWindowIsTheOneTheLaunchCreated() throws {
        let script = try #require(WindowTracker.closeWindowScript(
            sessionID: self.sessionID,
            opened: .init(terminalApp: .iTerm2, iTermWindowID: "4711")))
        #expect(script.contains("(id of w) is 4711 and (count of tabs of w) is 1"))

        #expect(WindowTracker.closeWindowScript(
            sessionID: self.sessionID,
            opened: .init(terminalApp: .iTerm2, iTermWindowID: nil)) == nil)
        #expect(WindowTracker.closeWindowScript(
            sessionID: self.sessionID,
            opened: .init(terminalApp: .iTerm2, iTermWindowID: "1\" then\nclose windows --")) == nil)
    }

    @Test
    func terminalsThatDoNotNameTheSessionAreLeftAlone() {
        for terminal in Terminal.allCases where terminal != .terminal && terminal != .iTerm2 {
            #expect(WindowTracker.closeWindowScript(
                sessionID: self.sessionID,
                opened: .init(terminalApp: terminal, iTermWindowID: "4711")) == nil)
        }
    }

    @Test
    func anIdThatIsNotASessionIdNeverReachesAScript() {
        for bad in ["", "x\" then\nclose windows --", "a b", "id\\", "ñ"] {
            #expect(WindowTracker.closeWindowScript(
                sessionID: bad,
                opened: .init(terminalApp: .terminal, iTermWindowID: nil)) == nil)
        }
    }

    @Test
    func onlyLaunchedSessionsAreClosable() {
        let tracker = WindowTracker.shared
        let external = "test-external-\(UUID().uuidString)"
        // A session attached with `ut`, or only looked at in Session Details: nothing to close.
        #expect(!tracker.wasOpenedByUs(external))
        #expect(!tracker.closeWindowIfOpenedByUs(for: external))

        // One launched in a terminal that cannot name it: known as ours, forgotten after one
        // try, and no script is run (no window is touched by this test).
        let launched = "test-launched-\(UUID().uuidString)"
        tracker.registerSessionOpenedByUs(for: launched, terminalApp: .ghostty)
        #expect(tracker.wasOpenedByUs(launched))
        #expect(!tracker.closeWindowIfOpenedByUs(for: launched))
        #expect(!tracker.wasOpenedByUs(launched))
    }
}
