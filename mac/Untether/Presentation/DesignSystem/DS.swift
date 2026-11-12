import SwiftUI

/// Untether design tokens.
///
/// Everything visual in Settings, Welcome and About is built from these values plus
/// system text styles and semantic colors, so the UI follows Dark Mode, Increase Contrast
/// and Dynamic Type without per-view tweaks.
enum DS {
    /// Spacing scale (points).
    enum Spacing {
        static let xxs: CGFloat = 2
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
    }

    /// Corner radii. Always used with `.continuous` corners.
    enum Radius {
        static let small: CGFloat = 6
        static let medium: CGFloat = 10
        static let large: CGFloat = 14
    }

    /// Brand colors. The accent is `DS.Accent.color` (#FF6A00, #FF8A1F in Dark Mode), fixed so
    /// it never follows the system accent.
    enum Brand {
        /// Gradient partner for the accent (#FFB000).
        static let amber = Color(red: 1.0, green: 0xB0 / 255, blue: 0)

        /// The icon gradient: accent at the bottom leading corner, amber at the top trailing one.
        static var gradient: LinearGradient {
            LinearGradient(
                colors: [DS.Accent.color, amber],
                startPoint: .bottomLeading,
                endPoint: .topTrailing)
        }
    }
}

extension Shape where Self == RoundedRectangle {
    /// A continuous rounded rectangle using a design-system radius.
    static func ds(_ radius: CGFloat) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
    }
}

// MARK: - Shared Calm-control tokens (Mac windows)

extension DS {
    /// The brand accent, fixed. `Color.accentColor` follows the system accent (red on some Macs)
    /// unless that is Multicolor. Apply this with `.tint(DS.Accent.color)` at every window root.
    enum Accent {
        static let color = Color(nsColor: .untetherWorking)
    }

    /// Status colours, reused from the menu-bar widget.
    enum Status {
        /// Amber: only "needs you" and warnings.
        static let needsYou = Color(nsColor: .untetherNeedsYou)
        /// Running, connected, granted.
        static let alive = Color.green
    }
}

/// Quiet text action ("Test Terminal", "Reset to Defaults", "Install Tailscale", "Retry").
///
/// Replaces `.buttonStyle(.link)`, which is always system blue.
struct DSTextButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout)
            .foregroundStyle(.tint)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == DSTextButtonStyle {
    /// Accent-coloured text action without an underline.
    static var dsText: DSTextButtonStyle {
        .init()
    }
}

/// The system push button, kept neutral under the window's accent tint.
///
/// `.tint(DS.Accent.color)` at a window root turns every default and `.bordered` button
/// orange in a key window, which breaks "accent once per view". Window roots set
/// `.buttonStyle(.dsNeutral)` so unstyled buttons stay grey; buttons that pick a style
/// explicitly (`.borderedProminent`, `.dsText`, `.borderless`) are unaffected.
struct DSNeutralButtonStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button(configuration)
            .buttonStyle(.automatic)
            .tint(nil)
    }
}

extension PrimitiveButtonStyle where Self == DSNeutralButtonStyle {
    /// The default push button without the window accent.
    static var dsNeutral: DSNeutralButtonStyle {
        .init()
    }
}

extension View {
    /// Keeps an explicit `.bordered` button (or a group of them) neutral under the
    /// window's accent tint. Use instead of ad-hoc `.tint(nil)` / `.tint(.primary)`.
    func dsNeutralTint() -> some View {
        self.tint(nil)
    }
}

extension DS {
    /// Coarse times for windows ("5 min ago"), in the app's language. Never ticks
    /// every second.
    enum Time {
        /// "just now", "5 min ago", "2 h ago", "3 d ago".
        static func ago(_ date: Date, now: Date = Date()) -> String {
            let elapsed = max(0, now.timeIntervalSince(date))
            switch elapsed {
            case ..<60:
                return String(localized: "just now", comment: "Relative time: less than a minute ago")
            case ..<3600:
                let minutes = Int(elapsed / 60)
                return String(localized: "\(minutes) min ago", comment: "Relative time in minutes, abbreviated")
            case ..<86400:
                let hours = Int(elapsed / 3600)
                return String(localized: "\(hours) h ago", comment: "Relative time in hours, abbreviated")
            default:
                let days = Int(elapsed / 86400)
                return String(localized: "\(days) d ago", comment: "Relative time in days, abbreviated")
            }
        }

        /// "Oct 12, 2026 at 9:03 AM", in the user's time zone and the app's language. For `.help`.
        static func full(_ date: Date) -> String {
            date.formatted(date: .abbreviated, time: .shortened)
        }
    }
}
