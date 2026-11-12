import SwiftUI

/// Settings → General → Language: picks the interface language and offers a restart,
/// since macOS only applies an app's language at launch.
struct LanguageSettingsSection: View {
    @State private var selection = AppLanguage.selected
    @State private var showRestartConfirmation = false

    private var isPending: Bool {
        self.selection != AppLanguage.launchLanguage
    }

    var body: some View {
        Section {
            Picker(selection: self.$selection) {
                ForEach(AppLanguage.allCases) { language in
                    Text(verbatim: language.displayName)
                        .tag(language)
                    if language == .system {
                        Divider()
                    }
                }
            } label: {
                Text("App Language", comment: "Settings: label of the interface language picker")
                Text(
                    "Untether's menus, windows and notifications.",
                    comment: "Settings: caption under the language picker")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .onChange(of: self.selection) { _, newValue in
                newValue.apply()
            }

            if self.isPending {
                HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
                    Text(
                        "Untether will use the new language after it restarts.",
                        comment: "Settings: shown after choosing a different interface language")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: DS.Spacing.s)
                    Button {
                        self.showRestartConfirmation = true
                    } label: {
                        Text("Restart Untether to Apply", comment: "Settings: button that restarts the app in the new language")
                    }
                }
            }
        } header: {
            Text("Language", comment: "Settings: section header for the interface language")
        }
        .confirmationDialog(
            Text("Restart Untether now?", comment: "Confirmation title before restarting to change language"),
            isPresented: self.$showRestartConfirmation)
        {
            Button(role: .destructive) {
                AppLanguage.relaunch()
            } label: {
                Text("Restart Now", comment: "Confirmation button: restart the app now")
            }
            Button(role: .cancel) {} label: {
                Text("Later", comment: "Confirmation button: keep the current language until the next launch")
            }
        } message: {
            Text(
                "Sessions that aren't shielded will end. Shielded sessions keep running.",
                comment: "Confirmation message before restarting the app. 'Shielded' matches the web app's term for sessions that survive a restart")
        }
    }
}

#Preview {
    Form {
        LanguageSettingsSection()
    }
    .formStyle(.grouped)
    .frame(width: 600, height: 240)
}
