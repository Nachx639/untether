import Foundation
import Testing
@testable import Untether

// 2026-11-11: GET /api/worktrees says which branch follow mode tracks (followBranch) and the
// app threw it away, so "following" never showed in the worktree picker.
@Suite("Follow mode in the worktree list")
@MainActor
struct WorktreeFollowBranchTests {
    private static let response = """
    {
      "worktrees": [
        { "path": "/repo", "branch": "refs/heads/main", "HEAD": "abc", "detached": false, "isMainWorktree": true },
        { "path": "/repo-feature", "branch": "refs/heads/feature/x", "HEAD": "def", "detached": false }
      ],
      "baseBranch": "main",
      "followBranch": "feature/x"
    }
    """

    private func decode(_ json: String) throws -> WorktreeListResponse {
        try JSONDecoder().decode(WorktreeListResponse.self, from: Data(json.utf8))
    }

    @Test
    func theServiceKeepsTheFollowBranchTheServerSends() throws {
        let service = WorktreeService(serverManager: ServerManager.shared)
        #expect(service.followBranch == nil)

        try service.apply(self.decode(Self.response))
        #expect(service.followBranch == "feature/x")
        #expect(service.worktrees.count == 2)

        // Follow mode turned off: the next list has no followBranch.
        try service.apply(self.decode(#"{ "worktrees": [], "baseBranch": "main" }"#))
        #expect(service.followBranch == nil)
    }

    @Test
    func theFollowedWorktreeIsTheOneOnThatBranch() throws {
        let worktrees = try self.decode(Self.response).worktrees
        #expect(!worktrees[0].isFollowed(followBranch: "feature/x"))
        #expect(worktrees[1].isFollowed(followBranch: "feature/x"))
        #expect(!worktrees[1].isFollowed(followBranch: nil))
        #expect(!worktrees[1].isFollowed(followBranch: ""))
        #expect(!worktrees[1].isFollowed(followBranch: "feature"))
    }
}
