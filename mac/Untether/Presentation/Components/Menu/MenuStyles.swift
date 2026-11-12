import AppKit
import SwiftUI

/// Common styling constants and modifiers for the Untether menu.
enum MenuStyles {
    static let menuWidth: CGFloat = 400
    /// The session list scrolls past this height.
    static let listMaxHeight: CGFloat = 480
    static let cornerRadius: CGFloat = DS.Radius.medium
    static let smallCornerRadius: CGFloat = DS.Radius.small
    /// Leading/trailing inset of the header, filter and list content. Matches the rows' leading
    /// edge (6pt list inset + 10pt row padding) so the whole popover shares one column.
    static let padding: CGFloat = DS.Spacing.l
    static let animationDuration: Double = 0.15
    static let focusRingWidth: CGFloat = 2

    /// Amber for sessions that wait for the user. Distinct from the orange accent (which marks
    /// work in progress) and readable on light and dark backgrounds.
    static let needsYou = Color(nsColor: .untetherNeedsYou)
    /// Fill and stroke of the needs-you card. Built on the bright brand amber: the dark text amber
    /// of light mode turns muddy beige as a tint.
    static let needsYouFill = Color(nsColor: .untetherNeedsYouFill)

    /// Brand orange for work in progress. Fixed on purpose: `Color.accentColor` follows the user's
    /// system accent (red, pink, graphite...) unless it is Multicolor, which would make "working"
    /// read as an error or as idle. Keep `Color.accentColor` for focus rings only.
    static let working = Color(nsColor: .untetherWorking)

    /// Background of a hovered or keyboard-selected row, like a native list highlight.
    static let rowHighlight = Color.primary.opacity(0.08)

    /// Quiet fill of chips and the filter field.
    static let chipFill = Color.primary.opacity(0.06)
    static let chipFillHovered = Color.primary.opacity(0.11)
    /// Hairline around chips and tags.
    static let hairline = Color.primary.opacity(0.12)

    /// The animation to use, or none when Reduce Motion is on.
    static func animation(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .easeOut(duration: self.animationDuration)
    }
}

extension NSColor {
    /// See `MenuStyles.needsYou`. Also used by the menu-bar badge.
    static var untetherNeedsYou: NSColor {
        NSColor(name: "UntetherNeedsYou") { appearance in
            if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua {
                return NSColor(srgbRed: 1.0, green: 0.78, blue: 0.24, alpha: 1)
            }
            // 4.6:1 on the amber-tinted row and 5.2:1 on the light menu (WCAG AA for small text).
            return NSColor(srgbRed: 0.58, green: 0.34, blue: 0.0, alpha: 1)
        }
    }

    /// See `MenuStyles.needsYouFill`: the brand amber (#FFB000), lighter in light mode so the
    /// card reads amber, not beige. SessionRow picks the opacity per color scheme.
    static var untetherNeedsYouFill: NSColor {
        NSColor(srgbRed: 1.0, green: 0xB0 / 255, blue: 0.0, alpha: 1)
    }

    /// See `MenuStyles.working`: the AccentColor asset's values (#FF6A00, #FF8A1F in Dark Mode).
    static var untetherWorking: NSColor {
        NSColor(name: "UntetherWorking") { appearance in
            if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua {
                return NSColor(srgbRed: 1.0, green: 0.541, blue: 0.122, alpha: 1)
            }
            return NSColor(srgbRed: 1.0, green: 0.416, blue: 0.0, alpha: 1)
        }
    }
}

// MARK: - View Modifiers

extension View {

    /// Applies the keyboard focus ring: the accent color, like the system's own focus ring.
    func menuItemFocus(isFocused: Bool, cornerRadius: CGFloat = MenuStyles.cornerRadius) -> some View {
        self
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(isFocused ? Color.accentColor : Color.clear, lineWidth: MenuStyles.focusRingWidth)
                    .animation(.easeInOut(duration: MenuStyles.animationDuration), value: isFocused))
    }
}

// MARK: - State dot

/// The leading indicator of a session row. Shape differs per state, not just color:
/// needs you = amber filled badge, working = pulsing brand-orange dot, idle = hollow gray ring,
/// shell = small gray square, exited = dashed ring.
struct SessionStateDot: View {
    let state: SessionAgentState

    @Environment(\.accessibilityReduceMotion)
    private var reduceMotion

