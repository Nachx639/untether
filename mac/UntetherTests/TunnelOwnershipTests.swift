import Foundation
import Testing
@testable import Untether

// 2026-11-10: the tunnels the app runs. ngrok stopped being read once its URL was known (its
// pipe filled and the tunnel stalled) and a start with no URL never timed out; Cloudflare took
// any cloudflared quick tunnel on the Mac for its own and killed it.
@Suite("Tunnels: only ours, never stuck")
struct TunnelOwnershipTests {
    @Test
    func ngrokURLIsReadFromItsJSONLog() {
        #expect(NgrokOutputWatcher.publicURL(
            inLine: #"{"lvl":"info","msg":"started tunnel","url":"https://abc.ngrok.app"}"#) == "https://abc.ngrok.app")
        #expect(NgrokOutputWatcher.publicURL(inLine: #"{"lvl":"info","addr":"https://x.ngrok.app"}"#)
            == "https://x.ngrok.app")
        #expect(NgrokOutputWatcher.publicURL(inLine: #"{"lvl":"info","msg":"join connections"}"#) == nil)
        #expect(NgrokOutputWatcher.publicURL(inLine: "not json") == nil)
    }

    @Test
    func ngrokOutputIsStillTakenAfterTheURL() async throws {
        let watcher = NgrokOutputWatcher()
        // The URL arrives split across two reads, after other lines.
        watcher
            .feed(Data(#"{"msg":"starting"}"#.utf8) + Data("\n".utf8) +
                Data(#"{"msg":"started tunnel","url":"https://abc"#.utf8))
        watcher.feed(Data(#".ngrok.app"}"#.utf8) + Data("\n".utf8))
        #expect(try await watcher.waitForURL(timeout: 5) == "https://abc.ngrok.app")

        // Everything ngrok logs afterwards is accepted and dropped: nothing blocks or grows.
        let line = Data(#"{"msg":"join connections","id":"0123456789abcdef"}"#.utf8) + Data("\n".utf8)
        for _ in 0..<20000 {
            watcher.feed(line)
        }
        watcher.finish()
        #expect(try await watcher.waitForURL(timeout: 5) == "https://abc.ngrok.app")
    }

    @Test
    func ngrokThatNeverPrintsAURLTimesOut() async {
        let watcher = NgrokOutputWatcher()
        watcher.feed(Data(#"{"msg":"waiting for the network"}"#.utf8) + Data("\n".utf8))
        let started = Date()
        do {
            _ = try await watcher.waitForURL(timeout: 0.3)
            Issue.record("expected a timeout")
        } catch {
            #expect(Date().timeIntervalSince(started) < 5)
        }
    }

    @Test
    func ngrokThatExitsWithoutAURLFailsAtOnce() async {
        let watcher = NgrokOutputWatcher()
        watcher.finish()
        do {
            _ = try await watcher.waitForURL(timeout: 30)
            Issue.record("expected a failure")
        } catch {
            // expected, and well before the 30 s
        }
    }

    @Test
    func onlyACloudflaredQuickTunnelIsRecognised() {
        #expect(CloudflareService.isQuickTunnel(
            commandLine: "/opt/homebrew/bin/cloudflared tunnel --url http://localhost:4020"))
        #expect(CloudflareService.isQuickTunnel(commandLine: "cloudflared tunnel --url http://localhost:4020"))
        // A pid reused by something else after a crash is left alone.
        #expect(!CloudflareService.isQuickTunnel(commandLine: "/usr/bin/vim notes-about-cloudflared tunnel --url"))
        #expect(!CloudflareService
            .isQuickTunnel(commandLine: "/opt/homebrew/bin/cloudflared tunnel run my-named-tunnel"))
        #expect(!CloudflareService.isQuickTunnel(commandLine: "/bin/zsh -l"))
        #expect(!CloudflareService.isQuickTunnel(commandLine: nil))
    }

    @Test
    @MainActor
    func aTunnelThisAppDidNotStartIsNotRunningForIt() async {
        // Whatever cloudflared the user runs by hand, the service only reports its own process.
        let service = CloudflareService.shared
        await service.checkCloudflaredStatus()
        #expect(!service.isRunning)
    }
}
