import Foundation

/// What an agent running in a session is doing, as the menu shows it.
///
/// Mirrors the web's `rowState()` (web/src/client/components/phone-session-row.ts): the order
/// of the cases is the sort order of the menu (sessions that need the user come first).
enum SessionAgentState: Int, Comparable, Sendable {
    /// Claude waits for the user (permission prompt, plan approval, input...).
    case needsYou = 0
    /// Claude is working on a turn.
    case working = 1
    /// An agent is running but resting (its reply is over).
    case idle = 2
    /// A plain program or shell: no agent status known.
    case shell = 3
    /// The session's program ended.
    case exited = 4

    static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    /// Short label for VoiceOver and tooltips.
    var label: String {
        switch self {
        case .needsYou:
            String(localized: "session.state.needsYou", defaultValue: "Needs you", comment: "Session state: the agent waits for the user")
        case .working:
            String(localized: "session.state.working", defaultValue: "Working", comment: "Session state: the agent is working")
        case .idle:
            String(localized: "session.state.idle", defaultValue: "Idle", comment: "Session state: the agent rests")
        case .shell:
            String(localized: "session.state.running", defaultValue: "Running", comment: "Session state: a plain program or shell runs")
        case .exited:
            String(localized: "session.state.exited", defaultValue: "Exited", comment: "Session state: the program ended")
        }
    }
}

/// Everything the menu shows about one session, computed once per change of the session list
/// (titles, tool, state, dates), so views never parse dates or commands in `body`.
struct SessionDisplay: Identifiable, Equatable, Sendable {
    let id: String
    let info: ServerSessionInfo
    /// The one title of the session (see `SessionDisplay.title(for:tool:)`).
    let title: String
    /// The program the session runs: "claude", "codex", "zsh"...
    let tool: String
    /// "claude", "codex" or "gemini" when an agent we know runs in the session.
    let agent: String?
    let state: SessionAgentState
    /// The state part of line 2: "Permission request", "Editing app.ts", "Exited"..., or nil.
    let statusText: String?
    /// The rest: what a waiting agent asks ("Bash command: pnpm test"), or the last line of a
    /// plain shell; nil when there is nothing worth a line.
    let detailText: String?
    /// Groups sessions of one repository (worktrees included) or one folder.
    let projectKey: String
    let projectName: String
    /// The project as rows show it: its folder name, "~" for the home folder.
    let projectLabel: String
    /// The session's branch, nil outside git.
    let branch: String?
    /// The session's folder with the home directory as "~".
    let abbreviatedPath: String
    /// The moment the row's time counts from (see `SessionDisplay.timestamp(for:state:)`).
    let lastActivity: Date?
    let startedAt: Date?
    /// Runs in a tmux session that survives server restarts.
    let isShielded: Bool
    /// Suspended by the server to free memory: listed in its own section, wakes when opened.
    let isSuspended: Bool

    init(info: ServerSessionInfo) {
        self.id = info.id
        self.info = info
        let tool = Self.tool(for: info)
        self.tool = tool
        self.agent = Self.knownAgents.contains(tool) ? tool : (info.claudeStatus != nil ? "claude" : nil)
        self.title = Self.title(for: info, tool: tool)
        let state = Self.state(for: info)
        self.state = state
        let subtitle = Self.subtitle(for: info, state: state)
        self.statusText = subtitle.0
        self.detailText = subtitle.1
        // A paused orchestrator stays in the project it orchestrated (as on the web).
        self.projectKey = info.suspended?.orchestratorOf ?? info.gitMainRepoPath ?? info.gitRepoPath ?? info.workingDir
        let projectName = (self.projectKey as NSString).lastPathComponent
        self.projectName = projectName.isEmpty ? self.projectKey : projectName
        self.projectLabel = Self.projectLabel(for: self.projectKey)
        self.branch = info.gitBranch?.trimmingCharacters(in: .whitespaces).nonEmpty
        self.abbreviatedPath = Self.abbreviate(info.workingDir)
        self.startedAt = Self.parseDate(info.startedAt)
        self.lastActivity = Self.timestamp(for: info, state: state)
        self.isShielded = info.shielded == true
        self.isSuspended = info.isSuspended
    }

    /// "~" for the home folder, else the folder name.
    static func projectLabel(for projectKey: String) -> String {
        if projectKey == self.homeDirectory || projectKey == "~" { return "~" }
        let name = (projectKey as NSString).lastPathComponent
        return name.isEmpty ? projectKey : name
    }

    /// "main" and "master" say nothing in a row; other branches do.
    static func isDefaultBranch(_ branch: String) -> Bool {
        ["main", "master", "trunk", "develop"].contains(branch)
    }

    // MARK: - Timestamp

