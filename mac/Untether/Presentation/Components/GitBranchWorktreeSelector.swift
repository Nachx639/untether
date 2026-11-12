import Combine
import os.log
import SwiftUI

private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "GitBranchWorktreeSelector")

/// A SwiftUI component for Git branch and worktree selection, mirroring the web UI functionality
struct GitBranchWorktreeSelector: View {
    // MARK: - Properties

    let repoPath: String
    let gitMonitor: GitRepositoryMonitor
    let worktreeService: WorktreeService
    let onWorktreeChanged: (String?) -> Void
    let onCreateWorktree: (String, String) async throws -> Void

    @State private var selectedBranch: String = ""
    @State private var selectedWorktree: String?
    @State private var availableBranches: [String] = []
    @State private var availableWorktrees: [Worktree] = []
    @State private var isLoadingBranches = false
    @State private var isLoadingWorktrees = false
    @State private var showCreateWorktree = false
    @State private var newBranchName = ""
    @State private var isCreatingWorktree = false
    @State private var followBranch: String?
    @State private var errorMessage: String?

    @FocusState private var isNewBranchFieldFocused: Bool

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Worktree Selection
            // 2026-11-10: there was a "Switch to Branch" picker here; the server never had the
            // route behind it (POST /api/worktrees/switch), so it only produced a warning. A
            // branch is now chosen only as the base of a new worktree.
            VStack(alignment: .leading, spacing: 4) {
                Text("Worktree:")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)

                if !self.showCreateWorktree {
                    Menu {
                        Button(action: {
                            self.selectedWorktree = nil
                            self.onWorktreeChanged(nil)
                        }, label: {
                            Text(self.worktreeNoneText)
                        })

                        Divider()

                        ForEach(self.availableWorktrees, id: \.id) { worktree in
                            Button(action: {
                                self.selectedWorktree = worktree.branch
                                self.onWorktreeChanged(worktree.branch)
                            }, label: {
                                HStack {
                                    Text(self.formatWorktreeName(worktree))
                                    if worktree.isFollowed(followBranch: self.followBranch) {
                                        Text(verbatim: "⚡️")
                                    }
                                }
                            })
                        }
                    } label: {
                        HStack {
                            Text(self.selectedWorktreeText)
                                .font(.system(size: 12))
                                .lineLimit(1)
                            Spacer()
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10))
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(Color.secondary.opacity(0.1))
                        .cornerRadius(4)
                    }
                    .buttonStyle(.plain)
                    .disabled(self.isLoadingWorktrees)

                    self.statusText

