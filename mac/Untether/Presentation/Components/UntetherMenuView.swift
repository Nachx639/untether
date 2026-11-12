import AppKit
import SwiftUI

/// Main menu view displayed when left-clicking the status bar item.
/// Shows server status, sessions in state sections (needs you, working, idle, terminals), and
/// quick actions.
///
/// Keyboard: ↑/↓ select, Return opens, ⌫ kills the selected session (asks first; ⌫ or Return
/// again confirms, Esc cancels), ⌘R renames, ⌘N new session, ⌘, settings, ⌘Q quit, and typing
/// filters the list.
struct UntetherMenuView: View {
    @Environment(SessionMonitor.self)
    var sessionMonitor
    @Environment(ServerManager.self)
    var serverManager
    @Environment(SessionService.self)
    var sessionService
    @Environment(GitRepositoryMonitor.self)
    var gitRepositoryMonitor

    @State private var coordinator = MenuSessionCoordinator()
    @State private var showingNewSession = false
    @State private var filterText = ""
    @FocusState private var keyFocus: MenuKeyFocus?
    @Environment(\.accessibilityReduceMotion)
    private var reduceMotion

    /// Tells the menu window that the new session form holds typed text (it then stays open)
    @Binding var newSessionHasTypedText: Bool

    /// Show the filter field permanently from this many sessions on (it also appears when typing).
    private static let filterFieldThreshold = 6

    private enum MenuKeyFocus: Hashable {
        case root
        case filter
    }

    init(newSessionHasTypedText: Binding<Bool> = .constant(false)) {
        self._newSessionHasTypedText = newSessionHasTypedText
    }

    var body: some View {
        if self.showingNewSession {
            NewSessionForm(
                isPresented: Binding(
                    get: { self.showingNewSession },
                    set: { newValue in
                        self.showingNewSession = newValue
                        if !newValue { self.newSessionHasTypedText = false }
                    }),
                hasTypedText: self.$newSessionHasTypedText)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        } else {
            self.mainContent
                .transition(.opacity)
        }
    }

    // MARK: - Layout

