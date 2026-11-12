import SwiftUI

/// First onboarding page: what Untether is.
struct WelcomeContentView: View {
    var body: some View {
        OnboardingPage(
            title: "Welcome to Untether",
            subtitle: "Your terminal, untethered. Start agents on your Mac and keep working from any browser.")
        {
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                OnboardingFeature(
                    symbol: "macbook.and.iphone",
                    title: "Freedom",
                    caption: "Pick up any session from your phone, tablet or another computer.")
                OnboardingFeature(
                    symbol: "bolt",
                    title: "No Friction",
                    caption: "Prefix a command with `ut` and it shows up. Nothing to configure per project.")
                OnboardingFeature(
                    symbol: "lock.shield",
                    title: "You're in Control",
                    caption: "Sessions stay on your Mac. You decide who can reach them, and how.")
            }
            .padding(.top, DS.Spacing.s)
        }
    }
}

#Preview {
    WelcomeContentView()
        .frame(width: 640, height: 380)
}
