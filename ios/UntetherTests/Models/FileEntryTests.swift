import Foundation
import Testing
@testable import Untether

/// The JSON here is what `GET /api/fs/browse` sends today
/// (`FileInfo` in `web/src/server/routes/filesystem.ts`).
@Suite("FileEntry Tests", .tags(.models))
struct FileEntryTests {
    private let listingJSON = """
    {
      "path": "~/Projects",
      "fullPath": "/Users/test/Projects",
      "gitStatus": {
        "isGitRepo": true,
        "branch": "main",
        "modified": ["README.md"],
        "added": [],
        "deleted": [],
        "untracked": []
      },
      "files": [
        {
          "name": "src",
          "path": "Projects/src",
          "type": "directory",
          "size": 96,
          "modified": "2026-11-09T10:15:30.123Z",
          "permissions": "755",
          "isGitTracked": true,
          "gitStatus": "unchanged",
          "isSymlink": false
        },
        {
          "name": "README.md",
          "path": "Projects/README.md",
          "type": "file",
          "size": 1024,
          "modified": "2026-11-09T10:15:30Z",
          "isGitTracked": true,
          "gitStatus": "modified"
        }
      ]
    }
    """

    @Test("Decodes the server's directory listing")
    func decodesServerListing() throws {
        let listing = try JSONDecoder().decode(DirectoryListing.self, from: Data(self.listingJSON.utf8))

        #expect(listing.absolutePath == "/Users/test/Projects")
        #expect(listing.gitStatus?.branch == "main")
        #expect(listing.files.count == 2)

        let folder = listing.files[0]
        #expect(folder.name == "src")
        #expect(folder.isDir)
        #expect(folder.mode == "755")
        #expect(folder.size == 96)
        #expect(folder.gitStatus == .unchanged)
        #expect(abs(folder.modTime.timeIntervalSince1970 - 1_794_219_330.123) < 0.001)

        let file = listing.files[1]
        #expect(!file.isDir)
        #expect(file.mode.isEmpty)
        #expect(file.gitStatus == .modified)
        #expect(file.modTime.timeIntervalSince1970 == 1_794_219_330)
    }

    @Test("Rejects an entry without a type")
    func rejectsEntryWithoutType() {
        let json = """
        {"name": "a", "path": "a", "size": 1, "modified": "2026-11-09T10:15:30Z"}
        """
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(FileEntry.self, from: Data(json.utf8))
        }
    }
}
