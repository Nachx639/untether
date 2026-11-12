import SwiftUI

// MARK: - Model

/// The menu's sections, in display order: what needs the user first, then what works, then
/// what rests, and the sessions the server suspended apart, last.
enum SessionSectionKind: String, CaseIterable, Sendable {
    case needsYou
    case working
    case idle
    case terminals
    /// Suspended to free memory (2026-10-31): its own section, not mixed with the live ones.
    case suspended

    init(session: SessionDisplay) {
        self = session.isSuspended ? .suspended : Self(state: session.state)
    }

    init(state: SessionAgentState) {
        switch state {
        case .needsYou: self = .needsYou
        case .working: self = .working
        case .idle: self = .idle
        case .shell, .exited: self = .terminals
        }
    }

    var title: String {
        switch self {
        case .needsYou:
            String(localized: "menu.section.needsYou", defaultValue: "Needs You", comment: "Menu bar: section header, sessions waiting on the user")
        case .working:
            String(localized: "menu.section.working", defaultValue: "Working", comment: "Menu bar: section header, sessions whose agent is working")
        case .idle:
            String(localized: "menu.section.idle", defaultValue: "Idle", comment: "Menu bar: section header, idle sessions")
        case .terminals:
            String(localized: "menu.section.other", defaultValue: "Other", comment: "Menu bar: section header, plain terminals and ended sessions")
        case .suspended:
            String(localized: "menu.section.suspended", defaultValue: "Suspended", comment: "Menu bar: section header, sessions paused to free memory (they resume when opened)")
        }
    }
}

/// Sessions of one state, as the menu lists them.
struct SessionSection: Identifiable, Equatable {
    let kind: SessionSectionKind
    let sessions: [SessionDisplay]

    var id: String {
        self.kind.rawValue
    }

    /// Filter, bucket by state and sort: sections in `SessionSectionKind` order, and inside a
    /// section the most recent first (newest wait, newest turn, last finished), then by title.
    /// Suspended ones go by project, then the latest paused first.
    static func make(from displays: [SessionDisplay], filter: String) -> [SessionSection] {
        let query = filter.trimmingCharacters(in: .whitespaces)
        let matching = query.isEmpty ? displays : displays.filter { $0.matches(query) }
        let buckets = Dictionary(grouping: matching) { SessionSectionKind(session: $0) }
        return SessionSectionKind.allCases.compactMap { kind in
            guard let sessions = buckets[kind], !sessions.isEmpty else { return nil }
            let sorted = sessions.sorted { lhs, rhs in
                if kind == .suspended, lhs.projectKey != rhs.projectKey {
                    return lhs.projectLabel.localizedStandardCompare(rhs.projectLabel) == .orderedAscending
                }
                let left = lhs.lastActivity ?? .distantPast
                let right = rhs.lastActivity ?? .distantPast
                if left != right { return left > right }
                return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
            }
            return SessionSection(kind: kind, sessions: sorted)
        }
    }

    /// Rows name their project only when the list spans more than one.
    static func showsProjects(in sections: [SessionSection]) -> Bool {
        Set(sections.lazy.flatMap(\.sessions).map(\.projectKey)).count > 1
    }
}

extension SessionDisplay {
    /// Type-to-filter: title, project, tool, branch, path or what it is doing contain the query.
    func matches(_ query: String) -> Bool {
        [
            self.title,
            self.projectLabel,
            self.tool,
            self.branch ?? "",
            self.abbreviatedPath,
            self.statusText ?? "",
        ]
        .contains { $0.localizedCaseInsensitiveContains(query) }
    }
}

// MARK: - View

/// Session list in state sections ("Needs You", "Working", "Idle", "Other"), each
/// collapsible. Headers are hidden when there is only one section.
///
/// One timeline drives the relative times of every row (twice a minute), so rows don't each
/// run a timer.
struct SessionListSection: View {
    let sections: [SessionSection]
    let windowSessionIds: Set<String>
    let selection: MenuFocusField?

