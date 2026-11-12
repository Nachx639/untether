import Foundation
import Testing
@testable import Untether

// 2026-10-20: with sign-in "None" and a network bind or Tailscale, the server refused to
// start (it allows --no-auth on loopback only) and the app restarted it forever.
@Suite("Server network policy")
struct ServerNetworkPolicyTests {
    @Test
    func noSignInStaysOnThisMac() {
        let policy = ServerNetworkPolicy.resolve(
            authMode: "none",
            bindAddress: "0.0.0.0",
            tailscaleServe: true,
            tailscaleFunnel: true)
        #expect(policy.bindAddress == "127.0.0.1")
        #expect(!policy.tailscaleServe)
        #expect(!policy.tailscaleFunnel)
        #expect(policy.restricted == ["bind 0.0.0.0", "Tailscale Serve", "Tailscale Funnel"])
    }

    @Test
    func signedInSettingsAreKept() {
        let policy = ServerNetworkPolicy.resolve(
            authMode: "os",
            bindAddress: "0.0.0.0",
            tailscaleServe: true,
            tailscaleFunnel: false)
        #expect(policy.tailscaleServe)
        #expect(!policy.tailscaleFunnel)
        #expect(policy.restricted.isEmpty)
        let plain = ServerNetworkPolicy.resolve(
            authMode: "os", bindAddress: "0.0.0.0", tailscaleServe: false, tailscaleFunnel: true)
        #expect(plain == ServerNetworkPolicy(
            bindAddress: "0.0.0.0", tailscaleServe: false, tailscaleFunnel: false, restricted: []))
        let local = ServerNetworkPolicy.resolve(
            authMode: "none", bindAddress: "127.0.0.1", tailscaleServe: false, tailscaleFunnel: false)
        #expect(local.restricted.isEmpty)
    }

    // 2026-11-11: "Locked to this Mac" was a label; the server stayed on the access mode's address.
    @Test
    func behindTailscaleServeTheServerListensOnThisMacOnly() {
        for address in ["0.0.0.0", "192.168.1.50", "::", "fd00::1"] {
            for funnel in [false, true] {
                let policy = ServerNetworkPolicy.resolve(
                    authMode: "os", bindAddress: address, tailscaleServe: true, tailscaleFunnel: funnel)
                #expect(policy.bindAddress == "127.0.0.1", "\(address)")
                #expect(policy.tailscaleServe)
                #expect(policy.tailscaleFunnel == funnel)
            }
        }
        // A loopback address asked for is kept as it is.
        #expect(ServerNetworkPolicy.resolve(
            authMode: "os", bindAddress: "::1", tailscaleServe: true, tailscaleFunnel: false).bindAddress == "::1")
    }

    @Test
    @MainActor
    func serverArgumentsBehindTailscaleServeBindLoopback() {
        let network = ServerNetworkPolicy.resolve(
            authMode: "os", bindAddress: "0.0.0.0", tailscaleServe: true, tailscaleFunnel: false)
        let args = DevServerManager.shared.buildDevServerArguments(
            port: "4021", bindAddress: network.bindAddress, authMode: "os", localToken: nil, network: network)
        #expect(args.firstIndex(of: "--bind").map { args[$0 + 1] } == "127.0.0.1")
        #expect(args.contains("--enable-tailscale-serve"))
    }

    @Test
    func loopbackAddresses() {
        for address in ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost"] {
            #expect(ServerNetworkPolicy.isLoopback(address), "\(address)")
        }
        for address in ["0.0.0.0", "192.168.1.5", "100.64.0.1", "127.0.0", "::"] {
            #expect(!ServerNetworkPolicy.isLoopback(address), "\(address)")
        }
    }

    @Test
    @MainActor
    func devServerArgumentsFollowThePolicy() {
        let network = ServerNetworkPolicy.resolve(
            authMode: "none", bindAddress: "0.0.0.0", tailscaleServe: true, tailscaleFunnel: false)
        let args = DevServerManager.shared.buildDevServerArguments(
            port: "4021", bindAddress: "0.0.0.0", authMode: "none", localToken: nil, network: network)
        #expect(args.contains("--no-auth"))
        #expect(args.firstIndex(of: "--bind").map { args[$0 + 1] } == "127.0.0.1")
        #expect(!args.contains("--enable-tailscale-serve"))
    }
}

// 2026-10-20 guards: tunnels, phone-access notice, restart vs Stop, graceful stop window.
@Suite("No sign-in guards")
struct NoSignInGuardTests {
    @Test
    func phoneAccessNoticeShowsOnceAndOnlyWhenSomethingWasTurnedOff() {
        #expect(NoSignInPhoneAccessNotice.shouldShow(restricted: ["bind 0.0.0.0"], alreadyShown: false))
        #expect(!NoSignInPhoneAccessNotice.shouldShow(restricted: ["Tailscale Serve"], alreadyShown: true))
        #expect(!NoSignInPhoneAccessNotice.shouldShow(restricted: [], alreadyShown: false))
    }

