import SwiftUI

/// Main settings window with tabbed interface.
///
/// A native macOS Settings window. The window keeps one width and changes height per
/// tab (see ``SettingsTab/preferredHeight``); forms that are taller scroll.
/// The Debug tab only appears when "Show Debug tab" is on in General.
struct SettingsView: View {
    @State private var selectedTab: SettingsTab = .general
    @AppStorage(AppConstants.UserDefaultsKeys.debugMode, store: appDefaults)
    private var debugMode = false

    static let windowWidth: CGFloat = 600

    var body: some View {
        TabView(selection: self.$selectedTab) {
            self.tab(.general) { GeneralSettingsView() }
            self.tab(.sessions) { SessionsSettingsView() }
            self.tab(.notifications) { NotificationSettingsView() }
            self.tab(.dashboard) { DashboardSettingsView() }
            self.tab(.remoteAccess) { RemoteAccessSettingsView() }
            if self.debugMode {
                self.tab(.debug) { DebugSettingsView() }
            }
            self.tab(.about) { AboutView() }
        }
        .frame(width: Self.windowWidth, height: self.selectedTab.preferredHeight)
        .buttonStyle(.dsNeutral)
        .tint(DS.Accent.color)
        .onReceive(NotificationCenter.default.publisher(for: .openSettingsTab)) { notification in
            if let tab = notification.object as? SettingsTab {
                self.selectedTab = tab
            }
        }
        .onChange(of: self.debugMode) { _, isOn in
            if !isOn, self.selectedTab == .debug {
                self.selectedTab = .general
            }
        }
    }

    private func tab(_ tab: SettingsTab, @ViewBuilder content: () -> some View) -> some View {
        content()
            .tabItem { Label(tab.displayName, systemImage: tab.icon) }
            .tag(tab)
    }
}

extension SettingsTab {
    /// Switches an open Settings window to this tab.
    func select() {
        NotificationCenter.default.post(name: .openSettingsTab, object: self)
    }
}

#Preview {
    SettingsView()
}
