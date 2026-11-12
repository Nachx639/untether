import os.log
import SwiftUI

private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "NewSessionForm")

/// Compact new session form designed for the popover.
///
/// Provides a streamlined interface for creating new terminal sessions with
/// options for command selection, naming, directory settings, and window spawning.
/// Integrates with the server to create sessions both in terminal windows and web browsers.
struct NewSessionForm: View {
    @Binding var isPresented: Bool
    /// True while the form holds text the user typed; the menu stays open meanwhile.
    @Binding var hasTypedText: Bool
    @Environment(ServerManager.self)
    private var serverManager
    @Environment(SessionMonitor.self)
    private var sessionMonitor
    @Environment(SessionService.self)
    private var sessionService
    @Environment(GitRepositoryMonitor.self)
    private var gitMonitor
    @Environment(ConfigManager.self)
    private var configManager

    // Form fields
    private static let commandPlaceholder = "claude"
    @State private var command = "zsh"
    @State private var sessionName = ""
    @State private var workingDirectory = FilePathConstants.defaultRepositoryBasePath
    /// Command and folder as loadPreferences left them: text differing from these was typed.
    @State private var loadedCommand: String?
    @State private var loadedWorkingDirectory: String?
    @State private var spawnWindow = true
    @State private var titleMode: TitleMode = .static

    // Git worktree state
    @State private var isGitRepository = false
    @State private var gitRepoPath: String?
    @State private var selectedWorktreePath: String?
    @State private var selectedWorktreeBranch: String?
    @State private var gitCheckTask: Task<Void, Never>?
    @State private var worktreeService: WorktreeService?

    // Branch state (matching web version)
    @State private var currentBranch = ""

    // UI state
    @State private var isCreating = false
    @State private var showError = false
    @State private var errorMessage = ""
    @State private var isHoveringCreate = false
    @FocusState private var focusedField: Field?

    enum Field: Hashable {
        case command
        case name
        case directory
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header with back button
            HStack {
                Button(action: {
                    self.isPresented = false
                }, label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.backward")
                            .font(.system(size: 11, weight: .medium))
                        Text("Sessions", comment: "New session form: back button to the session list")
                            .font(.system(size: 12, weight: .medium))
                    }
                })
                .buttonStyle(.plain)
                .foregroundColor(.primary.opacity(0.8))

                Spacer()

                Text("New Session")
                    .font(.system(size: 13, weight: .semibold))

                Spacer()

                // Balance the back button
                Color.clear
                    .frame(width: 60)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(
                LinearGradient(
                    colors: [
                        Color(NSColor.controlBackgroundColor).opacity(0.6),
                        Color(NSColor.controlBackgroundColor).opacity(0.3),
                    ],
                    startPoint: .top,
                    endPoint: .bottom))

            Divider()

            // Form content
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    // Name field (first)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Name")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.secondary)