    private var mainContent: some View {
        let sections = self.sections
        return VStack(spacing: 0) {
            VStack(spacing: 10) {
                ServerInfoHeader()
                if self.showsFilterField {
                    self.filterField
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, MenuStyles.padding)
            .padding(.top, 12)
            .padding(.bottom, 10)

            Divider()

            if self.sessionMonitor.isServerUnreachable, self.serverManager.isRunning {
                self.unreachableBanner
            }

            if sections.isEmpty {
                EmptySessionsView(
                    filter: self.filterText,
                    isLoading: !self.sessionMonitor.hasLoaded && self.sessionMonitor.displays.isEmpty)
                {
                    self.showNewSession()
                }
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        SessionListSection(
                            sections: sections,
                            windowSessionIds: self.sessionMonitor.windowSessionIds,
                            selection: self.coordinator.selection)
                    }
                    .scrollIndicators(.automatic)
                    .frame(maxHeight: MenuStyles.listMaxHeight)
                    .onChange(of: self.coordinator.selection) { _, selection in
                        if let selection, case .sessionRow = selection {
                            withAnimation(MenuStyles.animation(reduceMotion: self.reduceMotion)) {
                                proxy.scrollTo(selection)
                            }
                        }
                    }
                }
            }

            Divider()

            MenuActionBar(showingNewSession: self.$showingNewSession, selection: self.coordinator.selection)
        }
        .frame(width: MenuStyles.menuWidth)
        .environment(self.coordinator)
        .focusable()
        .focused(self.$keyFocus, equals: .root)
        .focusEffectDisabled()
        .onKeyPress { keyPress in
            self.handleKeyPress(keyPress)
        }
        .onAppear {
            self.keyFocus = .root
        }
        .task {
            await self.sessionMonitor.refresh()
        }
        .onChange(of: self.coordinator.renamingId) { _, renamingId in
            if renamingId == nil { self.keyFocus = .root }
        }
        .onChange(of: self.filterText) { _, _ in
            self.coordinator.cancelKill()
            if case let .sessionRow(id) = coordinator.selection, !self.visibleSessionIds.contains(id) {
                self.coordinator.selection = self.visibleSessionIds.first.map { .sessionRow($0) }
            }
        }
    }

    private var showsFilterField: Bool {
        !self.filterText.isEmpty || self.keyFocus == .filter
            || self.sessionMonitor.displays.count >= Self.filterFieldThreshold
    }

    private var filterField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField(String(localized: "Filter sessions", comment: "Menu bar: placeholder of the session filter field"), text: self.$filterText)
                .accessibilityLabel(Text("Filter sessions", comment: "Menu bar: placeholder of the session filter field"))
                .textFieldStyle(.plain)
                .focused(self.$keyFocus, equals: .filter)
                .onSubmit {
                    self.activateSelectionOrFirst()
                }
                .onKeyPress(.upArrow) {
                    self.moveSelection(up: true)
                }
                .onKeyPress(.downArrow) {
                    self.moveSelection(up: false)
                }
                .onKeyPress(.escape) {
                    self.filterText = ""
                    self.keyFocus = .root
                    return .handled
                }
            if !self.filterText.isEmpty {
                Button {
                    self.filterText = ""
                    self.keyFocus = .root
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(Text("Clear filter (Esc)", comment: "Menu bar: tooltip of the button that clears the filter"))
                .accessibilityLabel(Text("Clear filter", comment: "VoiceOver: button that clears the session filter"))
            }
        }
        .font(.callout)
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: MenuStyles.smallCornerRadius, style: .continuous)
                .fill(MenuStyles.chipFill))
        .overlay(
            RoundedRectangle(cornerRadius: MenuStyles.smallCornerRadius, style: .continuous)
                .strokeBorder(
                    self.keyFocus == .filter ? Color.accentColor.opacity(0.7) : MenuStyles.hairline.opacity(0.6),
                    lineWidth: self.keyFocus == .filter ? 1.5 : 0.5))
    }

    private var unreachableBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(MenuStyles.needsYou)
            Group {
                if self.sessionMonitor.displays.isEmpty {
                    Text("Can't reach server", comment: "Menu bar banner: the local server doesn't answer")
                } else {
                    Text(
                        "Can't reach server · showing last known",
                        comment: "Menu bar banner: the local server doesn't answer, the list shows the last sessions seen")
                }
            }
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 4)
            Button(String(localized: "Retry", comment: "Button: try again")) {
                Task { await self.sessionMonitor.refresh() }
            }
            .buttonStyle(.link)
        }
        .font(.subheadline)
        .padding(.horizontal, MenuStyles.padding)
        .padding(.vertical, 6)
        .background(MenuStyles.needsYou.opacity(0.1))
        .accessibilityElement(children: .combine)
    }

    // MARK: - Data

    private var sections: [SessionSection] {
        SessionSection.make(from: self.sessionMonitor.displays, filter: self.filterText)
    }

    /// Session ids in display order, skipping collapsed sections ("Needs You" never folds, and
    /// nothing folds while there is only one section, matching SessionListSection).
    private var visibleSessionIds: [String] {
        let sections = self.sections
        return sections
            .filter { sections.count == 1 || $0.kind == .needsYou || !self.coordinator.isCollapsed($0.id) }
            .flatMap { $0.sessions.map(\.id) }
    }

    private func display(for id: String) -> SessionDisplay? {
        self.sessionMonitor.displays.first { $0.id == id }
    }

    private var selectedSessionId: String? {
        if case let .sessionRow(id) = coordinator.selection { return id }
        return nil
    }

    // MARK: - Keyboard

    private func handleKeyPress(_ keyPress: KeyPress) -> KeyPress.Result {
        // The rename field handles its own keys.
        guard self.coordinator.renamingId == nil else { return .ignored }

        if keyPress.modifiers.contains(.command) {
            switch keyPress.key.character {
            case "n":
                self.showNewSession()
            case ",":
                SettingsOpener.openSettings()
                self.closeMenu()
            case "q":
                NSApplication.shared.terminate(nil)
            case "r":
                guard let id = self.selectedSessionId ?? self.coordinator.hoveredId else { return .ignored }
                self.coordinator.startRename(id)
            case "f":
                self.keyFocus = .filter
            default:
                return .ignored
            }
            return .handled
        }

        switch keyPress.key {
        case .upArrow:
            return self.moveSelection(up: true)
        case .downArrow:
            return self.moveSelection(up: false)
        case .return:
            // A held key repeats; only distinct presses activate or confirm.
            guard keyPress.phase == .down else { return .handled }
            if let id = self.selectedSessionId, self.coordinator.pendingKillId == id {
                self.coordinator.kill(id, using: self.sessionService)
                return .handled
            }
            return self.activateSelection()
        case .delete, .deleteForward:
            guard self.keyFocus != .filter, let id = self.selectedSessionId else { return .ignored }
            switch MenuSessionCoordinator.killKeyDecision(
                sessionId: id,
                pendingKillId: self.coordinator.pendingKillId,
                isRepeat: keyPress.phase != .down)
            {
            case .confirm: self.coordinator.kill(id, using: self.sessionService)
            case .request: self.coordinator.requestKill(id)
            case .ignore: break
            }
            return .handled
        case .escape:
            if self.coordinator.pendingKillId != nil {
                self.coordinator.cancelKill()
                return .handled
            }
            if !self.filterText.isEmpty {
                self.filterText = ""
                self.keyFocus = .root
                return .handled
            }
            return .ignored
        default:
            break
        }

        // Type to filter: printable characters without ⌃/⌥ start the filter.
        guard self.keyFocus != .filter,
              keyPress.modifiers.isDisjoint(with: [.control, .option]),
              !keyPress.characters.isEmpty,
              keyPress.characters.unicodeScalars.allSatisfy({
                  CharacterSet.alphanumerics.union(.punctuationCharacters).union(.symbols).contains($0)
              })
        else { return .ignored }
        self.filterText += keyPress.characters
        self.keyFocus = .filter
        return .handled
    }

    private func moveSelection(up: Bool) -> KeyPress.Result {
        let fields: [MenuFocusField] = self.visibleSessionIds.map { .sessionRow($0) } +
            [.newSessionButton, .settingsButton, .quitButton]
        self.coordinator.cancelKill()
        guard let current = coordinator.selection, let index = fields.firstIndex(of: current) else {
            self.coordinator.selection = up ? fields.last : fields.first
            return .handled
        }
        let next = up ? (index > 0 ? index - 1 : fields.count - 1) : (index < fields.count - 1 ? index + 1 : 0)
        self.coordinator.selection = fields[next]
        return .handled
    }

    private func activateSelectionOrFirst() {
        if self.coordinator.selection == nil, let first = self.visibleSessionIds.first {
            self.coordinator.selection = .sessionRow(first)
        }
        _ = self.activateSelection()
    }

    private func activateSelection() -> KeyPress.Result {
        guard let selection = coordinator.selection else { return .ignored }
        switch selection {
        case let .sessionRow(id):
            guard let session = self.display(for: id) else { return .ignored }
            self.coordinator.open(
                session,
                hasWindow: self.sessionMonitor.windowSessionIds.contains(id),
                port: self.serverManager.port)
            self.closeMenu()
        case .newSessionButton:
            self.showNewSession()
        case .settingsButton:
            SettingsOpener.openSettings()
            self.closeMenu()
        case .quitButton:
            NSApplication.shared.terminate(nil)
        }
        return .handled
    }

    private func showNewSession() {
        self.showingNewSession = true
    }

    private func closeMenu() {
        NSApp.windows.lazy.compactMap { $0 as? CustomMenuWindow }.first { $0.isVisible }?.hide()
    }
}
