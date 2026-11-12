import SwiftUI

enum WelcomePresentationMode: Equatable {
    case full
    case cliMaintenance

    static func automatic(storedWelcomeVersion: Int) -> Self {
        storedWelcomeVersion == 0 ? .full : .cliMaintenance
    }

    var pageCount: Int {
        switch self {
        case .full:
            WelcomePage.allCases.count
        case .cliMaintenance:
            1
        }
    }

    var showsPageIndicators: Bool {
        self == .full
    }

    var settingsTabOnFinish: SettingsTab? {
        switch self {
        case .full:
            .remoteAccess
        case .cliMaintenance:
            nil
        }
    }
}

/// Pages of the full onboarding flow, in order.
enum WelcomePage: Int, CaseIterable {
    /// What Untether is
    case intro
    /// Install the `ut` command line tool
    case commandLineTool
    /// Automation, Accessibility and Notifications
    case permissions
    /// Preferred terminal and projects folder
    case workspace
    /// Sessions in the menu bar, `ut title`
    case sessions
    /// Sign-in and remote access
    case remoteAccess
}

/// Welcome onboarding view for first-time users.
///
/// Presents either the full onboarding flow (``WelcomePage``) or, for returning users
/// after an update, only the command line tool page. A compact brand header stays fixed
/// while pages slide underneath; each page scrolls if its content is taller than the page area.
struct WelcomeView: View {
    let mode: WelcomePresentationMode

    @State private var currentPage = 0
    @State private var isMovingForward = true
    @Environment(\.dismiss)
    private var dismiss
    @Environment(\.accessibilityReduceMotion)
    private var reduceMotion
    @AppStorage(AppConstants.UserDefaultsKeys.welcomeVersion, store: appDefaults)
    private var welcomeVersion = 0
    @State private var cliInstaller = CLIInstaller()

    private enum Layout {
        static let width: CGFloat = 640
        static let pageHeight: CGFloat = 380
        static let brandSize: CGFloat = 64
    }

    init(mode: WelcomePresentationMode = .full) {
        self.mode = mode
    }

    var body: some View {
        VStack(spacing: 0) {
            UntetherBrandMark(size: Layout.brandSize)
                .padding(.top, DS.Spacing.xxl)
                .padding(.bottom, DS.Spacing.xs)

            self.page
                .id(self.currentPage)
                .transition(self.pageTransition)
                .frame(maxWidth: .infinity)
                .frame(height: Layout.pageHeight)
                .clipped()

            Divider()

            self.navigationBar
        }
        .frame(width: Layout.width)
        .background(.background)
        .buttonStyle(.dsNeutral)
        .tint(DS.Accent.color)
        .onAppear {
            self.currentPage = 0
        }
        .onDisappear {
            // Safety net: make sure permission monitoring stops when the window closes
            SystemPermissionManager.shared.unregisterFromMonitoring()
        }
    }

    // MARK: - Pages

    @ViewBuilder
    private var page: some View {
        if self.mode == .cliMaintenance {
            UTCommandPageView(cliInstaller: self.cliInstaller, mode: .cliMaintenance)
        } else {
            switch WelcomePage(rawValue: self.currentPage) ?? .intro {
            case .intro:
                WelcomeContentView()
            case .commandLineTool:
                UTCommandPageView(cliInstaller: self.cliInstaller)
            case .permissions:
                RequestPermissionsPageView()
            case .workspace:
                WorkspacePageView()
            case .sessions:
                ControlAgentArmyPageView()
            case .remoteAccess:
                AccessDashboardPageView()
            }
        }
    }

    private var pageTransition: AnyTransition {
        if self.reduceMotion {
            return .opacity
        }
        return .asymmetric(
            insertion: .move(edge: self.isMovingForward ? .trailing : .leading).combined(with: .opacity),
            removal: .move(edge: self.isMovingForward ? .leading : .trailing).combined(with: .opacity))
    }

    // MARK: - Navigation

    private var navigationBar: some View {
        HStack(spacing: DS.Spacing.l) {
            Button(action: self.goBack) {
                Label(String(localized: "Back", comment: "Welcome: button to the previous page"), systemImage: "chevron.backward")
            }
            .opacity(self.currentPage > 0 ? 1 : 0)
            .disabled(self.currentPage == 0)
            .accessibilityHidden(self.currentPage == 0)
            .help("Previous page")
            // Secondary: neutral, so the accent stays on Continue only.
            .dsNeutralTint()
            .frame(minWidth: 96, alignment: .leading)

            Spacer()

            if self.mode.showsPageIndicators {
                HStack(spacing: DS.Spacing.s) {
                    ForEach(0..<self.mode.pageCount, id: \.self) { index in
                        Button {
                            self.go(to: index)
                        } label: {
                            Circle()
                                .fill(index == self.currentPage ? AnyShapeStyle(.tint) : AnyShapeStyle(.quaternary))
                                .frame(width: 8, height: 8)
                                .padding(DS.Spacing.xs)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Page \(index + 1) of \(self.mode.pageCount)")
                        .accessibilityAddTraits(index == self.currentPage ? .isSelected : [])
                    }
                }
            }

            Spacer()

            Button(action: self.goNext) {
                Text(self.primaryButtonTitle)
                    .frame(minWidth: 72)
            }
            .keyboardShortcut(.defaultAction)
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(minWidth: 96, alignment: .trailing)
        }
        .padding(.horizontal, DS.Spacing.xl)
        .padding(.vertical, DS.Spacing.l)
    }

    /// On the last page of the full flow, Finish opens Remote Access, so it says so.
    private var primaryButtonTitle: LocalizedStringKey {
        guard self.isLastPage else { return "Continue" }
        return self.mode.settingsTabOnFinish == .remoteAccess ? "Set Up Remote Access" : "Finish"
    }

    private var isLastPage: Bool {
        self.currentPage == self.mode.pageCount - 1
    }

    private func go(to index: Int) {
        guard index != self.currentPage, (0..<self.mode.pageCount).contains(index) else { return }
        self.isMovingForward = index > self.currentPage
        withAnimation(.smooth(duration: 0.35)) {
            self.currentPage = index
        }
    }

    private func goBack() {
        self.go(to: self.currentPage - 1)
    }

    private func goNext() {
        guard self.isLastPage else {
            self.go(to: self.currentPage + 1)
            return
        }

        self.welcomeVersion = AppConstants.currentWelcomeVersion
        self.dismiss()

        if let settingsTab = mode.settingsTabOnFinish {
            // Open settings after a delay to ensure the window is fully closed
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(200))
                SettingsOpener.openSettingsTab(settingsTab)
            }
        }
    }
}

// MARK: - Preview

#Preview("Welcome View") {
    WelcomeView()
        .environment(SystemPermissionManager.shared)
}
