import AppKit
import SwiftUI

// MARK: - Repository Settings Section

struct RepositorySettingsSection: View {
    @Binding var repositoryBasePath: String

    var body: some View {
        Section {
            PathFieldRow(
                title: Text("Projects Folder", comment: "Settings, Sessions: folder where repositories are discovered"),
                caption: Text("Where New Session looks for Git repositories.", comment: "Settings, Sessions: caption of Projects Folder"),
                prompt: Text(verbatim: "~/Projects"),
                path: self.$repositoryBasePath,
                onChoose: self.selectDirectory)
        } header: {
            Text("Repository Discovery")
        }
    }

    private func selectDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: NSString(string: self.repositoryBasePath).expandingTildeInPath)

        if panel.runModal() == .OK, let url = panel.url {
            let path = url.path
            let homeDir = NSHomeDirectory()
            if path.hasPrefix(homeDir) {
                self.repositoryBasePath = "~" + path.dropFirst(homeDir.count)
            } else {
                self.repositoryBasePath = path
            }
        }
    }
}
