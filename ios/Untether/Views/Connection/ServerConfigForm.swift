import SwiftUI

/// Form component for entering server connection details.
///
/// Provides input fields for host, port, and name.
struct ServerConfigForm: View {
    @Binding var host: String
    @Binding var port: String
    @Binding var name: String
    let errorMessage: String?
    let onSave: () -> Void
    @State private var networkMonitor = NetworkMonitor.shared

    @FocusState private var focusedField: Field?
    @State private var showingDiscoverySheet = false

    enum Field {
        case host
        case port
        case name
    }

    var body: some View {
        VStack(spacing: Theme.Spacing.extraLarge) {
            // Input Fields
            VStack(spacing: Theme.Spacing.large) {
                // Host/IP Field
                VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                    Label("Server Address", systemImage: "network")
                        .font(Theme.Typography.terminalSystem(size: 12))
                        .foregroundColor(Theme.Colors.primaryAccent)

                    HStack(spacing: Theme.Spacing.small) {
                        TextField("192.168.1.100 or localhost", text: self.$host)
                            .textFieldStyle(TerminalTextFieldStyle())
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .focused(self.$focusedField, equals: .host)
                            .submitLabel(.next)
                            .onSubmit {
                                self.focusedField = .port
                            }

                        Button {
                            self.showingDiscoverySheet = true
                            HapticFeedback.impact(.light)
                        } label: {
                            Image(systemName: "bonjour")
                                .font(.system(size: 16))
                                .foregroundColor(Theme.Colors.primaryAccent)
                                .frame(width: 44, height: 44)
                                .background(
                                    RoundedRectangle(cornerRadius: Theme.CornerRadius.small)
                                        .stroke(Theme.Colors.cardBorder, lineWidth: 1))
                        }
                        .buttonStyle(PlainButtonStyle())
                    }
                }

                // Port Field
                VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                    Label("Port", systemImage: "number.circle")
                        .font(Theme.Typography.terminalSystem(size: 12))
                        .foregroundColor(Theme.Colors.primaryAccent)

                    TextField("4020", text: self.$port)
                        .textFieldStyle(TerminalTextFieldStyle())
                        .keyboardType(.numberPad)
                        .focused(self.$focusedField, equals: .port)
                        .submitLabel(.next)
                        .onSubmit {
                            self.focusedField = .name
                        }
                }

                // Name Field (Optional)
                VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                    Label("Connection Name (Optional)", systemImage: "tag")
                        .font(Theme.Typography.terminalSystem(size: 12))
                        .foregroundColor(Theme.Colors.primaryAccent)

                    TextField("My Mac", text: self.$name)
                        .textFieldStyle(TerminalTextFieldStyle())
                        .focused(self.$focusedField, equals: .name)
                        .submitLabel(.done)
                        .onSubmit {
                            self.focusedField = nil
                            self.onSave()
                        }
                }
            }
            .padding(.horizontal)

            // Error Message
            if let errorMessage {
                HStack(spacing: Theme.Spacing.small) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.caption)
                    Text(errorMessage)
                        .font(Theme.Typography.terminalSystem(size: 12))
                }
                .foregroundColor(Theme.Colors.errorAccent)
                .padding(.horizontal)
                .transition(.asymmetric(
                    insertion: .scale.combined(with: .opacity),
                    removal: .scale.combined(with: .opacity)))
            }

            // Save button (connecting happens from the server list)
            Button(action: {
                HapticFeedback.impact(.medium)
                self.onSave()
            }, label: {
                HStack(spacing: Theme.Spacing.small) {
                    Image(systemName: self.networkMonitor.isConnected ? "plus" : "wifi.slash")
                    Text(self.networkMonitor.isConnected ? "Add Server" : "No Internet Connection")
                }
                .font(Theme.Typography.terminalSystem(size: 16))
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity)
            })
            .foregroundColor(
                self.networkMonitor.isConnected ? Theme.Colors.primaryAccent : Theme.Colors.terminalForeground)
            .padding(.vertical, Theme.Spacing.medium)
            .background(
                RoundedRectangle(cornerRadius: Theme.CornerRadius.medium)
                    .fill(
                        self.networkMonitor.isConnected ? Theme.Colors.terminalBackground : Theme.Colors
                            .cardBackground))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.CornerRadius.medium)
                    .stroke(
                        self.networkMonitor.isConnected ? Theme.Colors.primaryAccent : Theme.Colors.cardBorder,
                        lineWidth: self.networkMonitor.isConnected ? 2 : 1)
                    .opacity(self.host.isEmpty ? 0.5 : 1.0))
            .disabled(self.host.isEmpty || !self.networkMonitor.isConnected)
            .padding(.horizontal)
            .animation(Theme.Animation.quick, value: self.networkMonitor.isConnected)
        }
        .onAppear {
            self.focusedField = .host
        }
        .sheet(isPresented: self.$showingDiscoverySheet) {
            ServerDiscoverySheet(
                selectedHost: self.$host,
                selectedPort: self.$port,
                selectedName: Binding<String?>(
                    get: { self.name.isEmpty ? nil : self.name },
                    set: { self.name = $0 ?? "" }))
        }
    }
}
