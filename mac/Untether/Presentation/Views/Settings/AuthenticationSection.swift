import AppKit
import os.log
import SwiftUI

/// Authentication configuration section for remote access settings
struct AuthenticationSection: View {
    @Binding var authMode: AuthenticationMode
    @Binding var enableSSHKeys: Bool
    let logger: Logger
    let serverManager: ServerManager

    var body: some View {
        Section {
            Picker(selection: self.$authMode) {
                ForEach(AuthenticationMode.allCases, id: \.self) { mode in
                    Text(mode.displayName)
                        .tag(mode)
                }
            } label: {
                Text("Sign-In Method")
                Text(self.authMode.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .pickerStyle(.menu)
            .dsNeutralTint()
            .onChange(of: self.authMode) { _, newValue in
                appDefaults.set(newValue.rawValue, forKey: AppConstants.UserDefaultsKeys.authenticationMode)
                Task {
                    self.logger.info("Authentication mode changed to: \(newValue.rawValue)")
                    // 2026-10-20: a tunnel already up kept publishing the server after the
                    // switch to None; stop every tunnel before restarting without sign-in.
                    if newValue == .none {
                        let stopped = await NoSignInTunnelGuard.stopAllTunnels()
                        if !stopped.isEmpty {
                            self.logger.notice("Sign-in None: stopped tunnels \(stopped.joined(separator: ", "))")
                        }
                    }
                    await self.serverManager.restart()
                }
            }

            if self.authMode == .none {
                // 2026-10-20: the server refuses no sign-in on the network (ServerNetworkPolicy).
                CalloutBox(
                    "With no sign-in, Untether only listens on this Mac (127.0.0.1): network access, Tailscale and tunnels stay off. Choose a sign-in method to reach it from other devices.",
                    kind: .warning)
            }

            if self.authMode == .osAuth || self.authMode == .both {
                CalloutBox("Signs in as \(NSUserName()). SSH keys avoid typing your Mac password in a browser.")
            }

            if self.authMode == .sshKeys || self.authMode == .both {
                SettingRow("SSH Keys", caption: "Add a device's public key to sign in without a password.") {
                    Button("Show in Finder", action: self.openSSHFolder)
                }
            }
        } header: {
            Text("Authentication")
        } footer: {
            Text("Connections from this Mac never need to sign in.")
        }
    }

    private func openSSHFolder() {
        let sshPath = NSHomeDirectory() + "/.ssh"
        if !FileManager.default.fileExists(atPath: sshPath) {
            try? FileManager.default.createDirectory(
                atPath: sshPath,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        }
        NSWorkspace.shared.open(URL(fileURLWithPath: sshPath))
    }
}

#Preview {
    struct PreviewWrapper: View {
        @State var authMode = AuthenticationMode.osAuth
        @State var enableSSHKeys = false

        var body: some View {
            AuthenticationSection(
                authMode: $authMode,
                enableSSHKeys: $enableSSHKeys,
                logger: Logger(subsystem: "preview", category: "auth"),
                serverManager: ServerManager.shared)
                .frame(width: 500)
                .padding()
        }
    }

    return PreviewWrapper()
}
