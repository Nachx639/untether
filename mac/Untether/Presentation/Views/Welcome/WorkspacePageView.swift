import OSLog
import SwiftUI

/// Onboarding page for the preferred terminal and the projects folder.
///
/// The terminal is where Untether opens new sessions; the projects folder is scanned for
/// Git repositories offered in the New Session form and synced to the web UI.
struct WorkspacePageView: View {
    private let configManager = ConfigManager.shared
    private let terminalLauncher = TerminalLauncher.shared

    @AppStorage(AppConstants.UserDefaultsKeys.preferredTerminal, store: appDefaults)
    private var preferredTerminal = Terminal.terminal.rawValue

    @State private var selectedPath = ""
    @State private var discoveredRepos: [RepositoryInfo] = []
    @State private var isScanning = false
    @State private var scanTask: Task<Void, Never>?

    @State private var showingError = false
    @State private var errorTitle = ""
    @State private var errorMessage = ""
    @State private var recoveryPermission: SystemPermission?

    struct RepositoryInfo: Identifiable {
        let id = UUID()
        let name: String
        let path: String
    }

    var body: some View {
        OnboardingPage(
            symbol: "folder.badge.gearshape",
            title: "Make It Yours",
            subtitle: "Choose where new sessions open and where your projects live.")
        {
            VStack(spacing: DS.Spacing.m) {
                HStack(spacing: DS.Spacing.m) {
                    VStack(alignment: .leading, spacing: DS.Spacing.xxs) {
                        Text("Terminal")
                        Text("Where new sessions open.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: DS.Spacing.m)
                    Picker("Terminal", selection: self.$preferredTerminal) {
                        ForEach(Terminal.installed, id: \.rawValue) { terminal in
                            HStack {
                                if let icon = terminal.appIcon {
                                    Image(nsImage: icon.resized(to: NSSize(width: 16, height: 16)))
                                }
                                Text(terminal.displayName)
                            }
                            .tag(terminal.rawValue)
                        }
                    }
                    .pickerStyle(.menu)
                    .dsNeutralTint()
                    .labelsHidden()
                    .fixedSize()

                    Button("Test", action: self.testTerminal)
                        .help("Open a test command in the selected terminal")
                }

                Divider()

                HStack(spacing: DS.Spacing.m) {
                    VStack(alignment: .leading, spacing: DS.Spacing.xxs) {
                        Text("Projects Folder")
                        Text(
                            self.selectedPath.isEmpty
                                ? String(localized: "Not set", comment: "Welcome, workspace page: no projects folder chosen yet")
                                : SessionDisplay.abbreviate(self.selectedPath))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(self.selectedPath)
                        Text(self.repositoryCaption)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: DS.Spacing.m)
                    Button("Choose…", action: self.showFolderPicker)
                }
            }
            .padding(DS.Spacing.l)
            .background(.fill.quaternary, in: .ds(DS.Radius.medium))
            // Test and Choose… are secondary: neutral, so the accent stays on Continue.
            .dsNeutralTint()

            Text("Both can be changed later in Settings.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .alert(self.errorTitle, isPresented: self.$showingError) {
            Button("OK") {}
            if let recoveryPermission = self.recoveryPermission {
                Button("Open System Settings") {
                    if let url = recoveryPermission.settingsURL {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        } message: {
            Text(self.errorMessage)
        }
        .onAppear {
            // Setting the path triggers the scan below
            self.selectedPath = self.configManager.repositoryBasePath
        }
        .onDisappear {
            self.scanTask?.cancel()
            self.isScanning = false
        }
        .onChange(of: self.selectedPath) { _, newValue in
            if newValue != self.configManager.repositoryBasePath {
                self.configManager.updateRepositoryBasePath(newValue)
            }

            // Debounce path changes to prevent rapid successive scans
            self.scanTask?.cancel()
            self.scanTask = Task {
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled, !newValue.isEmpty else { return }
                await self.performScan()
            }
        }
    }

    private var repositoryCaption: String {
        if self.selectedPath.isEmpty {
            return String(localized: "Untether looks here for Git repositories.", comment: "Welcome, workspace page: caption of Projects Folder")
        }
        if self.isScanning {
            return String(localized: "Looking for repositories…", comment: "Welcome, workspace page: scanning the projects folder")
        }
        let count = self.discoveredRepos.count
        if count == 0 {
            return String(localized: "No repositories found.", comment: "Welcome, workspace page: scan result")
        }
        return String(localized: "\(count) repositories found.", comment: "Welcome, workspace page: scan result (plural)")
    }

    private func testTerminal() {
        Task {
            do {
                try self.terminalLauncher
                    .launchCommand(
                        "echo 'Untether Terminal Test: Success! You can now use Untether with your terminal.'")
            } catch {
                let alert = TerminalLaunchAlertContent(
                    error: error,
                    terminalName: Terminal(rawValue: self.preferredTerminal)?.displayName
                        ?? String(localized: "terminal", comment: "Generic name for a terminal app, used inside a sentence"))
                self.errorTitle = alert.title
                self.errorMessage = alert.message
                self.recoveryPermission = alert.recoveryPermission
                self.showingError = true
            }
        }
    }

    private func showFolderPicker() {
        let panel = NSOpenPanel()
        panel.title = String(localized: "Choose Projects Folder", comment: "Folder picker title")
        panel.message = String(localized: "Select the folder where you keep your projects.", comment: "Folder picker message")
        panel.prompt = String(localized: "Choose", comment: "Folder picker: confirm button")
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false

        // Set initial directory
        if !self.selectedPath.isEmpty {
            let expandedPath = (selectedPath as NSString).expandingTildeInPath
            panel.directoryURL = URL(fileURLWithPath: expandedPath)
        } else {
            panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory())
        }

        if panel.runModal() == .OK, let url = panel.url {
            let path = url.path
            let homePath = NSHomeDirectory()

            // Convert to ~/ format if it's in the home directory
            if path.hasPrefix(homePath) {
                self.selectedPath = "~" + path.dropFirst(homePath.count)
            } else {
                self.selectedPath = path
            }
        }
    }

    private func performScan() async {
        await MainActor.run {
            withAnimation(.easeInOut(duration: 0.2)) {
                self.isScanning = true
                self.discoveredRepos = []
            }
        }

        let expandedPath = (selectedPath as NSString).expandingTildeInPath
        let repos = await findGitRepositories(in: expandedPath, maxDepth: 3)

        await MainActor.run {
            withAnimation(.easeInOut(duration: 0.2)) {
                // Always update isScanning to false when done, regardless of cancellation
                if !Task.isCancelled {
                    self.discoveredRepos = repos.map { path in
                        RepositoryInfo(name: URL(fileURLWithPath: path).lastPathComponent, path: path)
                    }
                }
                self.isScanning = false
            }
        }
    }

    private func findGitRepositories(in path: String, maxDepth: Int) async -> [String] {
        var repositories: [String] = []

        // Use a recursive async function that properly checks for cancellation
        func scanDirectory(_ dirPath: String, depth: Int) async {
            // Check for cancellation at each level
            guard !Task.isCancelled else { return }
            guard depth <= maxDepth else { return }

            do {
                let contents = try FileManager.default.contentsOfDirectory(atPath: dirPath)

                for item in contents {
                    // Check for cancellation in the loop
                    try Task.checkCancellation()

                    let fullPath = (dirPath as NSString).appendingPathComponent(item)
                    var isDirectory: ObjCBool = false

                    guard FileManager.default.fileExists(atPath: fullPath, isDirectory: &isDirectory),
                          isDirectory.boolValue else { continue }

                    // Skip hidden directories except .git
                    if item.hasPrefix("."), item != ".git" {
                        continue
                    }

                    // Check if this directory contains .git
                    let gitPath = (fullPath as NSString).appendingPathComponent(".git")
                    if FileManager.default.fileExists(atPath: gitPath) {
                        repositories.append(fullPath)
                    } else {
                        // Recursively scan subdirectories
                        await scanDirectory(fullPath, depth: depth + 1)
                    }
                }
            } catch is CancellationError {
                // Task was cancelled, stop scanning
                return
            } catch let error as NSError
                where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoPermissionError
            {
                // Silently ignore permission errors - common for system directories
            } catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == 1 {
                // Operation not permitted - another common permission error
            } catch {
                // Log unexpected errors for debugging
                Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "WorkspacePageView")
                    .debug("Unexpected error scanning \(dirPath): \(error)")
            }
        }

        // Run the scanning on a lower priority
        await Task(priority: .background) {
            await scanDirectory(path, depth: 0)
        }.value

        return repositories
    }
}

#Preview {
    WorkspacePageView()
        .frame(width: 640, height: 380)
}
