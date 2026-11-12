import SwiftUI

/// System logs viewer with filtering and search capabilities
struct SystemLogsView: View {
    @Environment(\.dismiss)
    var dismiss
    @State private var logs = ""
    @State private var isLoading = true
    @State private var presentedError: IdentifiableError?
    @State private var searchText = ""
    @State private var selectedLevel: LogLevel = .all
    @State private var showClientLogs = true
    @State private var showServerLogs = true
    @State private var autoScroll = true
    @State private var refreshTimer: Timer?
    @State private var showingClearConfirmation = false
    @State private var logsInfo: LogsInfo?

    typealias LogLevel = SystemLogFilter.Level

    var filteredLogs: String {
        SystemLogFilter(
            level: self.selectedLevel,
            showClient: self.showClientLogs,
            showServer: self.showServerLogs,
            search: self.searchText)
            .apply(to: self.logs)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Colors.terminalBackground
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    // Filters toolbar
                    self.filtersToolbar

                    // Search bar
                    self.searchBar

                    // Logs content
                    if self.isLoading {
                        ProgressView("Loading logs...")
                            .progressViewStyle(CircularProgressViewStyle(tint: Theme.Colors.primaryAccent))
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if self.presentedError != nil {
                        ContentUnavailableView {
                            Label("Failed to Load Logs", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text("The logs could not be loaded. Please try again.")
                        } actions: {
                            Button("Retry") {
                                Task {
                                    await self.loadLogs()
                                }
                            }
                            .terminalButton()
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        self.logsContent
                    }
                }
            }
            .navigationTitle("System Logs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Close") {
                        self.dismiss()
                    }
                    .foregroundColor(Theme.Colors.primaryAccent)
                }

                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        // (presenting a share sheet by hand from the root controller fails here:
                        // the root already presents Settings, which presents this sheet)
                        ShareLink(item: self.logs) {
                            Label("Download", systemImage: "square.and.arrow.down")
                        }

                        Button(action: { self.showingClearConfirmation = true }, label: {
                            Label("Clear Logs", systemImage: "trash")
                        })

                        Toggle("Auto-scroll", isOn: self.$autoScroll)

                        if let info = logsInfo {
                            Section {
                                Label(self.formatFileSize(info.size), systemImage: "doc")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .foregroundColor(Theme.Colors.primaryAccent)
                    }
                }
            }
        }
        .task {
            await self.loadLogs()
            self.startAutoRefresh()
        }
        .onDisappear {
            self.stopAutoRefresh()
        }
        .alert("Clear Logs", isPresented: self.$showingClearConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Clear", role: .destructive) {
                Task {
                    await self.clearLogs()
                }
            }
        } message: {
            Text("Are you sure you want to clear all system logs? This action cannot be undone.")
        }
        .errorAlert(item: self.$presentedError)
    }

    private var filtersToolbar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // Level filter
                Menu {
                    ForEach(LogLevel.allCases, id: \.self) { level in
                        Button(action: { self.selectedLevel = level }, label: {
                            HStack {
                                Text(level.displayName)
                                if self.selectedLevel == level {
                                    Image(systemName: "checkmark")
                                }
                            }
                        })
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "line.horizontal.3.decrease.circle")
                        Text(self.selectedLevel.displayName)
                    }
                    .font(.caption)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Theme.Colors.cardBackground)
                    .cornerRadius(6)
                }

                // Source toggles
                Toggle("Client", isOn: self.$showClientLogs)
                    .toggleStyle(ChipToggleStyle())

                Toggle("Server", isOn: self.$showServerLogs)
                    .toggleStyle(ChipToggleStyle())

                Spacer()
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 8)
        .background(Theme.Colors.cardBackground)
    }

    private var searchBar: some View {
        HStack {
            Image(systemName: "magnifyingglass")
                .foregroundColor(Theme.Colors.terminalForeground.opacity(0.5))

            TextField("Search logs...", text: self.$searchText)
                .textFieldStyle(PlainTextFieldStyle())
                .font(Theme.Typography.terminalSystem(size: 14))
                .foregroundColor(Theme.Colors.terminalForeground)
                .autocapitalization(.none)
                .disableAutocorrection(true)

            if !self.searchText.isEmpty {
                Button(action: { self.searchText = "" }, label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(Theme.Colors.terminalForeground.opacity(0.5))
                })
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Theme.Colors.terminalDarkGray)
    }

    private var logsContent: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(self.filteredLogs.isEmpty ? "No logs matching filters" : self.filteredLogs)
                    .font(Theme.Typography.terminalSystem(size: 12))
                    .foregroundColor(Theme.Colors.terminalForeground)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .textSelection(.enabled)
                    .id("bottom")
            }
            .background(Theme.Colors.terminalDarkGray)
            .onChange(of: self.filteredLogs) { _, _ in
                if self.autoScroll {
                    withAnimation {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }
        }
    }

    /// Loads the end of the log. `refreshing` is the 2-second timer: it asks for the file's
    /// size first and downloads only when it changed, never shows the spinner (it replaced
    /// the text and lost the scroll position every 2 seconds) and keeps what is on screen
    /// when the server does not answer.
    private func loadLogs(refreshing: Bool = false) async {
        if !refreshing {
            self.isLoading = self.logs.isEmpty
            self.presentedError = nil
        }

        do {
            let info = try await APIClient.shared.getLogsInfo()
            let changed = info.size != self.logsInfo?.size || info.lastModified != self.logsInfo?.lastModified
            if changed || !refreshing {
                self.logs = try await APIClient.shared.getLogsRaw(tailBytes: Self.tailBytes)
            }
            self.logsInfo = info
            self.presentedError = nil
        } catch {
            if !refreshing {
                self.presentedError = IdentifiableError(error: error)
            }
        }
        self.isLoading = false
    }

    /// How much of the end of the log is shown (the file grows to 50 MB before it rotates).
    private static let tailBytes = 512 * 1_024

    private func clearLogs() async {
        do {
            try await APIClient.shared.clearLogs()
            self.logs = ""
            await self.loadLogs()
        } catch {
            self.presentedError = IdentifiableError(error: error)
        }
    }

    private func startAutoRefresh() {
        self.refreshTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
            Task {
                await self.loadLogs(refreshing: true)
            }
        }
    }

    private func stopAutoRefresh() {
        self.refreshTimer?.invalidate()
        self.refreshTimer = nil
    }

    private func formatFileSize(_ size: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .binary
        return formatter.string(fromByteCount: size)
    }
}

