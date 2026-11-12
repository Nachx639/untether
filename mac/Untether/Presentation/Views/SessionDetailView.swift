import ApplicationServices
import os
import SwiftUI

/// View displaying detailed information about a specific terminal session.
///
/// Shows comprehensive session information including process details, status,
/// working directory, command history, and timestamps. Provides a detailed
/// debugging and monitoring interface for active terminal sessions.
struct SessionDetailView: View {
    let session: ServerSessionInfo
    @State private var windowTitle = ""
    @State private var windowInfo: WindowInfo?
    @State private var isFindingWindow = false
    @State private var isConfirmingKill = false
    @Environment(SystemPermissionManager.self)
    private var permissionManager
    @Environment(SessionService.self)
    private var sessionService
    @Environment(ServerManager.self)
    private var serverManager

    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "SessionDetailView")

    /// One column; the window grows downwards, never sideways.
    static let width: CGFloat = 560

    private var title: String {
        SessionDisplay.title(for: self.session, tool: SessionDisplay.tool(for: self.session))
    }

    private var branch: String? {
        self.session.gitBranch?.trimmingCharacters(in: .whitespaces).nilIfEmpty
    }

    /// "Running", "Ended" or "Ended · exit 1".
    private var statusText: String {
        if self.session.isRunning {
            return String(localized: "session.state.running", defaultValue: "Running", comment: "Session state: a plain program or shell runs")
        }
        if let code = self.session.exitCode, code != 0 {
            return String(localized: "Ended · exit \(code)", comment: "Session Details: status of a session that failed. Placeholder: exit code")
        }
        return String(localized: "Ended", comment: "Session Details: status of a session that ended")
    }

    var body: some View {
        VStack(spacing: 0) {
            self.header
                .padding(.horizontal, DS.Spacing.xl)
                .padding(.top, DS.Spacing.xl)

            Form {
                self.sessionSection
                self.windowSection
                self.technicalSection
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)

            self.actionBar
                .padding(.horizontal, DS.Spacing.xl)
                .padding(.top, DS.Spacing.s)
                .padding(.bottom, DS.Spacing.xl)
        }
        .frame(width: Self.width)
        .frame(minHeight: 420, idealHeight: 600)
        .background(Color(nsColor: .windowBackgroundColor))
        .buttonStyle(.dsNeutral)
        .tint(DS.Accent.color)
        .confirmationDialog("Kill this session?", isPresented: self.$isConfirmingKill) {
            Button("Kill", role: .destructive) {
                self.terminateSession()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The program running in it stops right away.")
        }
        .onAppear {
            self.updateWindowTitle()
            self.findWindow()

            // Check permissions
            Task {
                await self.permissionManager.checkAllPermissions()
            }
        }
        .onChange(of: self.title) { _, _ in self.updateWindowTitle() }
        .background(WindowAccessor(title: self.$windowTitle))
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.m) {
            VStack(alignment: .leading, spacing: DS.Spacing.xs) {
                Text(self.title)
                    .font(.title2.weight(.semibold))
                    .lineLimit(2)
                    .textSelection(.enabled)

                HStack(spacing: DS.Spacing.s) {
                    Text(SessionDisplay.abbreviate(self.session.workingDir))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(self.session.workingDir)
                    if let branch = self.branch {
                        BranchChip(branch: branch, maxWidth: 180)
                            .fixedSize()
                    }
                }
            }

            Spacer(minLength: DS.Spacing.m)

            HStack(spacing: DS.Spacing.xs) {
                SessionStateDot(state: SessionDisplay.state(for: self.session))
                Text(self.statusText)
                    .font(.callout)
                    .foregroundStyle(self.session.isRunning ? .primary : .secondary)
                    .lineLimit(1)
            }
            .fixedSize()
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: - Sections

    private var sessionSection: some View {
        Section("Session") {
            DetailRow(label: "Command", value: self.session.command.joined(separator: " "))
            DetailDateRow(label: "Started", date: SessionDisplay.parseDate(self.session.startedAt))
            DetailDateRow(label: "Updated", date: SessionDisplay.parseDate(self.session.lastModified))
        }
    }

    private var windowSection: some View {
        Section("Terminal Window") {
            if let windowInfo {
                DetailRow(label: "Terminal App", value: windowInfo.terminalApp.displayName)
                if let title = windowInfo.title, !title.isEmpty {
                    DetailRow(label: "Window Title", value: title)
                }
                HStack {
                    Spacer()
                    Button("Focus Window") {
                        self.focusWindow()
                    }
                    .buttonStyle(.bordered)
                    // The accent is for the one prominent button only.
                    .dsNeutralTint()
                }
            } else if self.isFindingWindow {
                HStack(spacing: DS.Spacing.s) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Searching…")
                        .foregroundStyle(.secondary)
                }
            } else {
                CalloutBox(kind: .info) {
                    Text("No window found")
                        .foregroundStyle(.primary)
                    Text("The window may have been closed, or the session started outside Untether.")
                }
                HStack {
                    Spacer()
                    Button("Find Window") {
                        self.findWindow()
                    }
                    .buttonStyle(.bordered)
                    .dsNeutralTint()
                }
            }
        }
    }

    private var technicalSection: some View {
        Section {
            DisclosureGroup("Technical Details") {
                DetailRow(label: "Session ID", value: self.session.id)
                if let pid = self.session.pid {
                    DetailRow(label: "Process ID", value: String(pid))
                }
                if let exitCode = self.session.exitCode {
                    DetailRow(label: "Exit Code", value: String(exitCode))
                }
                if let windowInfo {
                    DetailRow(label: "Window ID", value: String(windowInfo.windowID))
                    DetailRow(label: "Owner PID", value: String(windowInfo.ownerPID))
                    if let bounds = windowInfo.bounds {
                        DetailRow(
                            label: "Position",
                            value: "x \(Int(bounds.origin.x)), y \(Int(bounds.origin.y))")
                        DetailRow(label: "Size", value: "\(Int(bounds.width)) × \(Int(bounds.height))")
                    }
                }
            }
        }
    }

    // MARK: - Actions

    private var actionBar: some View {
        HStack(spacing: DS.Spacing.s) {
            if self.session.isRunning {
                Button("Kill…", role: .destructive) {
                    self.isConfirmingKill = true
                }
                .buttonStyle(.bordered)
                // Red, never the accent: the accent marks the one primary action.
                .tint(.red)
            }

            Spacer()

            Button("Open in Terminal") {
                self.openInTerminal()
            }
            .buttonStyle(.borderedProminent)
        }
        .controlSize(.large)
    }

    private func updateWindowTitle() {
        self.windowTitle = self.title
    }

    private func openInTerminal() {
        do {
            let terminalLauncher = TerminalLauncher.shared
            try terminalLauncher.launchTerminalSession(
                workingDirectory: self.session.workingDir,
                // 2026-10-20: the argv was joined with spaces and ran unquoted, so an
                // argument with a space, quote or `;` split or ran as shell syntax.
                command: TerminalLauncher.shellCommand(fromArgv: self.session.command),
                sessionId: self.session.id)
            self.logger.info("Opened session \(self.session.id) in terminal")
        } catch {
            self.logger.error("Failed to open session in terminal: \(error)")
            // Could show an alert here if needed
        }
    }

    private func terminateSession() {
        Task {
            do {
                try await self.sessionService.terminateSession(sessionId: self.session.id)
                self.logger.info("Terminated session \(self.session.id)")
                // The view will automatically update when session is removed from monitor
                // You could dismiss the window here if desired
            } catch {
                self.logger.error("Failed to terminate session: \(error)")
                // Could show an alert here if needed
            }
        }
    }

    private func findWindow() {
        self.isFindingWindow = true

        Task { @MainActor in
            defer {
                isFindingWindow = false
            }

            self.logger.info("Looking for window associated with session \(self.session.id)")

            // First, check if WindowTracker already has window info for this session
            if let trackedWindow = WindowTracker.shared.windowInfo(for: session.id) {
                self.logger
                    .info(
                        "Found tracked window for session \(self.session.id): windowID=\(trackedWindow.windowID), terminal=\(trackedWindow.terminalApp.rawValue)")
                self.windowInfo = trackedWindow
                return
            }

            self.logger.info("No tracked window found for session \(self.session.id), attempting to find it...")

            // Get all terminal windows for debugging
            let allWindows = WindowEnumerator.getAllTerminalWindows()
            self.logger.info("Found \(allWindows.count) terminal windows currently open")

            // Log details about each window for debugging
            for (index, window) in allWindows.enumerated() {
                self.logger
                    .debug(
                        "Window \(index): terminal=\(window.terminalApp.rawValue), windowID=\(window.windowID), ownerPID=\(window.ownerPID), title=\(window.title ?? "<no title>")")
            }

            // Log session details for debugging
            self.logger
                .info(
                    "Session details: id=\(self.session.id), pid=\(self.session.pid ?? -1), workingDir=\(self.session.workingDir)")

            // Try to match by various criteria
            if let pid = session.pid {
                self.logger.info("Looking for window with PID \(pid)...")
                if let window = allWindows.first(where: { $0.ownerPID == pid }) {
                    self.logger.info("Found window by PID match: windowID=\(window.windowID)")
                    // Shown here only. 2026-11-10: this used to register the session as "opened
                    // by us", which let Untether close the window of a session it never opened.
                    self.windowInfo = window
                    return
                } else {
                    self.logger.warning("No window found with PID \(pid)")
                }
            }

            // Try to find by window title containing working directory
            let workingDirName = URL(fileURLWithPath: session.workingDir).lastPathComponent
            self.logger.info("Looking for window with title containing '\(workingDirName)'...")

            if let window = allWindows.first(where: { window in
                if let title = window.title {
                    return title.contains(workingDirName) || title.contains(session.id)
                }
                return false
            }) {
                self.logger
                    .info("Found window by title match: windowID=\(window.windowID), title=\(window.title ?? "")")
                self.windowInfo = window
                return
            }

            self.logger
                .warning(
                    "Could not find window for session \(self.session.id) after checking all \(allWindows.count) terminal windows")
            self.logger.warning("Session may not have an associated terminal window or window detection failed")
        }
    }

    private func focusWindow() {
        // Use WindowTracker's existing focus logic which handles all the complexity
        self.logger.info("Attempting to focus window for session \(self.session.id)")

        // First ensure we have window info
        if windowInfo == nil {
            self.logger.info("No window info cached, trying to find window first...")
            self.findWindow()
        }

        if let windowInfo {
            self.logger
                .info(
                    "Using WindowTracker to focus window: windowID=\(windowInfo.windowID), terminal=\(windowInfo.terminalApp.rawValue)")
            WindowTracker.shared.focusWindow(for: self.session.id)
        } else {
            self.logger.error("Cannot focus window - no window found for session \(self.session.id)")
        }
    }
}