                    Button(action: {
                        self.showCreateWorktree = true
                        self.newBranchName = ""
                        self.isNewBranchFieldFocused = true
                    }, label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus")
                                .font(.system(size: 10))
                            Text("Create new worktree")
                                .font(.system(size: 11))
                        }
                        .foregroundColor(.accentColor)
                    })
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                } else {
                    // Create Worktree Mode
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Base Branch for Worktree:")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)

                        Menu {
                            ForEach(self.availableBranches, id: \.self) { branch in
                                Button(action: {
                                    self.selectedBranch = branch
                                }, label: {
                                    HStack {
                                        Text(verbatim: branch)
                                        if branch == self.getCurrentBranch() {
                                            Text("(current)", comment: "Branch picker: marks the branch that is checked out")
                                                .foregroundColor(.secondary)
                                        }
                                    }
                                })
                            }
                        } label: {
                            HStack {
                                Text(
                                    self.selectedBranch.isEmpty
                                        ? String(
                                            localized: "Select branch",
                                            comment: "Branch picker: placeholder when no branch is chosen")
                                        : self.selectedBranch)
                                    .font(.system(size: 12))
                                    .lineLimit(1)
                                Spacer()
                                Image(systemName: "chevron.down")
                                    .font(.system(size: 10))
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(Color.secondary.opacity(0.1))
                            .cornerRadius(4)
                        }
                        .buttonStyle(.plain)
                        .disabled(self.isLoadingBranches || self.isCreatingWorktree)

                        TextField("New branch name", text: self.$newBranchName)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size: 12))
                            .focused(self.$isNewBranchFieldFocused)
                            .disabled(self.isCreatingWorktree)
                            .onSubmit {
                                if !self.newBranchName.isEmpty {
                                    self.createWorktree()
                                }
                            }

                        HStack(spacing: 8) {
                            Button("Cancel") {
                                self.showCreateWorktree = false
                                self.newBranchName = ""
                                self.errorMessage = nil
                            }
                            .font(.system(size: 11))
                            .buttonStyle(.plain)
                            .disabled(self.isCreatingWorktree)

                            Button(
                                self.isCreatingWorktree
                                    ? String(localized: "Creating…", comment: "Button state while something is being created")
                                    : String(localized: "Create", comment: "Worktree form: button that creates the worktree"))
                            {
                                self.createWorktree()
                            }
                            .font(.system(size: 11))
                            .buttonStyle(.borderedProminent)
                            .disabled(
                                self.newBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
                                    .isEmpty || self.isCreatingWorktree)
                        }

                        if let error = errorMessage {
                            Text(error)
                                .font(.system(size: 9))
                                .foregroundColor(.red)
                        }
                    }
                }
            }
        }
        .task {
            await self.loadGitData()
        }
    }

    // MARK: - Subviews

    private var statusText: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let worktree = selectedWorktree {
                Text("Session will use worktree: \(worktree)")
                    .font(.system(size: 9))
                    .foregroundColor(.secondary)
            }

            if let branch = followBranch {
                Text("Follow mode active: following \(branch)")
                    .font(.system(size: 9))
                    .foregroundColor(.accentColor)
            }
        }
    }

    private var worktreeNoneText: String {
        if self.selectedWorktree != nil {
            String(localized: "No worktree (use main repository)", comment: "Worktree picker: option to work in the main checkout")
        } else if self.availableWorktrees
            .contains(where: { $0.isCurrentWorktree == true && $0.isMainWorktree != true })
        {
            String(localized: "Switch to main repository", comment: "Worktree picker: option to go back to the main checkout")
        } else {
            String(localized: "No worktree (use main repository)", comment: "Worktree picker: option to work in the main checkout")
        }
    }

    private var selectedWorktreeText: String {
        if let worktree = selectedWorktree,
           let info = availableWorktrees.first(where: { $0.branch == worktree })
        {
            return self.formatWorktreeName(info)
        }
        return self.worktreeNoneText
    }

    // MARK: - Methods

    private func formatWorktreeName(_ worktree: Worktree) -> String {
        let folderName = URL(fileURLWithPath: worktree.path).lastPathComponent
        // Strip refs/heads/ prefix from branch name for comparison and display
        let branchName = worktree.branch.replacingOccurrences(of: "refs/heads/", with: "")
        let showBranch = folderName.lowercased() != branchName.lowercased() &&
            !folderName.lowercased().hasSuffix("-\(branchName.lowercased())")

        var result = folderName
        if showBranch {
            result += " [\(branchName)]"
        }
        if worktree.isMainWorktree == true {
            result += " " + String(localized: "(main)", comment: "Worktree picker: marks the main checkout")
        }
        if worktree.isCurrentWorktree == true {
            result += " " + String(localized: "(current)", comment: "Branch picker: marks the branch that is checked out")
        }
        if worktree.isFollowed(followBranch: self.followBranch) {
            result += " ⚡️ " + String(localized: "following", comment: "Worktree picker: marks the worktree that follow mode tracks")
        }
        return result
    }

    private func getCurrentBranch() -> String {
        // Get the actual current branch from GitRepositoryMonitor
        self.gitMonitor.getCachedRepository(for: self.repoPath)?.currentBranch ?? self.selectedBranch
    }

    private func loadGitData() async {
        self.isLoadingBranches = true
        self.isLoadingWorktrees = true

        // Load branches
        let branches = await gitMonitor.getBranches(for: self.repoPath)
        self.availableBranches = branches
        if self.selectedBranch.isEmpty {
            // The base of a new worktree: the branch that is checked out, when it is known.
            let current = self.gitMonitor.getCachedRepository(for: self.repoPath)?.currentBranch
            self.selectedBranch = current.flatMap { branches.contains($0) ? $0 : nil } ?? branches.first ?? ""
        }
        self.isLoadingBranches = false

        // Load worktrees
        await self.worktreeService.fetchWorktrees(for: self.repoPath)
        self.availableWorktrees = self.worktreeService.worktrees

        self.followBranch = self.worktreeService.followBranch

        if let error = worktreeService.error {
            logger.error("Failed to load worktrees: \(error)")
            self.errorMessage = String(localized: "Failed to load worktrees", comment: "Worktree picker: error")
        }
        self.isLoadingWorktrees = false
    }

    private func createWorktree() {
        let trimmedName = self.newBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }

        self.isCreatingWorktree = true
        self.errorMessage = nil

        Task {
            do {
                try await self.onCreateWorktree(trimmedName, self.selectedBranch.isEmpty ? "main" : self.selectedBranch)
                self.isCreatingWorktree = false
                self.showCreateWorktree = false
                self.newBranchName = ""

                // Reload to show new worktree
                await self.loadGitData()
            } catch {
                self.isCreatingWorktree = false
                let reason = error.localizedDescription
                self.errorMessage = String(
                    localized: "Failed to create worktree: \(reason)",
                    comment: "Worktree form: error. Placeholder: reason")
            }
        }
    }
}
