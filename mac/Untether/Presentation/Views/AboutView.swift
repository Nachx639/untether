import AppKit
import SwiftUI

/// About tab: brand mark, version, project links and license.
struct AboutView: View {
    private static let repositoryURL = URL(string: "https://github.com/Nachx639/untether")
    private static let issuesURL = URL(string: "https://github.com/Nachx639/untether/issues")

    var appName: String {
        Bundle.main.infoDictionary?["CFBundleDisplayName"] as? String ??
            Bundle.main.infoDictionary?["CFBundleName"] as? String ?? "Untether"
    }

    /// "1.2.0 (42)", "1.2.0" without a build number, or nil when the bundle has no version.
    var appVersion: String? {
        guard let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              !version.isEmpty
        else { return nil }
        guard let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String, !build.isEmpty,
              build != version
        else { return version }
        return "\(version) (\(build))"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: DS.Spacing.l) {
                UntetherBrandMark(size: 128)

                VStack(spacing: DS.Spacing.xs) {
                    Text(verbatim: self.appName)
                        .font(.title2.weight(.semibold))
                    if let version = self.appVersion {
                        Text("Version \(version)", comment: "About: app version. Placeholder: version and build number")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                Text("Your terminal, untethered. Run agents on your Mac and steer them from any browser.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)

                HStack(spacing: DS.Spacing.m) {
                    if let url = Self.repositoryURL {
                        Link(destination: url) {
                            Label {
                                Text(verbatim: "GitHub")
                            } icon: {
                                Image(systemName: "chevron.left.forwardslash.chevron.right")
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                    if let url = Self.issuesURL {
                        Link(destination: url) {
                            Label("Report a Problem", systemImage: "exclamationmark.bubble")
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .controlSize(.large)
                // Links stay neutral: About has no primary action to give the accent to.
                .dsNeutralTint()

                Text("Open source under the MIT License. © 2026 Untether.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, DS.Spacing.s)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, DS.Spacing.xl)
            .padding(.vertical, DS.Spacing.xxl)
        }
        .scrollBounceBehavior(.basedOnSize)
        .buttonStyle(.dsNeutral)
        .tint(DS.Accent.color)
    }
}

// MARK: - Preview

#Preview("About View") {
    AboutView()
        .frame(width: 600, height: 440)
}
