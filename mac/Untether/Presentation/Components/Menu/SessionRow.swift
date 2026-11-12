import AppKit
import OSLog
import SwiftUI

/// Row component displaying a single terminal session.
///
/// Line 1: the session's title (a shield when it survives restarts, a chip when it runs
/// something other than Claude) and its time: since the last turn ended, since it started
/// waiting, or how long the current turn has run.
/// Line 2: what the agent waits for (amber) or is doing, and the project when the list spans
/// several. Waiting rows add what the prompt is about; plain shells their last line of output.
/// Actions (open, rename, reveal, kill) appear on hover or keyboard selection as a trailing
/// cluster on the title line. The title reserves the cluster's measured width while it shows
/// (truncating earlier with "…") and the time fades out, so the buttons never sit over text and
/// the row height never changes; killing asks for a confirmation unless ⌥ is held.
struct SessionRow: View {
    let session: SessionDisplay
    let hasWindow: Bool
    /// Current time from the list's timeline, for the relative times.
    let now: Date
    let isSelected: Bool
    /// Name the project on line 2 (off when every session shares one).
    var showsProject = true

    @Environment(\.openWindow)
    private var openWindow
    @Environment(ServerManager.self)
    private var serverManager
    @Environment(SessionService.self)
    private var sessionService
    @Environment(GitRepositoryMonitor.self)
    private var gitRepositoryMonitor
    @Environment(MenuSessionCoordinator.self)
    private var coordinator

    @Environment(\.accessibilityReduceMotion)
    private var reduceMotion
    @Environment(\.colorScheme)
    private var colorScheme

    @State private var editedName = ""
    /// Width of the hover cluster as laid out (it is always laid out, at its widest state, so this
    /// is known before the first hover); the title line keeps this much room free while the
    /// cluster shows. The four-icon estimate only covers the very first layout pass.
    @State private var actionClusterWidth: CGFloat = SessionRow.estimatedClusterWidth
    @FocusState private var isEditFieldFocused: Bool

