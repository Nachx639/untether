import Foundation
import Testing
@testable import Untether

/// The menu's pure session logic: which moment a row's time counts from, how rows are
/// bucketed and ordered, what line 2 says, and how addresses are shortened.
@Suite("Menu Session List")
@MainActor
struct MenuSessionListTests {
    // MARK: - Fixtures

    private static func iso(_ date: Date) -> String {
        date.formatted(.iso8601)
    }

    private static func ms(_ date: Date) -> Double {
        date.timeIntervalSince1970 * 1000
    }

    private static func claude(
        _ status: String,
        since: Date?,
        waitingFor: String? = nil,
        activity: ClaudeActivity? = nil,
        choices: ClaudeChoices? = nil)
        -> ClaudeStatus
    {
        ClaudeStatus(
            status: status,
            waitingFor: waitingFor,
            title: nil,
            preview: ClaudePreview(role: "assistant", text: "Running: Build to verify"),
            activity: activity,
            choices: choices,
            since: since.map(Self.ms),
            waitingForBackground: nil)
    }

    private static func session(
        _ id: String,
        workingDir: String = "/tmp/project",
        command: [String] = ["claude"],
        claude: ClaudeStatus? = nil,
        lastActivityAt: Date? = Date(),
        shielded: Bool? = nil,
        userTitle: String? = nil,
        status: String = "running")
        -> ServerSessionInfo
    {
        var info = ServerSessionInfo(
            id: id,
            name: id,
            command: command,
            workingDir: workingDir,
            status: status,
            exitCode: nil,
            startedAt: Self.iso(Date().addingTimeInterval(-86400)),
            pid: nil,
            initialCols: nil,
            initialRows: nil,
            lastClearOffset: nil,
            version: nil,
            gitRepoPath: nil,
            gitBranch: nil,
            gitAheadCount: nil,
            gitBehindCount: nil,
            gitHasChanges: nil,
            gitIsWorktree: nil,
            gitMainRepoPath: nil,
            lastModified: Self.iso(Date()),
            active: true,
            activityStatus: SessionActivityStatus(isActive: true, lastActivityAt: lastActivityAt.map(Self.iso)),
            source: nil,
            remoteId: nil,
            remoteName: nil,
            remoteUrl: nil,
            attachedViaUT: nil)
        info.claudeStatus = claude
        info.shielded = shielded
        info.userTitle = userTitle ?? id
        return info
    }

    // MARK: - Timestamp

    /// Claude's screen redraws all the time, so the output time read "now" on every agent row.
    @Test
    func idleAgentUsesItsStatusChangeNotTheLastOutput() {
        let turnEnded = Date().addingTimeInterval(-42 * 60)
        let display = SessionDisplay(info: Self.session("a", claude: Self.claude("idle", since: turnEnded)))
        #expect(abs(display.lastActivity!.timeIntervalSince(turnEnded)) < 1)
        #expect(SessionDisplay.shortAge(from: display.lastActivity, now: Date()) == "42m")
    }

    @Test
    func waitingAndWorkingCountFromTheirStatusChange() {
        let since = Date().addingTimeInterval(-3 * 60)
        let waiting = SessionDisplay(info: Self.session("w", claude: Self.claude("waiting", since: since)))
        let working = SessionDisplay(info: Self.session("b", claude: Self.claude("busy", since: since)))
        #expect(SessionDisplay.shortAge(from: waiting.lastActivity, now: Date()) == "3m")
        #expect(SessionDisplay.shortAge(from: working.lastActivity, now: Date()) == "3m")
        #expect(SessionDisplay.spokenTime(for: .working, from: working.lastActivity, now: Date()).hasPrefix("for "))
    }

    @Test
    func shellsAndAgentsWithoutSinceUseTheLastActivity() {
        let output = Date().addingTimeInterval(-2 * 3600)
        let shell = SessionDisplay(info: Self.session("s", command: ["zsh"], lastActivityAt: output))
        #expect(SessionDisplay.shortAge(from: shell.lastActivity, now: Date()) == "2h")
        let agent = SessionDisplay(info: Self.session("a", claude: Self.claude("idle", since: nil), lastActivityAt: output))
        #expect(SessionDisplay.shortAge(from: agent.lastActivity, now: Date()) == "2h")
    }

    @Test
    func nowOnlyUnderAMinute() {
        let now = Date()
        #expect(SessionDisplay.shortAge(from: now.addingTimeInterval(-59), now: now) == "now")
        #expect(SessionDisplay.shortAge(from: now.addingTimeInterval(-61), now: now) == "1m")
    }

    // MARK: - Line 2