    /// The moment a row's time counts from.
    ///
    /// For an agent it is when its status last changed (Claude Code writes `since`): the end of
    /// its last turn when idle, when it started waiting, or when the current turn began while it
    /// works (the row then shows how long it has been working). The terminal's last output is
    /// not: Claude's screen redraws all the time (spinner, status line, resizes), so
    /// `activityStatus.lastActivityAt` read "now" on every agent row (2026-10-12, menu QA). Plain
    /// shells use their last input or output.
    ///
    /// Deliberately differs from web/src/client/utils/last-activity.ts while the status is
    /// "busy": the web uses the last output there, the menu shows how long the turn has run. A
    /// busy session that only waits for background agents is shown idle, and its `since` is
    /// when the turn began (see `timeHelp`).
    static func timestamp(for info: ServerSessionInfo, state: SessionAgentState) -> Date? {
        // Suspended: since when it is paused.
        if let at = self.parseDate(info.suspended?.at) { return at }
        if state != .shell, state != .exited, let since = info.claudeStatus?.since, since > 0 {
            return Date(timeIntervalSince1970: since / 1000)
        }
        return self.parseDate(info.activityStatus?.lastActivityAt)
            ?? self.parseDate(info.lastModified)
            ?? self.parseDate(info.startedAt)
    }

    // MARK: - Title

    /// The user's title, else the agent's conversation title, else a name the user or `ut title`
    /// gave, else the project folder. Same priority as web/src/shared/session-title.ts; the
    /// server's generated name ("claude (~/Projects/x)") is never shown.
    static func title(for info: ServerSessionInfo, tool: String) -> String {
        if let userTitle = info.userTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !userTitle.isEmpty {
            return userTitle
        }
        let agentTitle = [info.claudeStatus?.title, info.claudeTitle, info.codexTitle, info.geminiTitle]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        if let agentTitle {
            return agentTitle
        }
        let name = info.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty, !self.isGeneratedName(name, info: info, tool: tool) {
            return name
        }
        let folder = ((info.gitRepoPath ?? info.workingDir) as NSString).lastPathComponent
        return folder.isEmpty ? (info.gitRepoPath ?? info.workingDir) : folder
    }

    /// The server names sessions "<command> (<abbreviated path>)", plus " (2)" when taken
    /// (web/src/server/utils/session-naming.ts); a bare command name is generated too.
    static func isGeneratedName(_ name: String, info: ServerSessionInfo, tool: String) -> Bool {
        let commandBase = ((info.command.first ?? "") as NSString).lastPathComponent
        let candidates = Set([tool, commandBase].filter { !$0.isEmpty })
        if candidates.contains(name) {
            return true
        }
        guard let space = name.firstIndex(of: " ") else { return false }
        let head = String(name[..<space])
        let rest = name[name.index(after: space)...]
        guard rest.hasPrefix("("), rest.hasSuffix(")") else { return false }
        let inner = rest.dropFirst()
        let looksLikePath = inner.hasPrefix("~") || inner.hasPrefix("/") || inner.hasPrefix("…")
        return looksLikePath && (candidates.contains(head) || !head.contains("/"))
    }

    // MARK: - Tool

    static let shells: Set<String> = ["zsh", "bash", "fish", "sh", "nu", "pwsh", ""]
    static let knownAgents: Set<String> = ["claude", "codex", "gemini"]

    /// The program a session runs: "claude" for `["zsh", "-i", "-c", "claude \"$@\"", "--"]` or
    /// `["/opt/homebrew/bin/gemini"]`, "zsh" for a plain shell. Port of the web's `sessionTool()`.
    static func tool(for info: ServerSessionInfo) -> String {
        if info.codexActive == true { return "codex" }
        if info.geminiActive == true { return "gemini" }
        func base(_ word: String) -> String {
            (word as NSString).lastPathComponent.lowercased()
        }
        let first = base(info.command.first ?? "")
        if self.shells.contains(first),
           let script = info.command.dropFirst().first(where: { !$0.hasPrefix("-") })
        {
            let word = script.trimmingCharacters(in: .whitespaces)
                .split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
            return base(word)
        }
        return first
    }

    // MARK: - State

    static func state(for info: ServerSessionInfo) -> SessionAgentState {
        // Suspended to free memory: resting, not ended (it wakes when opened).
        if info.isSuspended { return .idle }
        if info.status == "exited" { return .exited }
        guard let claude = info.claudeStatus?.status else { return .shell }
        switch claude {
        case "busy":
            // Busy only for background agents: the reply is over, the row rests like an idle one.
            return info.claudeStatus?.waitingForBackground == true ? .idle : .working
        case "waiting":
            return .needsYou
        default:
            return .idle
        }
    }