    private static let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "SessionRow")

    private var isHovered: Bool {
        self.coordinator.hoveredId == self.session.id
    }

    private var isRenaming: Bool {
        self.coordinator.renamingId == self.session.id
    }

    private var isConfirmingKill: Bool {
        self.coordinator.pendingKillId == self.session.id
    }

    private var isTerminating: Bool {
        self.coordinator.isTerminating(self.session.id)
    }

    private var showsActions: Bool {
        !self.isRenaming && (self.isHovered || self.isSelected || self.isConfirmingKill || self.isTerminating)
    }

    var body: some View {
        Group {
            if self.isRenaming {
                self.content
            } else {
                Button(action: self.open) {
                    self.content
                }
                .buttonStyle(.plain)
            }
        }
        .background { self.rowBackground }
        // Pinned to the title line's centre (not the row's), so on two- and three-line rows the
        // cluster stays clear of the status line and the project tag.
        .overlay(alignment: Alignment(horizontal: .trailing, vertical: .sessionTitleLine)) {
            // Always laid out, only shown on hover: its width is measured before the first hover,
            // so the title's reservation is right from the first frame. It fades in but hides
            // instantly, because the title re-expands to full width at once (truncation doesn't
            // animate) and a fading cluster would sit over it for the length of the fade.
            self.actionCluster
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                    self.actionClusterWidth = width
                }
                .alignmentGuide(.sessionTitleLine) { $0[VerticalAlignment.center] }
                .padding(.trailing, Self.clusterTrailingInset)
                .opacity(self.showsActions ? 1 : 0)
                .animation(
                    self.showsActions ? MenuStyles.animation(reduceMotion: self.reduceMotion) : nil,
                    value: self.showsActions)
                .allowsHitTesting(self.showsActions)
                .disabled(!self.showsActions)
                .accessibilityHidden(!self.showsActions)
        }
        .menuItemFocus(isFocused: self.isSelected)
        .animation(MenuStyles.animation(reduceMotion: self.reduceMotion), value: self.showsActions)
        .onHover { hovering in
            if hovering {
                self.coordinator.hoveredId = self.session.id
            } else if self.coordinator.hoveredId == self.session.id {
                self.coordinator.hoveredId = nil
                if self.isConfirmingKill, !self.isSelected { self.coordinator.cancelKill() }
            }
        }
        .help(self.tooltipText)
        .contextMenu { self.contextMenuItems }
        .accessibilityElement(children: self.isRenaming ? .contain : .ignore)
        .accessibilityLabel(self.accessibilityLabel)
        .accessibilityValue(self.accessibilityValue)
        .accessibilityAddTraits(self.isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { self.open() }
        .accessibilityAction(
            named: self.hasWindow
                ? Text("Focus terminal window", comment: "Session row: action that brings its terminal window to the front")
                : Text("Open in browser", comment: "Session row: action that opens the session in the web dashboard"))
        { self.open() }
        .accessibilityAction(named: Text("Rename", comment: "VoiceOver action: rename a session")) {
            self.coordinator.startRename(self.session.id)
        }
        .accessibilityAction(named: Text("Reveal in Finder", comment: "Session row: show the session's folder in Finder")) {
            self.coordinator.revealInFinder(self.session)
        }
        .accessibilityAction(
            named: self.isConfirmingKill
                ? Text("Confirm kill", comment: "VoiceOver action: second step that ends the session")
                : Text("Kill session", comment: "Session row: action that ends the session (asks first)"))
        {
            // Two steps like the mouse and keyboard: the first action only asks.
            if self.isConfirmingKill {
                self.coordinator.kill(self.session.id, using: self.sessionService)
            } else {
                self.coordinator.requestKill(self.session.id)
                let title = self.session.title
                AccessibilityNotification.Announcement(String(
                    localized: "Kill \(title)? Use the Confirm kill action, or Cancel kill to keep it.",
                    comment: "VoiceOver announcement after asking to kill a session. Placeholder: session title. Action names must match 'Confirm kill' and 'Cancel kill'"))
                    .post()
            }
        }
        .accessibilityActions {
            if self.isConfirmingKill {
                Button(String(localized: "Cancel kill", comment: "VoiceOver action: keep the session instead of ending it")) {
                    self.coordinator.cancelKill()
                }
            }
        }
    }

    // MARK: - Content

    private var isNeedsYou: Bool {
        self.session.state == .needsYou
    }

    @ViewBuilder private var rowBackground: some View {
        let shape = RoundedRectangle(cornerRadius: MenuStyles.cornerRadius, style: .continuous)
        ZStack {
            if self.isNeedsYou {
                let isDark = self.colorScheme == .dark
                shape.fill(MenuStyles.needsYouFill.opacity(isDark ? 0.09 : 0.14))
                shape.strokeBorder(MenuStyles.needsYouFill.opacity(isDark ? 0.28 : 0.35), lineWidth: 0.75)
            }
            if self.isHovered || self.isSelected {
                shape.fill(MenuStyles.rowHighlight)
            }
        }
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            SessionStateDot(state: self.session.state)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }

            VStack(alignment: .leading, spacing: 2) {
                self.titleLine
                self.statusLine
                self.detailLine
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(RoundedRectangle(cornerRadius: MenuStyles.cornerRadius, style: .continuous))
    }

    /// Gap between the cluster and the row's trailing edge.
    private static let clusterTrailingInset: CGFloat = 6
    /// Four 22 pt icons, 2 pt apart, plus the cluster's 2 pt padding: 4 × 22 + 3 × 2 + 2 × 2.
    /// Written as the result: the Release (x86_64) build gave up type-checking the CGFloat
    /// arithmetic in reasonable time and failed the nightly build (2026-10-13…16).
    private static let estimatedClusterWidth: CGFloat = 98
    /// Room the title line keeps free at its trailing end while the cluster shows: the cluster
    /// and its inset, minus the content's own 10 pt padding, plus a 6 pt gap before the "…".
    private var actionReservation: CGFloat {
        max(0, self.actionClusterWidth + Self.clusterTrailingInset - 10 + 6)
    }

    private var titleLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            if self.isRenaming {
                self.renameField
            } else {
                Text(self.session.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(self.session.state == .exited ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                if self.session.isShielded {
                    Image(systemName: "lock.shield")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .help(Text("Shielded: keeps running when the server restarts", comment: "Session row: tooltip of the shield icon"))
                        .accessibilityHidden(true)
                }
                if let chip = self.toolChipText {
                    // Above the title's priority: the chip keeps its (capped) width and the title
                    // truncates first.
                    ToolChip(tool: chip)
                        .layoutPriority(2)
                }
                Spacer(minLength: 6)
                // The time and the cluster's reservation share the trailing slot: the slot is as
                // wide as whichever is wider, so the title truncates before the buttons instead of
                // running under them, and the time fades out in place.
                ZStack(alignment: .trailing) {
                    Color.clear
                        .frame(width: self.showsActions ? self.actionReservation : 0, height: 1)
                    Text(SessionDisplay.shortAge(from: self.session.lastActivity, now: self.now))
                        .font(.caption)
                        .monospacedDigit()
                        // Secondary in every state: the pulsing dot carries "working" (small
                        // orange text fails contrast in light mode and competes with the amber).
                        .foregroundStyle(.secondary)
                        .fixedSize()
                        .help(self.timeHelp)
                        .opacity(self.showsActions ? 0 : 1)
                }
                .fixedSize()
            }
        }
        .alignmentGuide(.sessionTitleLine) { $0[VerticalAlignment.center] }
    }

    /// The program's name when it isn't Claude (the usual case says nothing).
    private var toolChipText: String? {
        if let agent = self.session.agent { return agent == "claude" ? nil : agent }
        let tool = self.session.tool
        return tool.isEmpty ? nil : tool
    }

    /// The project on line 2, unless the list has one project or the title already names it.
    private var showsProjectTag: Bool {
        self.showsProject && !self.isRenaming && self.session.title != self.session.projectLabel
    }

    @ViewBuilder private var statusLine: some View {
        let status = self.session.statusText
        if let status {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(status)
                    .font(.subheadline.weight(self.isNeedsYou ? .semibold : .regular))
                    .foregroundStyle(self.statusStyle)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                Spacer(minLength: 6)
                if self.showsProjectTag {
                    ProjectTag(label: self.session.projectLabel, branch: self.session.branch)
                }
            }
        } else if self.showsProjectTag {
            ProjectTag(label: self.session.projectLabel, branch: self.session.branch)
        }
    }

    private var statusStyle: AnyShapeStyle {
        switch self.session.state {
        case .needsYou: AnyShapeStyle(MenuStyles.needsYou)
        case .working: AnyShapeStyle(.primary)
        default: AnyShapeStyle(.secondary)
        }
    }

    @ViewBuilder private var detailLine: some View {
        if let detail = self.session.detailText, !self.isRenaming {
            if self.session.state == .needsYou {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(detail)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
    }

    private var timeHelp: String {
        SessionDisplay.timeHelp(
            state: self.session.state,
            waitingForBackground: self.session.info.claudeStatus?.waitingForBackground == true,
            date: self.session.lastActivity)
    }

    private var renameField: some View {
        TextField(
            String(localized: "Session title", comment: "Session row: label of the rename field"),
            text: self.$editedName,
            prompt: Text(verbatim: self.session.title))
            .textFieldStyle(.roundedBorder)
            .font(.body)
            .focused(self.$isEditFieldFocused)
            .onSubmit {
                // Unchanged text must not pin the automatic title as a user title.
                if MenuSessionCoordinator.isRenameNoOp(self.editedName, userTitle: self.session.info.userTitle) {
                    self.coordinator.endRename()
                } else {
                    self.coordinator.rename(self.session.id, to: self.editedName, using: self.sessionService)
                }
            }
            .onKeyPress(.escape) {
                self.coordinator.endRename()
                return .handled
            }
            .onAppear {
                // Only a title the user set; the automatic one shows as the placeholder.
                self.editedName = self.session.info.userTitle ?? ""
                self.isEditFieldFocused = true
            }
            .help(Text(
                "Return to save, Esc to cancel. Leave empty to go back to the automatic title.",
                comment: "Session row: tooltip of the rename field"))
    }

    // MARK: - Actions

    /// Every state of the cluster is laid out and only the current one shows, so the cluster is
    /// always as wide as its widest state (the Cancel/Kill pair): switching state never leaves the
    /// title's reservation a frame behind.
    private var actionCluster: some View {
        ZStack(alignment: .trailing) {
            self.iconActions
                .clusterVariant(visible: !self.isConfirmingKill && !self.isTerminating)
            self.killConfirmation
                .clusterVariant(visible: self.isConfirmingKill && !self.isTerminating)
            ProgressView()
                .controlSize(.small)
                .padding(.horizontal, 6)
                .accessibilityLabel(Text("Killing session", comment: "VoiceOver: spinner while a session is being ended"))
                .clusterVariant(visible: self.isTerminating)
        }
        // No capsule of its own: the title stops before the cluster, so the icons sit straight
        // on the row's hover fill.
        .padding(2)
    }

    private var killConfirmation: some View {
        HStack(spacing: 2) {
                Button(String(localized: "Cancel", comment: "Session row: keep the session instead of ending it")) {
                    self.coordinator.cancelKill()
                }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .help(Text("Keep the session (Esc)", comment: "Session row: tooltip of Cancel in the kill confirmation"))
                Button(role: .destructive) {
                    self.coordinator.kill(self.session.id, using: self.sessionService)
                } label: {
                    Text("Kill", comment: "Session row: button that ends the session after confirming")
                        .fontWeight(.semibold)
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .controlSize(.small)
                .help(Text("Kill this session (⌫ or Return)", comment: "Session row: tooltip of the Kill button, with shortcuts"))
        }
    }

    private var iconActions: some View {
        HStack(spacing: 2) {
                RowActionButton(
                    systemImage: self.hasWindow ? "macwindow" : "safari",
                    help: self.hasWindow ? "Focus terminal window" : "Open in browser",
                    action: self.open)
                RowActionButton(systemImage: "pencil", help: "Rename (⌘R)") {
                    self.coordinator.startRename(self.session.id)
                }
                RowActionButton(systemImage: "folder", help: "Reveal in Finder") {
                    self.coordinator.revealInFinder(self.session)
                }
                RowActionButton(
                    systemImage: "xmark.circle",
                    help: "Kill session (⌫). ⌥-click kills without asking.",
                    isDestructive: true)
                {
                    if NSEvent.modifierFlags.contains(.option) {
                        self.coordinator.kill(self.session.id, using: self.sessionService)
                    } else {
                        self.coordinator.requestKill(self.session.id)
                    }
                }
        }
    }

    private func open() {
        guard !self.isRenaming else { return }
        self.coordinator.open(self.session, hasWindow: self.hasWindow, port: self.serverManager.port)
    }

    @ViewBuilder private var contextMenuItems: some View {
        if self.hasWindow {
            Button("Focus Terminal Window") {
                WindowTracker.shared.focusWindow(for: self.session.id)
            }
        }
        Button("Open in Browser") {
            if let url = DashboardURLBuilder.dashboardURL(port: serverManager.port, sessionId: session.id) {
                NSWorkspace.shared.open(url)
            }
        }

        Button("View Session Details") {
            self.openWindow(id: "session-detail", value: self.session.id)
        }

        Divider()

        Button("Rename Session…") {
            self.coordinator.startRename(self.session.id)
        }
        if self.session.info.userTitle != nil {
            Button("Use Automatic Title") {
                self.coordinator.rename(self.session.id, to: "", using: self.sessionService)
            }
        }
        if self.session.agent != nil {
            Button("Ask Agent to Set the Title") {
                self.sendTitlePrompt()
            }
        }

        Divider()

        Button("Show in Finder") {
            self.coordinator.revealInFinder(self.session)
        }

        if let repo = self.gitRepositoryMonitor
            .getCachedRepository(for: self.session.info.gitRepoPath ?? self.session.info.workingDir)
        {
            Button(String(
                localized: "Open in \(GitAppHelper.getPreferredGitAppName())",
                comment: "Context menu: open the repository in the user's Git app. Placeholder: app name"))
            {
                GitAppLauncher.shared.openRepository(at: repo.path)
            }
            if let url = repo.githubURL {
                Button("Open on GitHub") {
                    NSWorkspace.shared.open(url)
                }
            }
        }

        if let branch = self.session.info.gitBranch {
            Button("Copy Branch Name") {
                Self.copy(branch)
            }
        }
        Button("Copy Path") {
            Self.copy(self.session.info.workingDir)
        }
        Button("Copy Session ID") {
            Self.copy(self.session.id)
        }

        Divider()

        // Asks first, like the ✕ button and ⌫; the row shows the inline Cancel/Kill.
        Button("Kill Session…", role: .destructive) {
            self.coordinator.requestKill(self.session.id)
        }
    }

    private static func copy(_ string: String) {
        appPasteboard.clearContents()
        appPasteboard.setString(string, forType: .string)
    }

    private func sendTitlePrompt() {
        Task {
            do {
                // Sent to the agent, not shown to the user: stays in English.
                let prompt = "use ut title to update the terminal title with what you're currently working on"
                try await self.sessionService.sendInput(to: self.session.id, text: prompt)
                try await self.sessionService.sendKey(to: self.session.id, key: "enter")
            } catch {
                Self.logger.error("Failed to send prompt to AI assistant: \(error)")
            }
        }
    }

    // MARK: - Text

    private var accessibilityLabel: String {
        [
            self.session.title,
            self.session.state.label,
            self.toolChipText,
            self.session.isShielded ? String(localized: "shielded", comment: "VoiceOver: part of a session row's label") : nil,
            self.showsProject ? self.spokenProject : nil,
            SessionDisplay.spokenTime(for: self.session.state, from: self.session.lastActivity, now: self.now),
        ]
        .compactMap(\.self)
        .filter { !$0.isEmpty }
        .joined(separator: ", ")
    }

    private var accessibilityValue: String {
        [self.session.statusText, self.session.detailText]
            .compactMap(\.self)
            .filter { $0 != self.session.state.label }
            .joined(separator: ", ")
    }

    private var spokenProject: String {
        if self.session.projectLabel == "~" {
            return String(localized: "in home folder", comment: "VoiceOver: part of a session row's label, the session runs in the home folder")
        }
        let project = self.session.projectLabel
        return String(localized: "in \(project)", comment: "VoiceOver: part of a session row's label. Placeholder: project folder name")
    }

    private var tooltipText: String {
        let info = self.session.info
        var lines = [self.session.title]
        let command = info.command.joined(separator: " ")
        lines.append(String(localized: "Command: \(command)", comment: "Session row tooltip line. Placeholder: the command line"))
        let path = self.session.abbreviatedPath
        lines.append(String(localized: "Path: \(path)", comment: "Session row tooltip line. Placeholder: folder path"))
        if let branch = info.gitBranch {
            lines.append(info.gitIsWorktree == true
                ? String(localized: "Branch: \(branch) (worktree)", comment: "Session row tooltip line. Placeholder: Git branch name")
                : String(localized: "Branch: \(branch)", comment: "Session row tooltip line. Placeholder: Git branch name"))
        }
        let state = self.session.state.label
        lines.append(String(localized: "State: \(state)", comment: "Session row tooltip line. Placeholder: state such as Working"))
        if let detail = self.session.detailText { lines.append(detail) }
        if self.session.isShielded {
            lines.append(String(localized: "Shielded: survives server restarts", comment: "Session row tooltip line"))
        }
        if let started = self.session.startedAt {
            let date = started.formatted(date: .abbreviated, time: .shortened)
            lines.append(String(localized: "Started: \(date)", comment: "Session row tooltip line. Placeholder: date and time"))
        }
        lines.append(self.hasWindow
            ? String(localized: "Click to focus its terminal window", comment: "Session row tooltip: last line")
            : String(localized: "Click to open in the browser", comment: "Session row tooltip: last line"))
        return lines.joined(separator: "\n")
    }
}

extension VerticalAlignment {
    /// Centre of a session row's title line, where the hover cluster sits.
    private enum SessionTitleLine: AlignmentID {
        static func defaultValue(in context: ViewDimensions) -> CGFloat {
            context[VerticalAlignment.center]
        }
    }

    static let sessionTitleLine = VerticalAlignment(SessionTitleLine.self)
}

/// A small icon button of a row's hover cluster.
private struct RowActionButton: View {
    let systemImage: String
    let help: LocalizedStringKey
    var isDestructive = false
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: self.action) {
            Image(systemName: self.systemImage)
                .font(.callout)
                .foregroundStyle(self.isDestructive && self.isHovering ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                .frame(width: 22, height: 20)
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(Color.primary.opacity(self.isHovering ? 0.1 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { self.isHovering = $0 }
        .help(self.help)
        .accessibilityLabel(self.help)
    }
}

private extension View {
    /// One state of the hover cluster: always laid out (so the cluster keeps its widest size),
    /// but invisible, inert and hidden from VoiceOver unless it's the current state.
    func clusterVariant(visible: Bool) -> some View {
        self
            .opacity(visible ? 1 : 0)
            .allowsHitTesting(visible)
            .disabled(!visible)
            .accessibilityHidden(!visible)
    }
}
