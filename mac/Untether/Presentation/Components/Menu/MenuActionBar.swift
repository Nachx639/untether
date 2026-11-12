import SwiftUI

/// What the keyboard has selected in the menu (arrow keys move it, Return activates it).
enum MenuFocusField: Hashable {
    case sessionRow(String)
    case settingsButton
    case newSessionButton
    case quitButton
}

/// Bottom action bar: New Session (primary), Settings, and a quiet icon-only Quit.
struct MenuActionBar: View {
    @Binding var showingNewSession: Bool
    let selection: MenuFocusField?

    var body: some View {
        HStack(spacing: 2) {
            Button {
                self.showingNewSession = true
            } label: {
                Label("New Session", systemImage: "plus.circle.fill")
            }
            .buttonStyle(MenuFooterButtonStyle(isSelected: self.selection == .newSessionButton))
            .foregroundStyle(.primary)
            .help(Text("New Session (⌘N)", comment: "Menu bar: tooltip of the New Session button, with its shortcut"))

            Button {
                SettingsOpener.openSettings()
            } label: {
                Label("Settings", systemImage: "gearshape")
            }
            .buttonStyle(MenuFooterButtonStyle(isSelected: self.selection == .settingsButton))
            .foregroundStyle(.secondary)
            .help(Text("Settings (⌘,)", comment: "Menu bar: tooltip of the Settings button, with its shortcut"))

            Spacer()

            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                Label(String(localized: "Quit Untether", comment: "Menu bar: Quit button"), systemImage: "power")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(MenuFooterButtonStyle(isSelected: self.selection == .quitButton))
            .foregroundStyle(.secondary)
            .help(Text("Quit Untether (⌘Q)", comment: "Menu bar: tooltip of the Quit button, with its shortcut"))
            .accessibilityLabel(Text("Quit Untether", comment: "Menu bar: Quit button"))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }
}