    static func subtitle(for info: ServerSessionInfo, state: SessionAgentState) -> (String?, String?) {
        let claude = info.claudeStatus
        let lastLine = info.lastLine?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        switch state {
        case .needsYou:
            let assistantPreview = claude?.preview.flatMap { preview -> String? in
                guard preview.role != "user" else { return nil }
                return preview.text?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            }
            return (
                self.waitingLabel(claude?.waitingFor)
                    ?? String(localized: "Waiting for you", comment: "Session status line: the agent waits for the user"),
                self.waitingDetail(claude?.choices) ?? assistantPreview)
        case .working:
            return (claude?.activity.map(self.formatActivity) ?? Self.workingEllipsis, nil)
        case .idle:
            if let suspension = info.suspended {
                return suspension.resumeError == nil
                    ? (String(localized: "session.state.paused", defaultValue: "Paused", comment: "Session status line: suspended to free memory, wakes when opened"), nil)
                    : (String(localized: "session.state.wakeFailed", defaultValue: "Couldn't resume", comment: "Session status line: a suspended session failed to wake"), suspension.resumeError)
            }
            if claude?.waitingForBackground == true {
                return (String(localized: "Background agents running", comment: "Session status line: subagents still run after the reply"), nil)
            }
            // The hollow ring and the "Idle" section say it; no status line of its own.
            return (nil, claude == nil ? lastLine : nil)
        case .shell:
            return (nil, lastLine)
        case .exited:
            return (SessionAgentState.exited.label, nil)
        }
    }

    /// What a waiting prompt is about, in one line: "Bash command: pnpm test", "Plan: fix the
    /// menu", else its question ("Do you want to proceed?").
    static func waitingDetail(_ choices: ClaudeChoices?) -> String? {
        guard let choices else { return nil }
        let detail = (choices.detail ?? [])
            .compactMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty }
        if let first = detail.first {
            if !first.contains(":"), first.count <= 32, detail.count > 1 {
                return "\(first): \(detail[1])"
            }
            return first
        }
        return choices.question?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    /// What Claude waits for, in words (web/src/shared/claude-waiting-reason.ts).
    static func waitingLabel(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let key = raw.lowercased()
            .replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        switch key {
        case "permission prompt":
            return String(localized: "Permission request", comment: "Session status line: what the agent waits for")
        case "plan approval", "approve plan":
            return String(localized: "Plan approval", comment: "Session status line: what the agent waits for")
        case "user input", "input needed", "idle prompt", "elicitation dialog", "elicitation url dialog":
            return String(localized: "Your input", comment: "Session status line: what the agent waits for")
        case "dialog open":
            return String(localized: "Dialog on screen", comment: "Session status line: what the agent waits for")
        case "goal proposal":
            return String(localized: "Goal proposal", comment: "Session status line: what the agent waits for")
        case "sandbox request":
            return String(localized: "Network access request", comment: "Session status line: what the agent waits for")
        case "worker request":
            return String(localized: "Subagent request", comment: "Session status line: what the agent waits for")
        default: return raw
        }
    }

    /// One short line: "Running: pnpm test", "Reading app.ts", "Thinking…"
    /// (web/src/client/utils/claude-activity.ts).
    static func formatActivity(_ activity: ClaudeActivity) -> String {
        switch activity.kind {
        case "thinking": return String(localized: "Thinking…", comment: "Session activity line in the menu")
        case "writing": return String(localized: "Writing…", comment: "Session activity line in the menu")
        default: break
        }
        let tool = activity.tool ?? ""
        let target = activity.target?.nonEmpty
        switch tool {
        case "Bash":
            if let target { return String(localized: "Running: \(target)", comment: "Session activity line in the menu (mirrors the web app's activity labels). Placeholder: file, command or query") }
            return String(localized: "Running a command", comment: "Session activity line in the menu")
        case "Edit", "MultiEdit", "Write", "NotebookEdit":
            if let target { return String(localized: "Editing \(target)", comment: "Session activity line in the menu (mirrors the web app's activity labels). Placeholder: file, command or query") }
            return String(localized: "Editing a file", comment: "Session activity line in the menu")
        case "Read":
            if let target { return String(localized: "Reading \(target)", comment: "Session activity line in the menu (mirrors the web app's activity labels). Placeholder: file, command or query") }
            return String(localized: "Reading a file", comment: "Session activity line in the menu")
        case "Grep", "Glob":
            if let target { return String(localized: "Searching \(target)", comment: "Session activity line in the menu (mirrors the web app's activity labels). Placeholder: file, command or query") }
            return String(localized: "Searching files", comment: "Session activity line in the menu")
        case "WebFetch", "WebSearch":
            if let target { return String(localized: "Browsing \(target)", comment: "Session activity line in the menu (mirrors the web app's activity labels). Placeholder: file, command or query") }
            return String(localized: "Browsing the web", comment: "Session activity line in the menu")
        case "Task", "Agent":
            if let target { return String(localized: "Agent: \(target)", comment: "Session activity line in the menu (mirrors the web app's activity labels). Placeholder: file, command or query") }
            return String(localized: "Running an agent", comment: "Session activity line in the menu")
        case "TodoWrite": return String(localized: "Updating todo list", comment: "Session activity line in the menu")
        case "": return Self.workingEllipsis
        default:
            // MCP tools are named mcp__server__tool: the last part reads best.
            let name = tool.hasPrefix("mcp__") ? (tool.components(separatedBy: "__").last ?? tool) : tool
            return String(localized: "Using \(name)", comment: "Session activity line in the menu. Placeholder: tool name")
        }
    }

