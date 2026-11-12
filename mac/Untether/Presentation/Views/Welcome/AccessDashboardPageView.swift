import SwiftUI

/// Final onboarding page: how sign-in works and how to reach Untether from other devices.
struct AccessDashboardPageView: View {
    @AppStorage(AppConstants.UserDefaultsKeys.serverPort, store: appDefaults)
    private var serverPort = "4020"

    var body: some View {
        OnboardingPage(
            symbol: "network",
            title: "Take It Anywhere",
            subtitle: "The dashboard already works on this Mac. Reach it from your phone or laptop with Tailscale (recommended).")
        {
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                OnboardingStep(number: 1, text: "Install Tailscale on this Mac and on your other device.")
                OnboardingStep(number: 2, text: "Sign in to the same Tailscale account on both.")
                OnboardingStep(
                    number: 3,
                    text: "Turn on Serve Over Tailscale in Remote Access, then open the link it shows.")
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            CalloutBox(kind: .info) {
                Text(
                    "Remote devices sign in with your Mac password or an SSH key. Untether never stores your password.")
            }

            HStack(spacing: DS.Spacing.m) {
                Button {
                    if let dashboardURL = DashboardURLBuilder.dashboardURL(port: self.serverPort) {
                        NSWorkspace.shared.open(dashboardURL)
                    }
                } label: {
                    Label("Open Dashboard", systemImage: "safari")
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                // Secondary: neutral, so the accent stays on the primary button.
                .dsNeutralTint()

                Button("Tailscale Guide") {
                    if let tailscaleURL = URL(string: URLConstants.tailscaleInstallGuide) {
                        NSWorkspace.shared.open(tailscaleURL)
                    }
                }
                .buttonStyle(.dsText)
            }
        }
    }
}

// MARK: - Preview

#Preview("Access Dashboard Page") {
    AccessDashboardPageView()
        .frame(width: 640, height: 380)
}
