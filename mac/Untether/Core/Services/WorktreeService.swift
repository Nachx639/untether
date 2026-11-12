import Foundation
import Observation
import OSLog

/// Service for managing Git worktrees through the Untether server API
@MainActor
@Observable
final class WorktreeService {
    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "WorktreeService")
    private let serverManager: ServerManager

    private(set) var worktrees: [Worktree] = []
    private(set) var branches: [GitBranch] = []
    /// The branch follow mode tracks in the repository last fetched, nil when it is off.
    ///
    /// 2026-11-11: the server's `followBranch` was decoded and dropped (a `followMode` here
    /// was never set), so the worktree picker never marked the followed worktree.
    private(set) var followBranch: String?
    private(set) var isLoading = false
    private(set) var isLoadingBranches = false
    private(set) var error: Error?

    init(serverManager: ServerManager) {
        self.serverManager = serverManager
    }

    /// Fetch the list of worktrees for a Git repository
    func fetchWorktrees(for gitRepoPath: String) async {
        self.isLoading = true
        self.error = nil

        do {
            let worktreeResponse = try await serverManager.performRequest(
                endpoint: "/api/worktrees",
                method: "GET",
                queryItems: [URLQueryItem(name: "repoPath", value: gitRepoPath)],
                responseType: WorktreeListResponse.self)
            self.apply(worktreeResponse)
        } catch {
            self.error = error
            self.logger.error("Failed to fetch worktrees: \(error.localizedDescription)")
        }

        self.isLoading = false
    }

    func apply(_ response: WorktreeListResponse) {
        self.worktrees = response.worktrees
        self.followBranch = response.followBranch
    }

    /// Create a new worktree
    func createWorktree(
        gitRepoPath: String,
        branch: String,
        worktreePath: String,
        baseBranch: String? = nil)
        async throws
    {
        let request = CreateWorktreeRequest(
            repoPath: gitRepoPath,
            branch: branch,
            path: worktreePath,
            baseBranch: baseBranch)
        try await serverManager.performVoidRequest(
            endpoint: "/api/worktrees",
            method: "POST",
            body: request)

        // Refresh the worktree list
        await self.fetchWorktrees(for: gitRepoPath)
    }

    /// Fetch the list of branches for a Git repository
    func fetchBranches(for gitRepoPath: String) async {
        self.isLoadingBranches = true

        do {
            self.branches = try await self.serverManager.performRequest(
                endpoint: "/api/repositories/branches",
                method: "GET",
                queryItems: [URLQueryItem(name: "path", value: gitRepoPath)],
                responseType: [GitBranch].self)
        } catch {
            self.error = error
            self.logger.error("Failed to fetch branches: \(error.localizedDescription)")
        }

        self.isLoadingBranches = false
    }
}

// MARK: - Error Types

// MARK: - Helper Types
