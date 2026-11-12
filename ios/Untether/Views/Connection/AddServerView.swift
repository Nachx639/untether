import SwiftUI

/// View for adding a new server connection
struct AddServerView: View {
    @Environment(\.dismiss)
    private var dismiss

    @State private var networkMonitor = NetworkMonitor.shared
    @State private var viewModel: ConnectionViewModel

    private let profileLogger = Logger(category: "AddServer.Profile")

    let onServerAdded: (ServerProfile) -> Void

    init(
        initialHost: String? = nil,
        initialPort: String? = nil,
        initialName: String? = nil,
        onServerAdded: @escaping (ServerProfile) -> Void)
    {
        // Initialize the view model with initial values
        let vm = ConnectionViewModel()
        if let host = initialHost {
            vm.host = host
        }
        if let port = initialPort {
            vm.port = port
        }
        if let name = initialName {
            vm.name = name
        }
        _viewModel = State(initialValue: vm)
        self.onServerAdded = onServerAdded
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Spacing.extraLarge) {
                    // Header
                    VStack(spacing: Theme.Spacing.medium) {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 60))
                            .foregroundColor(Theme.Colors.primaryAccent)

                        Text("Add New Server")
                            .font(.title2)
                            .fontWeight(.semibold)
                            .foregroundColor(Theme.Colors.terminalForeground)

                        Text("Enter your server details to create a new connection")
                            .font(.body)
                            .foregroundColor(Theme.Colors.secondaryText)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, Theme.Spacing.large)

                    // Server Configuration Form
                    ServerConfigForm(
                        host: self.$viewModel.host,
                        port: self.$viewModel.port,
                        name: self.$viewModel.name,
                        errorMessage: self.viewModel.errorMessage,
                        onSave: self.saveServer)

                    Spacer(minLength: 50)
                }
                .padding()
            }
            .scrollBounceBehavior(.basedOnSize)
            .navigationTitle("New Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") {
                        self.dismiss()
                    }
                }
            }
            .background(Theme.Colors.terminalBackground.ignoresSafeArea())
        }
    }

    private func saveServer() {
        guard self.networkMonitor.isConnected else {
            self.viewModel.errorMessage = "No internet connection available"
            return
        }

        // Create profile from form data
        let hostWithPort = self.viewModel.port.isEmpty ? self.viewModel.host : "\(self.viewModel.host):\(self.viewModel.port)"

        // Add http:// scheme if not present
        let urlString: String = if hostWithPort.hasPrefix("http://") || hostWithPort.hasPrefix("https://") {
            hostWithPort
        } else {
            "http://\(hostWithPort)"
        }

        // Basic URL validation
        guard !self.viewModel.host.isEmpty else {
            self.viewModel.errorMessage = "Please enter a server address"
            return
        }

        // Validate port if provided
        if !self.viewModel.port.isEmpty {
            guard let portNumber = Int(viewModel.port), portNumber > 0, portNumber <= 65535 else {
                self.viewModel.errorMessage = "Invalid port number. Must be between 1 and 65535."
                return
            }
        }

        // The profile is saved without credentials: whether the server asks for a password is
        // found out when connecting, and the login sheet stores it then
        let profile = ServerProfile(
            name: viewModel.name.isEmpty ? ServerProfile.suggestedName(for: urlString) : self.viewModel.name,
            url: urlString)

        guard profile.toServerConfig() != nil else {
            self.viewModel.errorMessage = "Invalid server URL format. Please check the address and port."
            return
        }

        ServerProfile.save(profile)
        self.profileLogger.info("💾 Saved server profile: \(profile.name) (id: \(profile.id))")

        // Notify parent and dismiss
        self.onServerAdded(profile)
        self.dismiss()
    }
}

#Preview {
    AddServerView { _ in }
}