    @Test
    func waitingRowSaysWhatThePromptIsAbout() {
        let choices = ClaudeChoices(
            question: "Do you want to proceed?",
            options: ["Yes", "No"],
            detail: ["Bash command", "pnpm test", "Run the tests"])
        let display = SessionDisplay(info: Self.session(
            "w",
            claude: Self.claude("waiting", since: Date(), waitingFor: "permission_prompt", choices: choices)))
        #expect(display.statusText == "Permission request")
        #expect(display.detailText == "Bash command: pnpm test")
    }

    @Test
    func waitingDetailFallsBackToTheQuestion() {
        #expect(SessionDisplay.waitingDetail(ClaudeChoices(question: "Proceed?", options: nil, detail: nil)) == "Proceed?")
        #expect(SessionDisplay.waitingDetail(ClaudeChoices(
            question: "Would you like to proceed?",
            options: nil,
            detail: ["Plan: answer sheet", "1. Parse"])) == "Plan: answer sheet")
        #expect(SessionDisplay.waitingDetail(nil) == nil)
    }

    @Test
    func workingRowShowsTheActivityNotThePreview() {
        let activity = ClaudeActivity(kind: "tool", tool: "Edit", target: "SessionRow.swift", since: nil)
        let display = SessionDisplay(info: Self.session("b", claude: Self.claude("busy", since: Date(), activity: activity)))
        #expect(display.statusText == "Editing SessionRow.swift")
        #expect(display.detailText == nil)
    }

    @Test
    func idleRowHasNoNoise() {
        let display = SessionDisplay(info: Self.session("i", claude: Self.claude("idle", since: Date())))
        #expect(display.statusText == nil)
        #expect(display.detailText == nil)
    }

    @Test
    func projectLabelAndShield() {
        let home = SessionDisplay(info: Self.session("h", workingDir: NSHomeDirectory(), shielded: true))
        #expect(home.projectLabel == "~")
        #expect(home.isShielded)
        let project = SessionDisplay(info: Self.session("p", workingDir: "/Users/x/Projects/untether"))
        #expect(project.projectLabel == "untether")
        #expect(!project.isShielded)
    }

    // MARK: - Sections

    @Test
    func sectionsPutNeedsYouFirstThenWorkingIdleOther() {
        let now = Date()
        let displays = [
            Self.session("idle-old", claude: Self.claude("idle", since: now.addingTimeInterval(-3600))),
            Self.session("shell", command: ["zsh"]),
            Self.session("idle-new", claude: Self.claude("idle", since: now.addingTimeInterval(-60))),
            Self.session("busy", claude: Self.claude("busy", since: now)),
            Self.session("waiting", claude: Self.claude("waiting", since: now.addingTimeInterval(-600))),
        ].map(SessionDisplay.init(info:))

        let sections = SessionSection.make(from: displays, filter: "")
        #expect(sections.map(\.kind) == [.needsYou, .working, .idle, .terminals])
        #expect(sections[2].sessions.map(\.id) == ["idle-new", "idle-old"])
    }

    /// 2026-10-31: suspended sessions have their own section, last, not among the idle ones;
    /// by project, the latest paused first, and a paused orchestrator in its project.
    @Test
    func suspendedSessionsHaveTheirOwnSection() throws {
        let now = Date()
        func paused(_ id: String, minutesAgo: Double, dir: String, orchestratorOf: String? = nil) -> ServerSessionInfo {
            var info = Self.session(
                id, workingDir: dir, claude: Self.claude("idle", since: now.addingTimeInterval(-7200)), status: "exited")
            info.suspended = SessionSuspensionInfo(
                at: Self.iso(now.addingTimeInterval(-minutesAgo * 60)),
                resumeError: nil,
                orchestratorOf: orchestratorOf)
            return info
        }
        let displays = [
            Self.session("live", claude: Self.claude("idle", since: now)),
            paused("b-old", minutesAgo: 300, dir: "/tmp/beta"),
            paused("a-orch", minutesAgo: 30, dir: "/Users/x/Projects", orchestratorOf: "/Users/x/Projects/alpha"),
            paused("b-new", minutesAgo: 5, dir: "/tmp/beta"),
        ].map(SessionDisplay.init(info:))

        let sections = SessionSection.make(from: displays, filter: "")
        #expect(sections.map(\.kind) == [.idle, .suspended])
        #expect(sections[0].sessions.map(\.id) == ["live"])
        #expect(sections[1].sessions.map(\.id) == ["a-orch", "b-new", "b-old"])
        let orchestrator = try #require(displays.first { $0.id == "a-orch" })
        #expect(orchestrator.projectLabel == "alpha")
        #expect(orchestrator.isSuspended)
        // The row's time is since when it is paused.
        let paused30 = try #require(orchestrator.lastActivity)
        #expect(abs(paused30.timeIntervalSince(now.addingTimeInterval(-1800))) < 2)
    }

    @Test
    func filterDropsEmptySections() {
        let displays = [
            Self.session("fix menu", claude: Self.claude("idle", since: Date())),
            Self.session("other", claude: Self.claude("busy", since: Date())),
        ].map(SessionDisplay.init(info:))
        let sections = SessionSection.make(from: displays, filter: "menu")
        #expect(sections.map(\.kind) == [.idle])
        #expect(SessionSection.make(from: displays, filter: "nothing").isEmpty)
    }

    @Test
    func projectsShowOnlyWhenTheListSpansSeveral() {
        let one = [
            Self.session("a", workingDir: "/p/one"),
            Self.session("b", workingDir: "/p/one"),
        ].map(SessionDisplay.init(info:))
        #expect(!SessionSection.showsProjects(in: SessionSection.make(from: one, filter: "")))
        let two = one + [SessionDisplay(info: Self.session("c", workingDir: "/p/two"))]
        #expect(SessionSection.showsProjects(in: SessionSection.make(from: two, filter: "")))
    }

    @Test
    func summaryCountsInSectionOrder() {
        let displays = [
            Self.session("w1", claude: Self.claude("waiting", since: Date())),
            Self.session("w2", claude: Self.claude("waiting", since: Date())),
            Self.session("i", claude: Self.claude("idle", since: Date())),
        ].map(SessionDisplay.init(info:))
        #expect(MenuSessionSummary.parts(for: displays).map(\.text) == ["2 need you", "1 idle"])
        #expect(MenuSessionSummary.parts(for: displays).first?.isUrgent == true)
    }

    // MARK: - Addresses

    @Test
    func addressesAreShortened() {
        #expect(MenuAddress.short("my-mac.example.ts.net:4020") == "my-mac:4020")
        #expect(MenuAddress.short("https://my-mac.example.ts.net") == "my-mac")
        #expect(MenuAddress.short("https://my-mac.example.ts.net/") == "my-mac")
        #expect(MenuAddress.short("127.0.0.1:4020") == "127.0.0.1:4020")
        #expect(MenuAddress.short("localhost:4020") == "localhost:4020")
        #expect(MenuAddress.short("https://ab12.ngrok-free.app") == "ab12.ngrok-free.app")
    }

    // MARK: - Review fixes (2026-10-12)

    @Test
    func backgroundWaitIsLabelledAsSuchNotAsTurnEnd() {
        var status = Self.claude("busy", since: Date(timeIntervalSince1970: 1_000_000))
        status = ClaudeStatus(
            status: status.status, waitingFor: nil, title: nil, preview: status.preview,
            activity: nil, choices: nil, since: status.since, waitingForBackground: true)
        #expect(SessionDisplay.state(for: Self.session("bg", claude: status)) == .idle)
        let date = Date(timeIntervalSince1970: 1_000_000)
        #expect(SessionDisplay.timeHelp(state: .idle, waitingForBackground: true, date: date)
            .hasPrefix("Background agents since"))
        #expect(SessionDisplay.timeHelp(state: .idle, waitingForBackground: false, date: date)
            .hasPrefix("Last turn ended"))
    }

    @Test
    func killKeyRepeatNeverConfirms() {
        #expect(MenuSessionCoordinator.killKeyDecision(sessionId: "a", pendingKillId: nil, isRepeat: false) == .request)
        #expect(MenuSessionCoordinator.killKeyDecision(sessionId: "a", pendingKillId: "a", isRepeat: false) == .confirm)
        // Held ⌫: the repeat after the request must not kill.
        #expect(MenuSessionCoordinator.killKeyDecision(sessionId: "a", pendingKillId: "a", isRepeat: true) == .ignore)
        #expect(MenuSessionCoordinator.killKeyDecision(sessionId: "a", pendingKillId: "b", isRepeat: false) == .request)
    }

    @Test
    func unchangedRenameDoesNotPinAUserTitle() {
        #expect(MenuSessionCoordinator.isRenameNoOp("", userTitle: nil))
        #expect(MenuSessionCoordinator.isRenameNoOp("  ", userTitle: nil))
        #expect(MenuSessionCoordinator.isRenameNoOp("Mine", userTitle: "Mine"))
        #expect(!MenuSessionCoordinator.isRenameNoOp("New", userTitle: nil))
        #expect(!MenuSessionCoordinator.isRenameNoOp("", userTitle: "Mine"))
    }

    @Test
    func branchChipShowsTheLastComponent() {
        #expect(BranchChip.shortName("wip/loc/menu-polish") == "…/menu-polish")
        #expect(BranchChip.shortName("feature") == "feature")
        #expect(BranchChip.shortName("trailing/") == "trailing/")
    }
}
