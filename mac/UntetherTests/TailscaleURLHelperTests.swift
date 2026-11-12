import Foundation
import Testing
@testable import Untether

// 2026-11-11: with Tailscale Serve active the app showed and opened http://<tailscale IP>:<port>
// (plain HTTP past Serve, to a port that behind Serve only listens on 127.0.0.1).
@Suite("Tailscale address shown by the app")
struct TailscaleURLHelperTests {
    private let hostname = "mac.tail1234.ts.net"

    @Test
    func activeServeIsItsHTTPSHostnamePrivateOrPublic() {
        for onLoopback in [true, false] {
            let address = TailscaleURLHelper.address(
                hostname: self.hostname, port: "4020", serveEnabled: true, serveRunning: true,
                serverOnLoopback: onLoopback)
            #expect(address.url?.absoluteString == "https://mac.tail1234.ts.net")
            #expect(address.display == "mac.tail1234.ts.net")
        }
    }

    @Test
    func serveNotRunningYetOpensNothing() {
        let address = TailscaleURLHelper.address(
            hostname: self.hostname, port: "4020", serveEnabled: true, serveRunning: false, serverOnLoopback: true)
        #expect(address.url == nil)
        #expect(address.display == "mac.tail1234.ts.net")
    }

    @Test
    func withoutServeTheTailnetReachesThePortOnlyWhenTheServerListensBeyondThisMac() {
        let network = TailscaleURLHelper.address(
            hostname: self.hostname, port: "4020", serveEnabled: false, serveRunning: false, serverOnLoopback: false)
        #expect(network.url?.absoluteString == "http://mac.tail1234.ts.net:4020")
        #expect(network.display == "mac.tail1234.ts.net:4020")

        let local = TailscaleURLHelper.address(
            hostname: self.hostname, port: "4020", serveEnabled: false, serveRunning: false, serverOnLoopback: true)
        #expect(local.url == nil)
    }

    @Test
    func noAddressIsEverPlainHTTPWhileServeIsOn() {
        for running in [true, false] {
            for onLoopback in [true, false] {
                let address = TailscaleURLHelper.address(
                    hostname: self.hostname, port: "4020", serveEnabled: true, serveRunning: running,
                    serverOnLoopback: onLoopback)
                #expect(address.url?.scheme != "http")
            }
        }
    }
}