    private static var workingEllipsis: String {
        String(localized: "Working…", comment: "Session activity line in the menu: the agent works, no detail known")
    }

    // MARK: - Dates and paths

    private static let fractionalISO = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plainISO = Date.ISO8601FormatStyle()

    static func parseDate(_ string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        return (try? self.fractionalISO.parse(string)) ?? (try? self.plainISO.parse(string))
    }

    private static let homeDirectory = NSHomeDirectory()

    static func abbreviate(_ path: String) -> String {
        if path == self.homeDirectory { return "~" }
        if path.hasPrefix(self.homeDirectory + "/") {
            return "~" + path.dropFirst(self.homeDirectory.count)
        }
        return path
    }

    /// "now", "4m", "2h", "3d": the compact age the rows show.
    static func shortAge(from date: Date?, now: Date) -> String {
        guard let date else { return "" }
        let elapsed = max(0, now.timeIntervalSince(date))
        switch elapsed {
        case ..<60:
            return String(localized: "age.now", defaultValue: "now", comment: "Session row: compact age, less than a minute")
        case ..<3600:
            let minutes = Int(elapsed / 60)
            return String(localized: "\(minutes)m", comment: "Session row: compact age in minutes (keep very short)")
        case ..<86400:
            let hours = Int(elapsed / 3600)
            return String(localized: "\(hours)h", comment: "Session row: compact age in hours (keep very short)")
        default:
            let days = Int(elapsed / 86400)
            return String(localized: "\(days)d", comment: "Session row: compact age in days (keep very short)")
        }
    }

    /// Tooltip of a row's time: what the moment it counts from means for that state.
    static func timeHelp(state: SessionAgentState, waitingForBackground: Bool, date: Date?) -> String {
        guard let date else { return "" }
        let absolute = date.formatted(date: .abbreviated, time: .shortened)
        return switch state {
        case .working:
            String(localized: "Working since \(absolute)", comment: "Session row: tooltip of the time. Placeholder: date and time")
        case .needsYou:
            String(localized: "Waiting since \(absolute)", comment: "Session row: tooltip of the time. Placeholder: date and time")
        // Status is still "busy": `since` is when the turn began, not when the reply ended.
        case .idle where waitingForBackground:
            String(localized: "Background agents since \(absolute)", comment: "Session row: tooltip of the time. Placeholder: date and time")
        case .idle:
            String(localized: "Last turn ended \(absolute)", comment: "Session row: tooltip of the time. Placeholder: date and time")
        default:
            String(localized: "Last activity \(absolute)", comment: "Session row: tooltip of the time. Placeholder: date and time")
        }
    }

    /// "4 minutes ago" for VoiceOver.
    static func spokenAge(from date: Date?, now: Date) -> String {
        guard let date else { return "" }
        if now.timeIntervalSince(date) < 60 {
            return String(localized: "just now", comment: "Relative time: less than a minute ago")
        }
        return date.formatted(.relative(presentation: .named, unitsStyle: .wide))
    }

    /// The row's time for VoiceOver: "for 4 minutes" while working, "2 hours ago" otherwise.
    static func spokenTime(for state: SessionAgentState, from date: Date?, now: Date) -> String {
        guard let date else { return "" }
        guard state == .working else { return self.spokenAge(from: date, now: now) }
        let elapsed = max(0, now.timeIntervalSince(date))
        if elapsed < 60 {
            return String(localized: "started just now", comment: "VoiceOver: a session started working less than a minute ago")
        }
        let durationText = Duration.seconds(elapsed)
            .formatted(.units(allowed: [.days, .hours, .minutes], width: .wide, maximumUnitCount: 1))
        return String(localized: "for \(durationText)", comment: "VoiceOver: how long a session has been working. Placeholder: a duration such as '4 minutes'")
    }
}

extension String {
    /// nil for an empty string.
    fileprivate var nonEmpty: String? {
        self.isEmpty ? nil : self
    }
}