/// Custom toggle style for filter chips
/// Custom toggle style resembling a selectable chip.
/// Provides a compact, button-like appearance for filter toggles.
struct ChipToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button(action: { configuration.isOn.toggle() }, label: {
            HStack(spacing: 4) {
                if configuration.isOn {
                    Image(systemName: "checkmark")
                        .font(.caption2)
                }
                configuration.label
            }
            .font(.caption)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(configuration.isOn ? Theme.Colors.primaryAccent.opacity(0.2) : Theme.Colors.cardBackground)
            .foregroundColor(configuration.isOn ? Theme.Colors.primaryAccent : Theme.Colors.terminalForeground)
            .cornerRadius(6)
        })
        .buttonStyle(PlainButtonStyle())
    }
}

/// Which lines of the server log the viewer shows.
///
/// A line of the log is `<ISO time> <LEVEL padded to 5> [<module>] <message>`
/// (web/src/server/utils/logger.ts); the web client's entries carry `[FE] ` in front of the
/// module (web/src/server/routes/logs.ts). A message of several lines (a stack, indented
/// JSON) has that header only on its first line: the rest belong to the same entry.
struct SystemLogFilter {
    enum Level: String, CaseIterable {
        case all = "All"
        case error = "Error"
        case warn = "Warn"
        case log = "Log"
        case debug = "Debug"

        var displayName: String { rawValue }
    }

    var level: Level = .all
    var showClient = true
    var showServer = true
    var search = ""

    private struct Header {
        let level: Level
        let isClient: Bool
    }

    private static func header(of line: Substring) -> Header? {
        guard let match = line.firstMatch(of: /^\S+ (ERROR|WARN|LOG|DEBUG) *\[(\[FE\] )?/) else { return nil }
        let level: Level = switch match.1 {
        case "ERROR": .error
        case "WARN": .warn
        case "DEBUG": .debug
        default: .log
        }
        return Header(level: level, isClient: match.2 != nil)
    }

    func apply(to logs: String) -> String {
        var shown: [Substring] = []
        // Lines before the first header (a tail that starts mid-entry) count as server log
        var current = Header(level: .log, isClient: false)
        var entry: [Substring] = []

        func closeEntry() {
            defer { entry.removeAll(keepingCapacity: true) }
            guard !entry.isEmpty else { return }
            if self.level != .all, current.level != self.level { return }
            if current.isClient ? !self.showClient : !self.showServer { return }
            // The search looks at the whole entry, so a stack is found by its first line too
            if !self.search.isEmpty,
               !entry.contains(where: { $0.localizedCaseInsensitiveContains(self.search) })
            {
                return
            }
            shown.append(contentsOf: entry)
        }

        for line in logs.split(whereSeparator: \.isNewline) where !line.allSatisfy(\.isWhitespace) {
            if let header = Self.header(of: line) {
                closeEntry()
                current = header
            }
            entry.append(line)
        }
        closeEntry()

        return shown.joined(separator: "\n")
    }
}