    @Environment(MenuSessionCoordinator.self)
    private var coordinator
    @Environment(\.accessibilityReduceMotion)
    private var reduceMotion

    var body: some View {
        let showsHeaders = self.sections.count > 1
        let showsProjects = SessionSection.showsProjects(in: self.sections)
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 2) {
                ForEach(self.sections) { section in
                    // "Needs You" never folds: a new prompt must not hide in a closed section.
                    let collapsible = section.kind != .needsYou
                    let collapsed = showsHeaders && collapsible && self.coordinator.isCollapsed(section.id)
                    if showsHeaders {
                        SessionSectionHeader(section: section, isCollapsed: collapsed, isCollapsible: collapsible) {
                            withAnimation(MenuStyles.animation(reduceMotion: self.reduceMotion)) {
                                self.coordinator.toggleCollapsed(section.id)
                            }
                        }
                        .padding(.top, section.id == self.sections.first?.id ? 0 : 6)
                    }
                    if !collapsed {
                        ForEach(section.sessions) { session in
                            SessionRow(
                                session: session,
                                hasWindow: self.windowSessionIds.contains(session.id),
                                now: context.date,
                                isSelected: self.selection == .sessionRow(session.id),
                                showsProject: showsProjects)
                                .id(MenuFocusField.sessionRow(session.id))
                                .transition(.opacity)
                        }
                    }
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 6)
        }
    }
}

/// "NEEDS YOU  2" style header of a section; click folds it.
struct SessionSectionHeader: View {
    let section: SessionSection
    let isCollapsed: Bool
    let isCollapsible: Bool
    let onToggle: () -> Void

    @State private var isHovered = false
    @Environment(\.layoutDirection)
    private var layoutDirection

    private var tint: AnyShapeStyle {
        self.section.kind == .needsYou ? AnyShapeStyle(MenuStyles.needsYou) : AnyShapeStyle(.secondary)
    }

    var body: some View {
        Button {
            if self.isCollapsible { self.onToggle() }
        } label: {
            HStack(spacing: 6) {
                Text(self.section.kind.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(self.tint)
                Text(verbatim: "\(self.section.sessions.count)")
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(self.tint)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 0.5)
                    .background(Capsule().fill(MenuStyles.chipFill))
                Spacer(minLength: 4)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    // Collapsed points to the trailing side: right, or left in right-to-left.
                    .rotationEffect(.degrees(self.isCollapsed ? (self.layoutDirection == .rightToLeft ? 90 : -90) : 0))
                    .opacity(self.isCollapsible && (self.isHovered || self.isCollapsed) ? 1 : 0)
            }
            .padding(.horizontal, 10)
            .padding(.top, 4)
            .padding(.bottom, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { self.isHovered = $0 }
        .help(self.helpText)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(self.accessibilityLabel)
        .accessibilityAddTraits(self.isCollapsible ? [.isHeader, .isButton] : .isHeader)
        .accessibilityHint(self.hintText)
    }

    private var helpText: Text {
        guard self.isCollapsible else { return Text(verbatim: "") }
        return self.isCollapsed
            ? Text("Show these sessions", comment: "Menu bar: tooltip of a collapsed section header")
            : Text("Hide these sessions", comment: "Menu bar: tooltip of an expanded section header")
    }

    private var hintText: Text {
        guard self.isCollapsible else { return Text(verbatim: "") }
        return self.isCollapsed
            ? Text("Shows the sessions", comment: "VoiceOver hint: collapsed section header")
            : Text("Hides the sessions", comment: "VoiceOver hint: expanded section header")
    }

    private var accessibilityLabel: String {
        let count = self.section.sessions.count
        let title = self.section.kind.title
        return self.isCollapsed
            ? String(
                localized: "\(title), \(count) sessions, collapsed",
                comment: "VoiceOver: collapsed section header. First: section name, second: number of sessions (plural)")
            : String(
                localized: "\(title), \(count) sessions",
                comment: "VoiceOver: section header. First: section name, second: number of sessions (plural)")
    }
}
