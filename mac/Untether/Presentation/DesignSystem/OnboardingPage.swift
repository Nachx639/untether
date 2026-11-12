import SwiftUI

/// Layout shared by every Welcome page: optional symbol, title, subtitle, page content.
///
/// Content is centred vertically in the page area and scrolls when it is taller than
/// the page, so nothing clips at larger text sizes. Title and subtitle accept Markdown,
/// so a command such as `ut` can be set apart as code.
///
/// The accent is reserved for the window's primary button and the current page dot,
/// so everything here stays neutral.
struct OnboardingPage<Content: View>: View {
    let symbol: String?
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey
    let content: Content

    init(
        symbol: String? = nil,
        title: LocalizedStringKey,
        subtitle: LocalizedStringKey,
        @ViewBuilder content: () -> Content)
    {
        self.symbol = symbol
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: DS.Spacing.l) {
                    VStack(spacing: DS.Spacing.s) {
                        if let symbol = self.symbol {
                            Image(systemName: symbol)
                                .font(.title2)
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(.secondary)
                                .accessibilityHidden(true)
                        }

                        Text(self.title)
                            .font(.title.weight(.semibold))
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.isHeader)

                        Text(self.subtitle)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    self.content
                }
                .frame(maxWidth: 460)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, DS.Spacing.xl)
                .padding(.vertical, DS.Spacing.l)
                .frame(minHeight: proxy.size.height, alignment: .center)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

/// A numbered step used in onboarding instructions.
struct OnboardingStep: View {
    let number: Int
    let text: LocalizedStringKey

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
            Text(verbatim: String(self.number))
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
                .background(Circle().fill(.fill.tertiary))
                .accessibilityHidden(true)

            Text(self.text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            Text("Step \(self.number):", comment: "VoiceOver: prefix before a numbered onboarding step")
                + Text(verbatim: " ") + Text(self.text))
    }
}

/// A symbol + title + caption line used for feature lists in onboarding.
struct OnboardingFeature: View {
    let symbol: String
    let title: LocalizedStringKey
    let caption: LocalizedStringKey

    var body: some View {
        HStack(alignment: .top, spacing: DS.Spacing.m) {
            Image(systemName: self.symbol)
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: DS.Spacing.xxs) {
                Text(self.title)
                    .font(.body.weight(.medium))
                Text(self.caption)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    OnboardingPage(symbol: "terminal", title: "Capture Any Terminal App", subtitle: "Prefix a command with `ut`.") {
        CodeSnippet("ut claude")
        OnboardingStep(number: 1, text: "Install the tool.")
    }
    .frame(width: 640, height: 380)
}
