import SwiftUI

/// Semantic state shown by badges, callouts and permission rows.
enum StatusKind: Equatable {
    case ok
    case warning
    case error
    case inactive
    case progress
    case info

    var color: Color {
        switch self {
        case .ok: DS.Status.alive
        case .warning: DS.Status.needsYou
        case .error: .red
        case .inactive: .secondary
        case .progress: .secondary
        case .info: .secondary
        }
    }

    /// SF Symbol for the state. `.progress` renders a spinner instead.
    var symbol: String {
        switch self {
        case .ok: "checkmark.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .error: "xmark.octagon.fill"
        case .inactive: "circle.dashed"
        case .progress: "circle.dotted"
        case .info: "info.circle.fill"
        }
    }
}

/// Icon for a `StatusKind`, with a small spinner for `.progress`.
struct StatusIcon: View {
    let kind: StatusKind

    var body: some View {
        if self.kind == .progress {
            ProgressView()
                .controlSize(.small)
        } else {
            Image(systemName: self.kind.symbol)
                .foregroundStyle(self.kind.color)
                .accessibilityHidden(true)
        }
    }
}

/// Compact "icon + text" status, e.g. "Running" with a green check.
struct StatusBadge: View {
    let text: Text
    let kind: StatusKind

    init(text: Text, kind: StatusKind) {
        self.text = text
        self.kind = kind
    }

    /// Literal titles are localized (extracted into Localizable.xcstrings).
    init(_ key: LocalizedStringKey, kind: StatusKind) {
        self.init(text: Text(key), kind: kind)
    }

    /// Strings render verbatim: pass values that are already localized.
    @_disfavoredOverload
    init(_ text: some StringProtocol, kind: StatusKind) {
        self.init(text: Text(text), kind: kind)
    }

    var body: some View {
        HStack(spacing: DS.Spacing.xs) {
            StatusIcon(kind: self.kind)
            self.text
                .foregroundStyle(self.kind == .inactive ? .secondary : .primary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("Status badges") {
    VStack(alignment: .leading, spacing: DS.Spacing.s) {
        StatusBadge("Running", kind: .ok)
        StatusBadge("Not running", kind: .warning)
        StatusBadge("Failed", kind: .error)
        StatusBadge("Not installed", kind: .inactive)
        StatusBadge("Starting", kind: .progress)
        StatusBadge("Info", kind: .info)
    }
    .padding()
}
