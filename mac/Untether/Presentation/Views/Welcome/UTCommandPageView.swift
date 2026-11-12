import SwiftUI

/// Onboarding page for the `ut` command line tool.
///
/// Also shown on its own to returning users after an update, so they can update the tool.
struct UTCommandPageView: View {
    /// The CLI installer instance managing the installation process
    var cliInstaller: CLIInstaller
    /// `.cliMaintenance` is the returning-user screen shown after an update.
    var mode: WelcomePresentationMode = .full

    var body: some View {
        OnboardingPage(
            symbol: "terminal",
            title: self.mode == .cliMaintenance ? "Update the Command Line Tool" : "Capture Any Terminal App",
            subtitle: self.mode == .cliMaintenance
                ? "Keep `ut` in step with this version of Untether."
                : "Put `ut` in front of a command and it appears in your dashboard, ready to control from anywhere.")
        {
            CodeSnippet("ut claude")
                .frame(maxWidth: 320)

            self.installState
                .padding(.top, DS.Spacing.xs)

            if let error = cliInstaller.lastError {
                CalloutBox(error, kind: .error)
                    .frame(maxWidth: 380)
            }
        }
        .onAppear {
            self.cliInstaller.checkInstallationStatus()
        }
    }

    @ViewBuilder
    private var installState: some View {
        if self.cliInstaller.isInstalling {
            StatusBadge("Installing…", kind: .progress)
        } else if self.cliInstaller.isInstalled, !self.cliInstaller.isOutdated {
            StatusBadge("Command Line Tool installed", kind: .ok)
        } else {
            VStack(spacing: DS.Spacing.s) {
                if self.cliInstaller.isOutdated {
                    StatusBadge("A newer version is available", kind: .warning)
                }
                Button(self.cliInstaller.isOutdated ? "Update Command Line Tool" : "Install Command Line Tool") {
                    Task {
                        await self.cliInstaller.install()
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                // Secondary: neutral, so Continue stays the only accent on the page.
                .dsNeutralTint()
            }
        }
    }
}

// MARK: - Preview

#Preview("UT Command Page") {
    UTCommandPageView(cliInstaller: CLIInstaller())
        .frame(width: 640, height: 380)
}
