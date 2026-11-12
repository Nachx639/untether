import AppKit
import Foundation
import Observation
import OSLog

/// UI state shared by the menu's session rows and its keyboard handling: which row is hovered or
/// selected, which one is being renamed, which one asks "Kill?" and which sections are
/// collapsed. Lives as long as the menu view.
@MainActor
@Observable
final class MenuSessionCoordinator {
    /// Row under the mouse.
    var hoveredId: String?
    /// Row or footer button selected with the keyboard (arrow keys); nil until the keyboard is used.
    var selection: MenuFocusField?
    /// Row showing its rename field.
    var renamingId: String?
    /// Row showing the inline "Kill?" confirmation.
    var pendingKillId: String?
    /// Rows whose kill request is on its way.
    private(set) var terminatingIds: Set<String> = []
    /// Sections ("idle", "terminals"...) the user folded (persisted across launches).
    private(set) var collapsedSections: Set<String>

    private static let collapsedKey = "menuCollapsedSections"
    private static let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "MenuSessions")

    init() {
        self.collapsedSections = Set(appDefaults.stringArray(forKey: Self.collapsedKey) ?? [])
    }

    func isCollapsed(_ sectionId: String) -> Bool {
        self.collapsedSections.contains(sectionId)
    }

    func toggleCollapsed(_ sectionId: String) {
        if self.collapsedSections.remove(sectionId) == nil {
            self.collapsedSections.insert(sectionId)
        }
        appDefaults.set(Array(self.collapsedSections), forKey: Self.collapsedKey)
    }

    // MARK: - Actions

    /// Focus the session's terminal window, or open it in the browser when it has none.
    func open(_ session: SessionDisplay, hasWindow: Bool, port: String) {
        if hasWindow {
            WindowTracker.shared.focusWindow(for: session.id)
        } else if let url = DashboardURLBuilder.dashboardURL(port: port, sessionId: session.id) {
            NSWorkspace.shared.open(url)
        }
    }

    func revealInFinder(_ session: SessionDisplay) {
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: session.info.workingDir)
    }

    func startRename(_ sessionId: String) {
        self.pendingKillId = nil
        self.renamingId = sessionId
    }

    func endRename() {
        self.renamingId = nil
    }

    /// True when submitting the rename field would change nothing: the same user title, or no
    /// user title and an empty field. Submitting the automatic title unchanged must not pin it
    /// as a user title (2026-10-12: ⌘R then Return froze the agent's title).
    static func isRenameNoOp(_ edited: String, userTitle: String?) -> Bool {
        let trimmed = edited.trimmingCharacters(in: .whitespacesAndNewlines)
        let current = userTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed == current
    }

    func rename(_ sessionId: String, to title: String, using service: SessionService) {
        self.renamingId = nil
        Task {
            do {
                try await service.renameSession(sessionId: sessionId, to: title)
            } catch {
                Self.logger.error("Failed to rename session \(sessionId): \(error)")
            }
        }
    }

    /// First step of a kill: the row asks "Kill?".
    func requestKill(_ sessionId: String) {
        self.renamingId = nil
        self.pendingKillId = sessionId
    }

    enum KillKeyDecision: Equatable { case request, confirm, ignore }

    /// What ⌫ (or Return while a row asks "Kill?") does. Key-repeat events never confirm: holding
    /// ⌫ a moment too long sent .down then .repeat and skipped the confirmation (2026-10-12).
    static func killKeyDecision(sessionId: String, pendingKillId: String?, isRepeat: Bool) -> KillKeyDecision {
        if isRepeat { return .ignore }
        return pendingKillId == sessionId ? .confirm : .request
    }

    func cancelKill() {
        self.pendingKillId = nil
    }

    func isTerminating(_ sessionId: String) -> Bool {
        self.terminatingIds.contains(sessionId)
    }

    /// Kill the session now (after the confirmation, or ⌥-click).
    func kill(_ sessionId: String, using service: SessionService) {
        self.pendingKillId = nil
        guard !self.terminatingIds.contains(sessionId) else { return }
        self.terminatingIds.insert(sessionId)
        Task {
            do {
                try await service.terminateSession(sessionId: sessionId)
                // The session monitor drops the row on its next poll.
                await SessionMonitor.shared.refresh()
            } catch {
                Self.logger.error("Failed to terminate session \(sessionId): \(error)")
            }
            self.terminatingIds.remove(sessionId)
        }
    }
}