                        TextField(
                            String(localized: "(optional)", comment: "New session form: placeholder of the optional name field"),
                            text: self.$sessionName)
                            .textFieldStyle(.roundedBorder)
                            .focused(self.$focusedField, equals: .name)
                    }

                    // Command field (second)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Command")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.secondary)

                        // Placeholder is a command: not translated.
                        TextField(Self.commandPlaceholder, text: self.$command)
                            .textFieldStyle(.roundedBorder)
                            .focused(self.$focusedField, equals: .command)
                    }

                    // Working Directory (third)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Working Directory")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.secondary)

                        HStack(spacing: 8) {
                            AutocompleteTextField(text: self.$workingDirectory, placeholder: "~/")
                                .focused(self.$focusedField, equals: .directory)
                                .onChange(of: self.workingDirectory) { _, newValue in
                                    self.checkForGitRepository(at: newValue)
                                }
                                .zIndex(1) // Ensure autocomplete appears above other elements

                            Button(action: self.selectDirectory) {
                                Image(systemName: "folder")
                                    .font(.system(size: 12))
                                    .foregroundColor(.secondary)
                                    .frame(width: 20, height: 20)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.borderless)
                            .help(Text("Choose directory", comment: "New session form: tooltip of the folder picker button"))
                        }
                    }

                    // Git branch and worktree selection when Git repository is detected
                    if self.isGitRepository, let repoPath = gitRepoPath, let service = worktreeService {
                        GitBranchWorktreeSelector(
                            repoPath: repoPath,
                            gitMonitor: self.gitMonitor,
                            worktreeService: service,
                            onWorktreeChanged: { worktree in
                                if let worktree {
                                    // Find the worktree info to get the path
                                    if let worktreeInfo = service.worktrees.first(where: { $0.branch == worktree }) {
                                        self.selectedWorktreePath = worktreeInfo.path
                                        self.selectedWorktreeBranch = worktreeInfo.branch
                                        self.workingDirectory = worktreeInfo.path
                                    }
                                } else {
                                    self.selectedWorktreePath = nil
                                    self.selectedWorktreeBranch = nil
                                    // Don't change workingDirectory here - keep the original git repo path
                                }
                            },
                            onCreateWorktree: { branchName, baseBranch in
                                // Generate worktree path by slugifying branch name
                                let slugifiedBranch = branchName
                                    .replacingOccurrences(of: "/", with: "-")
                                    .replacingOccurrences(of: " ", with: "-")
                                    .lowercased()

                                // Create worktree path in a 'worktrees' subdirectory
                                let repoURL = URL(fileURLWithPath: repoPath)
                                let worktreesDir = repoURL.appendingPathComponent("worktrees")
                                let worktreePath = worktreesDir.appendingPathComponent(slugifiedBranch).path

                                // Create the worktree
                                try await service.createWorktree(
                                    gitRepoPath: repoPath,
                                    branch: branchName,
                                    worktreePath: worktreePath,
                                    baseBranch: baseBranch)

                                // After creation, select the new worktree
                                await service.fetchWorktrees(for: repoPath)
                                if let newWorktree = service.worktrees.first(where: { $0.branch == branchName }) {
                                    self.selectedWorktreePath = newWorktree.path
                                    self.selectedWorktreeBranch = newWorktree.branch
                                    self.workingDirectory = newWorktree.path
                                }
                            })
                            // Another repository is another selector: its branches and
                            // worktrees are loaded again instead of showing the last one's.
                            .id(repoPath)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(Color(NSColor.controlBackgroundColor).opacity(0.05)))
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color.accentColor.opacity(0.2), lineWidth: 1))
                    }

                    // Quick Start
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Quick Start")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.secondary)

                        LazyVGrid(columns: [
                            GridItem(.flexible()),
                            GridItem(.flexible()),
                            GridItem(.flexible()),
                        ], spacing: 8) {
                            ForEach(self.configManager.quickStartCommands) { cmd in
                                Button(action: {
                                    self.command = cmd.command
                                    self.sessionName = ""
                                }, label: {
                                    Text(cmd.displayName)
                                        .font(.system(size: 11))
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 6)
                                })
                                .background(
                                    RoundedRectangle(cornerRadius: 6)
                                        .fill(
                                            self.command == cmd.command ? Color.accentColor.opacity(0.15) : Color
                                                .primary
                                                .opacity(0.05)))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 6)
                                        .stroke(
                                            self.command == cmd.command ? Color.accentColor.opacity(0.5) : Color.primary
                                                .opacity(0.1),
                                            lineWidth: 1))
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    Divider()
                        .padding(.vertical, 4)

                    // Options
                    VStack(spacing: 16) {
                        // Title Mode with combo box - right aligned
                        HStack {
                            Text("Title Mode")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(.secondary)

                            Spacer()

                            Menu {
                                ForEach(TitleMode.allCases, id: \.self) { mode in
                                    Button(action: { self.titleMode = mode }, label: {
                                        HStack {
                                            Text(mode.displayName)
                                            if mode == self.titleMode {
                                                Image(systemName: "checkmark")
                                            }
                                        }
                                    })
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Text(self.titleMode.displayName)
                                        .font(.system(size: 11))
                                        .foregroundColor(.primary)
                                    Image(systemName: "chevron.up.chevron.down")
                                        .font(.system(size: 8, weight: .medium))
                                        .foregroundColor(.secondary)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(
                                    RoundedRectangle(cornerRadius: 6)
                                        .fill(Color.primary.opacity(0.05)))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 6)
                                        .stroke(Color.primary.opacity(0.1), lineWidth: 1))
                            }
                            .menuStyle(.borderlessButton)
                            .menuIndicator(.hidden)
                            .fixedSize()
                        }

                        // Open in Terminal
                        HStack {
                            Text("Terminal", comment: "New session form: label of the option that opens a terminal window")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(.secondary)

                            Text("Open in native terminal window")
                                .font(.system(size: 11))
                                .foregroundColor(.secondary.opacity(0.8))

                            Spacer()

                            Toggle(isOn: self.$spawnWindow) {
                                Text("Open in native terminal window", comment: "New session form: option to open a terminal window")
                            }
                                .toggleStyle(.switch)
                                .scaleEffect(0.8)
                                .labelsHidden()
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 16)
            }
            .frame(minHeight: 400)

            Divider()

            // Create button with improved styling
            HStack {
                Spacer()

                Button(action: self.createSession) {
                    if self.isCreating {
                        HStack(spacing: 4) {
                            ProgressView()
                                .scaleEffect(0.7)
                                .controlSize(.small)
                            Text("Creating…", comment: "Button state while something is being created")
                                .font(.system(size: 12))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 3)
                    } else {
                        Text("Create", comment: "New session form: button that creates the session")
                            .font(.system(size: 12))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 3)
                    }
                }
                .buttonStyle(.plain)
                .foregroundColor(self.command.isEmpty || self.workingDirectory.isEmpty ? .secondary
                    .opacity(0.5) : .secondary)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(
                            self.isHoveringCreate && !self.command.isEmpty && !self.workingDirectory.isEmpty ? Color
                                .accentColor
                                .opacity(0.05) : Color.clear)
                        .animation(.easeInOut(duration: 0.2), value: self.isHoveringCreate))
                .disabled(self.isCreating || self.command.isEmpty || self.workingDirectory.isEmpty)
                .onHover { hovering in
                    self.isHoveringCreate = hovering
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .frame(width: 384)
        .frame(minHeight: 500)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .fixedSize(horizontal: true, vertical: false)
        .onAppear {
            self.loadPreferences()
            self.loadedCommand = self.command
            self.loadedWorkingDirectory = self.workingDirectory
            self.focusedField = .name
            // Check if the default/loaded directory is a Git repository
            self.checkForGitRepository(at: self.workingDirectory)
        }
        .onChange(of: self.typedText) { _, typed in
            self.hasTypedText = typed
        }
        .onDisappear {
            self.hasTypedText = false
        }
        .alert(UIStrings.error, isPresented: self.$showError) {
            Button(UIStrings.ok) {}
        } message: {
            Text(self.errorMessage)
        }
        .compositingGroup() // Render the entire form as a single composited layer
    }

    private func selectDirectory() {
        // Find the menu window first
        guard let menuWindow = NSApp.windows.first(where: { $0 is CustomMenuWindow }) as? CustomMenuWindow else {
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: NSString(string: self.workingDirectory).expandingTildeInPath)
        // Set flag on the window to prevent it from hiding
        menuWindow.isFileSelectionInProgress = true
        // Use beginSheetModal to keep the window relationship
        panel.beginSheetModal(for: menuWindow) { response in
            Task { @MainActor in
                if response == .OK, let url = panel.url {
                    let path = url.path
                    let homeDir = NSHomeDirectory()
                    if path.hasPrefix(homeDir) {
                        self.workingDirectory = "~" + path.dropFirst(homeDir.count)
                    } else {
                        self.workingDirectory = path
                    }
                }

                // Clear the flag after selection completes
                menuWindow.isFileSelectionInProgress = false

                // Ensure the menu window regains focus
                menuWindow.makeKeyAndOrderFront(nil)
            }
        }
    }

    private func createSession() {
        guard !self.command.isEmpty, !self.workingDirectory.isEmpty else { return }

        self.isCreating = true
        self.savePreferences()

        Task {
            do {
                var finalWorkingDir: String
                var effectiveBranch = ""

                // 2026-11-10: this form used to offer "Switch to Branch", a POST to
                // /api/worktrees/switch that the server never had (always 404, the session was
                // made on the current branch after a warning). A session starts on the branch
                // its folder is on; another branch is another worktree.
                if let selectedWorktreePath, let selectedBranch = selectedWorktreeBranch {
                    finalWorkingDir = selectedWorktreePath
                    effectiveBranch = selectedBranch
                } else {
                    finalWorkingDir = self.workingDirectory
                    effectiveBranch = self.currentBranch
                }

                // Parse command into array
                let commandArray = self.parseCommand(self.command.trimmingCharacters(in: .whitespacesAndNewlines))

                // Expand tilde in working directory
                let expandedWorkingDir = NSString(string: finalWorkingDir).expandingTildeInPath

                // Create session using SessionService
                let sessionId = try await sessionService.createSession(
                    command: commandArray,
                    workingDir: expandedWorkingDir,
                    name: self.sessionName.isEmpty ? nil : self.sessionName
                        .trimmingCharacters(in: .whitespacesAndNewlines),
                    titleMode: self.titleMode.rawValue,
                    spawnTerminal: self.spawnWindow,
                    gitRepoPath: self.gitRepoPath,
                    gitBranch: effectiveBranch.isEmpty ? nil : effectiveBranch)

                // If not spawning window, open in browser
                if !self.spawnWindow {
                    if let webURL = DashboardURLBuilder.dashboardURL(port: serverManager.port, sessionId: sessionId) {
                        NSWorkspace.shared.open(webURL)
                    }
                }

                await MainActor.run {
                    self.isPresented = false
                }
            } catch {
                await MainActor.run {
                    self.isCreating = false
                    self.errorMessage = error.localizedDescription
                    self.showError = true
                }
            }
        }
    }

    private func parseCommand(_ cmd: String) -> [String] {
        // Simple command parsing that respects quotes
        var result: [String] = []
        var current = ""
        var inQuotes = false
        var quoteChar: Character?

        for char in cmd {
            if !inQuotes, char == "\"" || char == "'" {
                inQuotes = true
                quoteChar = char
            } else if inQuotes, char == quoteChar {
                inQuotes = false
                quoteChar = nil
            } else if !inQuotes, char == " " {
                if !current.isEmpty {
                    result.append(current)
                    current = ""
                }
            } else {
                current.append(char)
            }
        }

        if !current.isEmpty {
            result.append(current)
        }

        return result.isEmpty ? ["zsh"] : result
    }

    // MARK: - Preferences

    private func loadPreferences() {
        if let savedCommand = appDefaults.string(forKey: AppConstants.UserDefaultsKeys.newSessionCommand) {
            self.command = savedCommand
        }

        // Restore last used working directory, not repository base path
        if let savedDirectory = appDefaults
            .string(forKey: AppConstants.UserDefaultsKeys.newSessionWorkingDirectory)
        {
            self.workingDirectory = savedDirectory
        } else {
            // Default to repository base path if never set
            self.workingDirectory = self.configManager.repositoryBasePath
        }

        // Check if spawn window preference has been explicitly set
        if appDefaults.object(forKey: AppConstants.UserDefaultsKeys.newSessionSpawnWindow) != nil {
            self.spawnWindow = appDefaults.bool(forKey: AppConstants.UserDefaultsKeys.newSessionSpawnWindow)
        } else {
            // Default to true if never set
            self.spawnWindow = true
        }

        if let savedMode = appDefaults.string(forKey: AppConstants.UserDefaultsKeys.newSessionTitleMode),
           let mode = TitleMode(rawValue: savedMode)
        {
            self.titleMode = mode
        }
    }

    private var typedText: Bool {
        guard let loadedCommand, let loadedWorkingDirectory else { return false }
        return Self.hasTypedText(
            sessionName: self.sessionName,
            command: self.command,
            workingDirectory: self.workingDirectory,
            loadedCommand: loadedCommand,
            loadedWorkingDirectory: loadedWorkingDirectory)
    }

    /// Whether the form holds text the user typed: a name, or a command or folder other than
    /// the ones the form opened with. Spaces alone are not text.
    static func hasTypedText(
        sessionName: String,
        command: String,
        workingDirectory: String,
        loadedCommand: String,
        loadedWorkingDirectory: String)
        -> Bool
    {
        !sessionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || command != loadedCommand
            || workingDirectory != loadedWorkingDirectory
    }

    private func savePreferences() {
        appDefaults.set(self.command, forKey: AppConstants.UserDefaultsKeys.newSessionCommand)
        appDefaults.set(
            self.workingDirectory,
            forKey: AppConstants.UserDefaultsKeys.newSessionWorkingDirectory)
        appDefaults.set(self.spawnWindow, forKey: AppConstants.UserDefaultsKeys.newSessionSpawnWindow)
        appDefaults.set(self.titleMode.rawValue, forKey: AppConstants.UserDefaultsKeys.newSessionTitleMode)
    }

    /// Looks at the folder in the form: is it a Git repository, which branch, which worktree.
    ///
    /// 2026-11-10: a check was dropped when another was in flight (`guard !checkingGitStatus`)
    /// and nothing looked again, so after typing or pasting a path quickly the form kept the
    /// repository, branch and worktree of an OLDER path, and the session was created with
    /// them. The newest path now cancels the check before it, and a cancelled check writes
    /// nothing.
    private func checkForGitRepository(at path: String) {
        self.gitCheckTask?.cancel()

        logger.info("🔍 Checking for Git repository at: \(path)")

        self.gitCheckTask = Task { @MainActor in
            let expandedPath = NSString(string: path).expandingTildeInPath
            logger.debug("🔍 Expanded path: \(expandedPath)")

            guard let repo = await gitMonitor.findRepository(for: expandedPath) else {
                guard !Task.isCancelled else { return }
                logger.info("❌ No Git repository found")
                self.isGitRepository = false
                self.gitRepoPath = nil
                self.selectedWorktreePath = nil
                self.selectedWorktreeBranch = nil
                self.worktreeService = nil
                self.currentBranch = ""
                return
            }
            guard !Task.isCancelled else { return }

            logger.info("✅ Found Git repository: \(repo.path)")
            let service = WorktreeService(serverManager: self.serverManager)
            if self.gitRepoPath != repo.path {
                // Another repository: nothing chosen for the one before applies.
                self.selectedWorktreePath = nil
                self.selectedWorktreeBranch = nil
                self.currentBranch = ""
            }
            self.isGitRepository = true
            self.gitRepoPath = repo.path
            self.worktreeService = service

            // Fetch branches and worktrees in parallel
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    await service.fetchBranches(for: repo.path)
                }
                group.addTask {
                    await service.fetchWorktrees(for: repo.path)
                }
            }
            guard !Task.isCancelled else { return }

            // Find and set current branch
            if let currentBranchData = service.branches.first(where: { $0.current }) {
                self.currentBranch = currentBranchData.name
            }

            // Pre-select current worktree if we're in one (not the main worktree)
            if let currentWorktree = service.worktrees.first(where: {
                $0.path == expandedPath && !($0.isMainWorktree ?? false)
            }) {
                self.selectedWorktreePath = currentWorktree.path
                self.selectedWorktreeBranch = currentWorktree.branch
            }
        }
    }
}

// MARK: - Repository Dropdown List
