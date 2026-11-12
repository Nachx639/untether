import SwiftUI

/// Onboarding page about following many agent sessions from the menu bar.
struct ControlAgentArmyPageView: View {
    var body: some View {
        OnboardingPage(
            symbol: "list.bullet.rectangle",
            title: "All Your Agents at a Glance",
            subtitle: "Click Untether in the menu bar to see every session, its folder and its Git changes.")
        {
            VStack(spacing: DS.Spacing.s) {
                Text("Give a session a clear title:")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                CodeSnippet("ut title \"Refactoring the auth flow\"")
                    .frame(maxWidth: 400)
            }

            Text(
                "Titles show in the menu bar and in terminal windows. Rename sessions from the dashboard, or let an agent name them for you.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Preview

#Preview("Control Agent Army Page") {
    ControlAgentArmyPageView()
        .frame(width: 640, height: 380)
}