    @Test
    @MainActor
    func tunnelGuardStopsNothingWhenNoTunnelRuns() async {
        let stopped = await NoSignInTunnelGuard.stopAllTunnels()
        #expect(stopped.isEmpty)
    }

    @Test
    func stopDuringRestartWins() {
        #expect(ServerManager.restartMayStart(generationAtStop: 3, current: 3))
        #expect(!ServerManager.restartMayStart(generationAtStop: 3, current: 4))
    }

    @Test
    @MainActor
    func killPathsOutwaitTheServersGracefulShutdown() {
        // The server's graceful shutdown takes up to 6 s.
        #expect(ServerProcess.gracefulStopSeconds > 6)
        #expect(Double(BunServer.wrapperStopPolls) * 0.3 > 6)
        let script = BunServer.wrapperScriptForTesting(command: "true")
        #expect(script.contains("-lt \(BunServer.wrapperStopPolls)"))
    }

    @Test
    func serverSpawnTimeoutExceedsAppleScriptTimeout() {
        // control-unix-handler.ts waits 20 s for terminal.spawn.
        #expect(TerminalLauncher.appleScriptLaunchTimeout + 0.5 < 20)
    }
}

// 2026-11-10: with sign-in "None" and a custom address the server listened on 127.0.0.1 while
// the app's requests and its health probe went to the custom address: the watchdog killed and
// restarted a healthy server forever.
@Suite("Server address the app talks to")
struct ServerListeningAddressTests {
    @Test
    func noSignInIsReachedOnLoopbackWhateverTheAccessMode() {
        for (mode, custom) in [
            (DashboardAccessMode.custom, "192.168.1.50"),
            (.custom, "fd00::1"),
            (.network, nil),
            (.localhost, nil),
        ] {
            let address = ServerManager.listeningAddress(
                mode: mode, customAddress: custom, authMode: "none", tailscaleServe: false)
            #expect(address.value == "127.0.0.1")
            #expect(address.connectableAddress.url(port: "4020", endpoint: "/api/health")?.absoluteString
                == "http://127.0.0.1:4020/api/health")
        }
    }

    @Test
    func signedInKeepsTheConfiguredAddress() {
        let custom = ServerManager.listeningAddress(
            mode: .custom, customAddress: "192.168.1.50", authMode: "os", tailscaleServe: false)
        #expect(custom.value == "192.168.1.50")
        #expect(custom.connectableAddress.url(port: "4020", endpoint: "/api/health")?.absoluteString
            == "http://192.168.1.50:4020/api/health")

        let network = ServerManager.listeningAddress(
            mode: .network, customAddress: nil, authMode: "os", tailscaleServe: false)
        #expect(network.value == "0.0.0.0")
        #expect(network.connectableAddress.value == "127.0.0.1")

        let local = ServerManager.listeningAddress(
            mode: .localhost, customAddress: "192.168.1.50", authMode: "os", tailscaleServe: false)
        #expect(local.value == "127.0.0.1")
    }

    // 2026-11-11: behind Tailscale Serve the server is on 127.0.0.1: requests, the health
    // probe and the address shown follow it there.
    @Test
    func behindTailscaleServeTheAppTalksToLoopback() {
        for (mode, custom) in [(DashboardAccessMode.custom, "192.168.1.50"), (.network, nil), (.localhost, nil)] {
            let address = ServerManager.listeningAddress(
                mode: mode, customAddress: custom, authMode: "os", tailscaleServe: true)
            #expect(address.value == "127.0.0.1")
        }
    }

    @Test
    func theAddressMatchesWhatTheServerIsStartedWith() {
        // BunServer passes ServerNetworkPolicy.current(bindAddress:).bindAddress to --bind.
        for authMode in ["none", "os", "ssh"] {
            for serve in [false, true] {
                for (mode, custom) in [(DashboardAccessMode.custom, "10.0.0.7"), (.network, nil), (.localhost, nil)] {
                    let configured = mode.resolvedBindAddress(customAddress: custom).value
                    let started = ServerNetworkPolicy.resolve(
                        authMode: authMode, bindAddress: configured, tailscaleServe: serve, tailscaleFunnel: true)
                        .bindAddress
                    #expect(ServerManager.listeningAddress(
                        mode: mode, customAddress: custom, authMode: authMode, tailscaleServe: serve)
                        .value == started)
                }
            }
        }
    }
}