    var body: some View {
        Group {
            switch self.state {
            case .needsYou:
                Image(systemName: "exclamationmark.circle.fill")
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(MenuStyles.needsYou)
                    .font(.system(size: 13, weight: .semibold))
            case .working:
                Circle()
                    .fill(MenuStyles.working)
                    .frame(width: 8, height: 8)
                    .background(Circle().fill(MenuStyles.working.opacity(0.25)).frame(width: 14, height: 14))
                    .symbolEffectFallbackPulse(isActive: !self.reduceMotion)
            case .idle:
                Circle()
                    .strokeBorder(.secondary, lineWidth: 1.5)
                    .frame(width: 8, height: 8)
            case .shell:
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(.tertiary)
                    .frame(width: 7, height: 7)
            case .exited:
                Circle()
                    .strokeBorder(.tertiary, style: StrokeStyle(lineWidth: 1.2, dash: [2, 1.5]))
                    .frame(width: 8, height: 8)
            }
        }
        .frame(width: 14, height: 14)
        .accessibilityHidden(true)
    }
}

extension View {
    /// A slow breathing opacity for the working dot (off with Reduce Motion).
    fileprivate func symbolEffectFallbackPulse(isActive: Bool) -> some View {
        self.modifier(BreathingModifier(isActive: isActive))
    }
}

private struct BreathingModifier: ViewModifier {
    let isActive: Bool
    @State private var dimmed = false

    func body(content: Content) -> some View {
        content
            .opacity(self.isActive && self.dimmed ? 0.45 : 1)
            .onAppear { self.update() }
            .onChange(of: self.isActive) { _, _ in self.update() }
    }

    private func update() {
        guard self.isActive else {
            self.dimmed = false
            return
        }
        withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
            self.dimmed = true
        }
    }
}

// MARK: - Chips

/// Small capsule naming the program a session runs when it isn't Claude ("codex", "zsh").
struct ToolChip: View {
    let tool: String

    var body: some View {
        Text(self.tool)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(MenuStyles.chipFill))
            // Capped: the tool falls back to any command's basename ("my-long-deploy-script.sh"),
            // and an unbounded chip would push the title line under the hover cluster.
            .frame(maxWidth: 90)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A git branch as a small muted chip: the last path component, tail-truncated.
struct BranchChip: View {
    let branch: String
    var maxWidth: CGFloat = 110

    var body: some View {
        HStack(spacing: 1) {
            Image(systemName: "arrow.triangle.branch")
                .imageScale(.small)
            Text(Self.shortName(self.branch))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(Capsule().fill(MenuStyles.chipFill))
        .frame(maxWidth: self.maxWidth, alignment: .trailing)
        .fixedSize(horizontal: false, vertical: true)
        .help("Branch \(self.branch)")
    }

    /// "wip/loc/menu-polish" -> "…/menu-polish": the last component tells branches apart; the
    /// full name stays in the tooltip.
    static func shortName(_ branch: String) -> String {
        guard let slash = branch.lastIndex(of: "/"), branch.index(after: slash) < branch.endIndex else {
            return branch
        }
        return "…/" + branch[branch.index(after: slash)...]
    }
}

/// Quiet label of a project: "untether", or a house and "Home" for the home folder.
struct ProjectTag: View {
    let label: String
    let branch: String?

    var body: some View {
        HStack(spacing: 4) {
            if self.label == "~" {
                Label("Home", systemImage: "house")
                    .labelStyle(.titleAndIcon)
                    .imageScale(.small)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                Text(self.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let branch, !SessionDisplay.isDefaultBranch(branch) {
                BranchChip(branch: branch, maxWidth: 130)
                    .layoutPriority(-1)
            }
        }
    }
}

// MARK: - Footer button style

/// Footer buttons: a quiet rounded highlight on hover and press, no scaling.
struct MenuFooterButtonStyle: ButtonStyle {
    var isSelected = false

    func makeBody(configuration: Configuration) -> some View {
        MenuFooterButton(configuration: configuration, isSelected: self.isSelected)
    }

    private struct MenuFooterButton: View {
        let configuration: ButtonStyleConfiguration
        let isSelected: Bool
        @State private var isHovering = false
        @Environment(\.accessibilityReduceMotion)
        private var reduceMotion

        var body: some View {
            self.configuration.label
                .font(.callout)
                .labelStyle(MenuFooterLabelStyle())
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: MenuStyles.smallCornerRadius, style: .continuous)
                        .fill(Color.primary.opacity(
                            self.configuration.isPressed ? 0.14 : (self.isHovering || self.isSelected ? 0.08 : 0))))
                .menuItemFocus(isFocused: self.isSelected, cornerRadius: MenuStyles.smallCornerRadius)
                .contentShape(RoundedRectangle(cornerRadius: MenuStyles.smallCornerRadius, style: .continuous))
                .onHover { self.isHovering = $0 }
                .animation(MenuStyles.animation(reduceMotion: self.reduceMotion), value: self.isHovering)
        }
    }
}

/// Icon + title with a fixed icon column, so footer labels line up.
private struct MenuFooterLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon
                .imageScale(.medium)
                .frame(minWidth: 14)
            configuration.title
        }
    }
}