// MARK: - Supporting Views

/// A label and a value as a form row: the value wraps to two lines, then truncates in the
/// middle, with the full text in the tooltip. Numbers keep their digits as given (no grouping).
struct DetailRow: View {
    let label: LocalizedStringKey
    let value: String

    var body: some View {
        LabeledContent(self.label) {
            Text(verbatim: self.value)
                .monospacedDigit()
                .lineLimit(2)
                .truncationMode(.middle)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
                .help(Text(verbatim: self.value))
        }
    }
}

/// "Started 2 h ago" as a form row, with the full date in the tooltip. Refreshes once a minute;
/// never ticks every second like `Text(date, style: .relative)`.
struct DetailDateRow: View {
    let label: LocalizedStringKey
    let date: Date?

    var body: some View {
        LabeledContent(self.label) {
            if let date {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(verbatim: DS.Time.ago(date, now: context.date))
                        .monospacedDigit()
                        .help(DS.Time.full(date))
                }
            } else {
                Text("Unknown")
            }
        }
    }
}

/// Shown when a Session Details window outlives its session.
struct SessionEndedView: View {
    var body: some View {
        VStack(spacing: DS.Spacing.s) {
            Image(systemName: "terminal")
                .font(.title)
                .foregroundStyle(.secondary)
            Text("This session has ended")
                .font(.headline)
            Text("It's no longer in the session list.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(DS.Spacing.xl)
        .frame(width: 400, height: 300)
        .buttonStyle(.dsNeutral)
        .tint(DS.Accent.color)
    }
}

extension String {
    /// nil for an empty string.
    fileprivate var nilIfEmpty: String? {
        self.isEmpty ? nil : self
    }
}

// MARK: - Window Title Accessor

/// NSViewRepresentable that provides access to the window title.
///
/// Used to set custom window titles for session detail windows,
/// allowing each window to display the session ID in its title bar.
struct WindowAccessor: NSViewRepresentable {
    @Binding var title: String

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            if let window = view.window {
                window.title = self.title

                // Watch for title changes
                Task { @MainActor in
                    context.coordinator.startObserving(window: window, binding: self.$title)
                }
            }
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            if let window = nsView.window {
                window.title = self.title
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    class Coordinator: NSObject {
        private var observation: NSKeyValueObservation?

        @MainActor
        func startObserving(window: NSWindow, binding: Binding<String>) {
            // Update the binding when window title changes
            self.observation = window.observe(\.title, options: [.new]) { _, change in
                if let newTitle = change.newValue {
                    DispatchQueue.main.async {
                        binding.wrappedValue = newTitle
                    }
                }
            }

            // Set initial title
            window.title = binding.wrappedValue
        }

        deinit {
            observation?.invalidate()
        }
    }
}
