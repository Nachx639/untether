import AppKit
import SwiftUI

/// Sessions settings tab: quick start commands, repository discovery and cleanup.
struct SessionsSettingsView: View {
    @Environment(ConfigManager.self) private var configManager
    @AppStorage(AppConstants.UserDefaultsKeys.cleanupOnStartup, store: appDefaults)
    private var cleanupOnStartup = AppConstants.Defaults.cleanupOnStartup

    var body: some View {
        Form {
            QuickStartSettingsSection()

            RepositorySettingsSection(repositoryBasePath: .init(
                get: { self.configManager.repositoryBasePath },
                set: { self.configManager.updateRepositoryBasePath($0) }))

            Section("Startup") {
                ToggleRow(
                    "Clean Up Ended Sessions",
                    caption: "Remove sessions that ended while Untether was closed.",
                    isOn: self.$cleanupOnStartup)
            }
        }
        .formStyle(.grouped)
    }
}

/// Settings section for managing quick start commands
struct QuickStartSettingsSection: View {
    @Environment(ConfigManager.self) private var configManager
    @State private var selection = Set<QuickStartCommand.ID>()
    @State private var editingCommand: QuickStartCommand?
    @State private var editingName = ""
    @State private var editingCommandText = ""
    @FocusState private var focusedField: Field?
    @FocusState private var isTableFocused: Bool

    private enum Field: Hashable {
        case name
        case command
    }

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                // Native table view
                Table(self.configManager.quickStartCommands, selection: self.$selection) {
                    TableColumn("Name") { command in
                        Group {
                            if self.editingCommand?.id == command.id {
                                TextField("Name", text: self.$editingName)
                                    .labelsHidden()
                                    .textFieldStyle(.plain)
                                    .padding(.horizontal, -3) // Compensate for TextField's internal padding
                                    .focused(self.$focusedField, equals: .name)
                                    .onSubmit {
                                        self.saveEdit()
                                    }
                                    .onExitCommand {
                                        self.cancelEdit()
                                    }
                            } else {
                                Text(command.displayName)
                                    .onTapGesture(count: 2) {
                                        self.startEditing(command)
                                    }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .width(min: 100, ideal: 150, max: 200)

                    TableColumn("Command") { command in
                        Group {
                            if self.editingCommand?.id == command.id {
                                TextField("Command", text: self.$editingCommandText)
                                    .labelsHidden()
                                    .textFieldStyle(.plain)
                                    .font(.body.monospaced())
                                    .padding(.horizontal, -3) // Compensate for TextField's internal padding
                                    .focused(self.$focusedField, equals: .command)
                                    .onSubmit {
                                        self.saveEdit()
                                    }
                                    .onExitCommand {
                                        self.cancelEdit()
                                    }
                            } else {
                                Text(command.command)
                                    .font(.body.monospaced())
                                    .foregroundStyle(.secondary)
                                    .onTapGesture(count: 2) {
                                        self.startEditing(command)
                                    }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .tableStyle(.inset(alternatesRowBackgrounds: true))
                .frame(minHeight: 200)
                .focused(self.$isTableFocused)
                .onDeleteCommand {
                    self.deleteSelected()
                }
                .onKeyPress(.return) {
                    // Don't handle return if we're already editing
                    if self.editingCommand != nil {
                        return .ignored
                    }

                    if let selectedId = selection.first,
                       let command = configManager.quickStartCommands.first(where: { $0.id == selectedId })
                    {
                        self.startEditing(command)
                        return .handled
                    }
                    return .ignored
                }

                // Action buttons
                HStack(spacing: DS.Spacing.xs) {
                    Button(action: self.addCommand) {
                        Label("Add Command", systemImage: "plus")
                            .labelStyle(.iconOnly)
                            .frame(width: 20, height: 20)
                    }
                    .buttonStyle(.accessoryBar)
                    .help("Add Command")

                    Button(action: self.deleteSelected) {
                        Label("Remove Command", systemImage: "minus")
                            .labelStyle(.iconOnly)
                            .frame(width: 20, height: 20)
                    }
                    .buttonStyle(.accessoryBar)
                    .disabled(self.selection.isEmpty)
                    .help("Remove Selected Commands")

                    Spacer()

                    Button("Reset to Defaults") {
                        self.resetToDefaults()
                    }
                    .buttonStyle(.dsText)
                }
            }
        } header: {
            Text("Quick Start Commands")
        } footer: {
            Text("Shown in the New Session form. Double-click a row to edit it.")
        }
    }

    private func startEditing(_ command: QuickStartCommand) {
        self.editingCommand = command
        // Use displayName to handle cases where name is nil
        self.editingName = command.name ?? command.command
        self.editingCommandText = command.command

        // Focus the name field after a brief delay to ensure the TextField is rendered
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            self.focusedField = .name
        }
    }

    private func saveEdit() {
        guard let command = editingCommand else { return }

        let trimmedName = self.editingName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCommand = self.editingCommandText.trimmingCharacters(in: .whitespacesAndNewlines)

        if !trimmedCommand.isEmpty {
            // If name equals command, save as nil (no custom name needed)
            let finalName = (trimmedName.isEmpty || trimmedName == trimmedCommand) ? nil : trimmedName

            self.configManager.updateCommand(
                id: command.id,
                name: finalName,
                command: trimmedCommand)
        }

        self.editingCommand = nil
        self.editingName = ""
        self.editingCommandText = ""
        self.focusedField = nil

        // Restore focus to table after editing
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            self.isTableFocused = true
        }
    }

    private func cancelEdit() {
        self.editingCommand = nil
        self.editingName = ""
        self.editingCommandText = ""
        self.focusedField = nil

        // Restore focus to table after canceling
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            self.isTableFocused = true
        }
    }

    private func addCommand() {
        let newCommand = QuickStartCommand(
            name: nil,
            command: "new-command")
        self.configManager.addCommand(name: newCommand.name, command: newCommand.command)

        // Start editing the new command immediately
        if let addedCommand = configManager.quickStartCommands.last {
            self.startEditing(addedCommand)
        }
    }

    private func deleteSelected() {
        for id in self.selection {
            self.configManager.deleteCommand(id: id)
        }
        self.selection.removeAll()
    }

    private func resetToDefaults() {
        self.configManager.resetToDefaults()
        self.selection.removeAll()
        self.editingCommand = nil
    }
}
