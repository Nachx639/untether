import CoreGraphics
import Foundation

/// Represents the available tabs in the Settings window.
///
/// Each tab corresponds to a different configuration area of Untether,
/// with associated display names, SF Symbol icons and preferred window heights.
enum SettingsTab: String, CaseIterable {
    case general
    case sessions
    case notifications
    case dashboard
    case remoteAccess
    case debug
    case about

    var displayName: String {
        switch self {
        case .general: String(localized: "settings.tab.general", defaultValue: "General", comment: "Settings tab name")
        case .sessions: String(localized: "settings.tab.sessions", defaultValue: "Sessions", comment: "Settings tab name")
        case .notifications:
            String(localized: "settings.tab.notifications", defaultValue: "Notifications", comment: "Settings tab name")
        // The case keeps its `dashboard` id so deep links still work; the tab shows the server.
        case .dashboard: String(localized: "settings.tab.server", defaultValue: "Server", comment: "Settings tab name")
        case .remoteAccess:
            String(localized: "settings.tab.remoteAccess", defaultValue: "Remote Access", comment: "Settings tab name")
        case .debug: String(localized: "settings.tab.debug", defaultValue: "Debug", comment: "Settings tab name")
        case .about: String(localized: "settings.tab.about", defaultValue: "About", comment: "Settings tab name")
        }
    }

    var icon: String {
        switch self {
        case .general: "gearshape"
        case .sessions: "terminal"
        case .notifications: "bell"
        case .dashboard: "server.rack"
        case .remoteAccess: "network"
        case .debug: "ladybug"
        case .about: "info.circle"
        }
    }

    /// Height the Settings window takes for this tab. Longer forms scroll.
    var preferredHeight: CGFloat {
        switch self {
        case .general: 680
        case .sessions: 560
        case .notifications: 600
        case .dashboard: 600
        case .remoteAccess: 680
        case .debug: 560
        case .about: 440
        }
    }
}

extension Notification.Name {
    static let openSettingsTab = Notification.Name("openSettingsTab")
}
