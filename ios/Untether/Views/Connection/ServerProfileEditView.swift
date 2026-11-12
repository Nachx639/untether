import SwiftUI

/// Form view for editing server profile details.
/// Allows modification of server name, URL, and authentication settings.
struct ServerProfileEditView: View {
    @State var profile: ServerProfile
    let onSave: (ServerProfile, String?) -> Void
    let onDelete: () -> Void

    @State private var password: String = ""
    @State private var showingDeleteConfirmation = false
    @Environment(\.dismiss)
    private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Server Details") {
                    HStack {
                        Text("Icon")
                        Spacer()
                        Image(systemName: self.profile.iconSymbol)
                            .font(.system(size: 24))
                            .foregroundColor(Theme.Colors.primaryAccent)
                    }

                    TextField("Name", text: self.$profile.name)
                    TextField("URL", text: self.$profile.url)

                    Toggle("Requires Authentication", isOn: self.$profile.requiresAuth)

                    if self.profile.requiresAuth {
                        SecureField("Password", text: self.$password)
                            .textContentType(.password)
                    }
                }

                Section {
                    Button(role: .destructive) {
                        self.showingDeleteConfirmation = true
                    } label: {
                        Label("Delete Server", systemImage: "trash")
                            .foregroundColor(.red)
                    }
                }
            }
            .navigationTitle("Edit Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") {
                        self.dismiss()
                    }
                }

                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Save") {
                        self.onSave(self.profile, self.profile.requiresAuth ? self.password : nil)
                        self.dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            .alert("Delete Server?", isPresented: self.$showingDeleteConfirmation) {
                Button("Delete", role: .destructive) {
                    self.onDelete()
                    self.dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Are you sure you want to delete \"\(self.profile.name)\"? This action cannot be undone.")
            }
        }
        .task {
            // Load existing password from keychain
            if self.profile.requiresAuth,
               let existingPassword = try? KeychainService().getPassword(for: profile.id)
            {
                self.password = existingPassword
            }
        }
    }
}
