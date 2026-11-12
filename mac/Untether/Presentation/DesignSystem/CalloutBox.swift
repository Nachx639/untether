import SwiftUI

/// An inline note: icon tinted by kind, secondary text, quiet fill.
///
/// Replaces hand-made `Color.x.opacity(0.1)` boxes; the fill adapts to Dark Mode.
/// Text inside is secondary; buttons keep their own style (use `.dsText`).
struct CalloutBox<Content: View>: View {
    let kind: StatusKind
    let content: Content

    init(kind: StatusKind = .info, @ViewBuilder content: () -> Content) {
        self.kind = kind
        self.content = content()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
            StatusIcon(kind: self.kind)
            VStack(alignment: .leading, spacing: DS.Spacing.xs) {
                self.content
            }
            .font(.callout)
            // Secondary for text; `.dsText` buttons set their own `.tint` foreground on top.
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, DS.Spacing.m)
        .padding(.vertical, DS.Spacing.s)
        .background(.fill.quaternary, in: .ds(DS.Radius.small))
        .accessibilityElement(children: .combine)
    }
}

extension CalloutBox where Content == Text {
    /// Literal messages are localized (extracted into Localizable.xcstrings).
    init(_ message: LocalizedStringKey, kind: StatusKind = .info) {
        self.init(kind: kind) { Text(message) }
    }

    /// Strings render verbatim: pass values that are already localized.
    @_disfavoredOverload
    init(_ message: some StringProtocol, kind: StatusKind = .info) {
        self.init(kind: kind) { Text(message) }
    }
}

#Preview {
    VStack {
        CalloutBox("Your sessions are reachable from the public internet.", kind: .warning)
        CalloutBox("Tailscale Serve will start when Tailscale is running.")
        CalloutBox("Port 4020 is used by node.", kind: .error)
    }
    .padding()
    .frame(width: 420)
}
