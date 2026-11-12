import Foundation
import Testing
@testable import Untether

// Pure lifecycle logic only: nothing here starts a server or touches port 4020.

@Suite("Server lifecycle support")
struct ServerLifecycleSupportTests {
    // MARK: - lsof parsing

    @Test("lsof -Fpc output yields each listener once, without our own PID")
    func parsesListeners() {
        let output = """
        p123
        cnode
        f22
        f23
        p456
        cUntether
        f10
        p789
        ccom.docker.backend
        f5
        """
        let listeners = LsofListenerParser.parse(output, excludingPID: 456)
        #expect(listeners == [
            ListeningProcess(pid: 123, command: "node"),
            ListeningProcess(pid: 789, command: "com.docker.backend"),
        ])
    }

    @Test("Empty lsof output means the port is free")
    func parsesEmptyOutput() {
        #expect(LsofListenerParser.parse("").isEmpty)
        #expect(LsofListenerParser.parse("p42\ncfoo\n", excludingPID: 42).isEmpty)
    }

    // MARK: - Protected processes

    @Test("Browsers and Tailscale are never killed")
    func protectsBrowsersAndTailscale() {
        #expect(ProtectedProcesses.isProtected(name: "tailscaled", path: "/usr/local/bin/tailscaled"))
        #expect(ProtectedProcesses.isProtected(
            name: "Google Chrome Helper",
            path: "/Applications/Google Chrome.app/Contents/Frameworks/x"))
        #expect(ProtectedProcesses.isProtected(name: "com.apple.WebKit.Networking", path: nil))
        #expect(ProtectedProcesses.isProtected(name: "Arc", path: "/Applications/Arc.app/Contents/MacOS/Arc"))
        #expect(ProtectedProcesses.isProtected(name: "Microsoft Edge Helper", path: nil))
        #expect(!ProtectedProcesses.isProtected(name: "node", path: "/opt/homebrew/bin/node"))
        #expect(!ProtectedProcesses.isProtected(name: "untether", path: "/Applications/Untether.app/Contents/Resources/untether"))
        #expect(!ProtectedProcesses.isProtected(name: "search-indexer", path: nil))
    }

    // MARK: - Crash policy

    @Test("Backoff doubles, notifies once, then retries slowly forever")
    func crashPolicyBackoff() {
        var policy = ServerCrashPolicy()
        #expect(policy.recordCrash() == .init(delay: 2, notifyUser: false, isSlowRetry: false))
        #expect(policy.recordCrash() == .init(delay: 4, notifyUser: false, isSlowRetry: false))
        #expect(policy.recordCrash() == .init(delay: 8, notifyUser: false, isSlowRetry: false))
        #expect(policy.recordCrash() == .init(delay: 60, notifyUser: true, isSlowRetry: true))
        #expect(policy.recordCrash() == .init(delay: 60, notifyUser: false, isSlowRetry: true))
        #expect(policy.consecutiveCrashes == 5)
    }

    @Test("Crash counter resets only after five healthy minutes")
    func crashPolicyStableReset() {
        var policy = ServerCrashPolicy()
        _ = policy.recordCrash()
        _ = policy.recordCrash()
        let healthySince = Date(timeIntervalSince1970: 1000)

        policy.recordHealthy(since: healthySince, now: healthySince.addingTimeInterval(299))
        #expect(policy.consecutiveCrashes == 2)

        policy.recordHealthy(since: healthySince, now: healthySince.addingTimeInterval(300))
        #expect(policy.consecutiveCrashes == 0)
        #expect(policy.recordCrash().delay == 2)
    }

    // MARK: - Health watchdog

    @Test("Three consecutive failures after startup mean dead")
    func watchdogThreshold() {
        let start = Date(timeIntervalSince1970: 0)
        var policy = ServerHealthWatchdogPolicy(startedAt: start, startupGrace: 45)
        #expect(policy.record(success: true, now: start.addingTimeInterval(15)) == .healthy)
        #expect(policy.record(success: false, now: start.addingTimeInterval(30)) == .failing(consecutive: 1))
        #expect(policy.record(success: false, now: start.addingTimeInterval(45)) == .failing(consecutive: 2))
        #expect(policy.record(success: true, now: start.addingTimeInterval(60)) == .healthy)
        #expect(policy.record(success: false, now: start.addingTimeInterval(75)) == .failing(consecutive: 1))
        #expect(policy.record(success: false, now: start.addingTimeInterval(90)) == .failing(consecutive: 2))
        #expect(policy.record(success: false, now: start.addingTimeInterval(105)) == .dead)
    }

    @Test("Failures inside the startup grace don't count until the first success")
    func watchdogStartupGrace() {
        let start = Date(timeIntervalSince1970: 0)
        var policy = ServerHealthWatchdogPolicy(startedAt: start, startupGrace: 120)
        #expect(policy.record(success: false, now: start.addingTimeInterval(15)) == .starting)
        #expect(policy.record(success: false, now: start.addingTimeInterval(100)) == .starting)
        #expect(policy.record(success: false, now: start.addingTimeInterval(121)) == .failing(consecutive: 1))
    }

    @Test("healthySince tracks the current healthy streak")
    func watchdogHealthyStreak() {
        let start = Date(timeIntervalSince1970: 0)
        var policy = ServerHealthWatchdogPolicy(startedAt: start, startupGrace: 0)
        _ = policy.record(success: true, now: start.addingTimeInterval(10))
        _ = policy.record(success: true, now: start.addingTimeInterval(25))
        #expect(policy.healthySince == start.addingTimeInterval(10))
        _ = policy.record(success: false, now: start.addingTimeInterval(40))
        #expect(policy.healthySince == nil)
        _ = policy.record(success: true, now: start.addingTimeInterval(55))
        #expect(policy.healthySince == start.addingTimeInterval(55))
    }

    // MARK: - Log classification

    @Test("Server log prefixes decide the level, not words in the message")
    func classifiesByPrefix() {
        let info = "2026-10-12T10:20:30.123Z LOG   [server] cleanup failed sessions: 0 errors"
        let warn = "2026-10-12T10:20:30.123Z WARN  [pty] slow write"
        let error = "2026-10-12T10:20:30.123Z ERROR [cli] boom"
        let debug = "2026-10-12T10:20:30.123Z DEBUG [ws] frame"
        #expect(ServerLogClassifier.level(of: info, isStderr: false, previous: nil) == .info)
        #expect(ServerLogClassifier.level(of: warn, isStderr: true, previous: nil) == .warning)
        #expect(ServerLogClassifier.level(of: error, isStderr: true, previous: nil) == .error)
        #expect(ServerLogClassifier.level(of: debug, isStderr: false, previous: nil) == .debug)
    }

    @Test("ANSI colors are ignored and stack frames inherit the previous level")
    func classifiesColoredAndContinuationLines() {
        let colored = "\u{1B}[90m2026-10-12T10:20:30.123Z\u{1B}[39m \u{1B}[31mERROR\u{1B}[39m \u{1B}[36m[cli]\u{1B}[39m x"
        #expect(ServerLogClassifier.level(of: colored, isStderr: false, previous: nil) == .error)
        #expect(ServerLogClassifier.level(of: "    at main (cli.ts:1:1)", isStderr: false, previous: .error) == .error)
        #expect(ServerLogClassifier.level(of: "Request failed but recovered", isStderr: false, previous: .error) == .info)
        #expect(ServerLogClassifier.level(of: "Unhandled rejection", isStderr: true, previous: .info) == .error)
    }

    // MARK: - Redaction

    @Test("The local auth token never reaches the logs")
    func redactsLocalAuthToken() {
        let command = "'/x/untether' '--port' '4020' '--allow-local-bypass' '--local-auth-token' 'abc-DEF_123' '--bind'"
        let redacted = CommandLineRedactor.redact(command)
        #expect(!redacted.contains("abc-DEF_123"))
        #expect(redacted == "'/x/untether' '--port' '4020' '--allow-local-bypass' '--local-auth-token' <redacted> '--bind'")
        #expect(CommandLineRedactor.redact("pnpm run dev -- --local-auth-token tok123 --no-x") ==
            "pnpm run dev -- --local-auth-token <redacted> --no-x")
        #expect(CommandLineRedactor.redact("--local-auth-token=tok123") == "--local-auth-token=<redacted>")
        #expect(CommandLineRedactor.redact(arguments: ["--local-auth-token", "tok", "--port", "1"]) ==
            ["--local-auth-token", "<redacted>", "--port", "1"])
    }

    @Test("The local auth token never goes on a server command line")
    @MainActor
    func localAuthTokenStaysOffTheCommandLine() {
        // 2026-10-27 (security sweep): `--local-auth-token <token>` showed to every user of the
        // Mac in `ps -ww`, who could then skip the login on 127.0.0.1.
        let token = "tok-\(UUID().uuidString)"
        for mode in ["os", "ssh", "both"] {
            let embedded = BunServer.authArguments(mode: mode)
            #expect(embedded.contains("--allow-local-bypass"), "\(mode)")
            #expect(!embedded.contains("--local-auth-token"), "\(mode)")
            let dev = DevServerManager.shared.buildDevServerArguments(
                port: "4021", bindAddress: "127.0.0.1", authMode: mode, localToken: token)
            #expect(dev.contains("--allow-local-bypass"), "\(mode)")
            #expect(!dev.contains { $0.contains(token) || $0.hasPrefix("--local-auth-token") }, "\(mode)")
        }
        #expect(BunServer.authArguments(mode: "none") == ["--no-auth"])

        var environment = ["PATH": "/usr/bin", LocalAuthTokenEnvironment.key: "inherited"]
        LocalAuthTokenEnvironment.apply(token: token, to: &environment)
        #expect(environment["UNTETHER_LOCAL_AUTH_TOKEN"] == token)
        LocalAuthTokenEnvironment.apply(token: nil, to: &environment)
        #expect(environment["UNTETHER_LOCAL_AUTH_TOKEN"] == nil)
        #expect(environment["PATH"] == "/usr/bin")
    }

    @Test("An orphaned dev server under the system node counts as ours")
    func orphanedDevServerIsManaged() {
        // 2026-10-12: a crashed instance left its dev server on 4020 and the relaunched app
        // called it an external app and stayed "Stopped".
        let devServer = ProcessDetails(
            pid: 4242,
            name: "node",
            path: "/opt/homebrew/Cellar/node/26.10.0_1/bin/node",
            parentPid: 1,
            bundleIdentifier: nil,
            commandLine: "node /Users/me/Projects/untether/web/node_modules/.bin/tsx watch src/cli.ts --port 4020")
        #expect(devServer.isManagedServer)

        let otherNode = ProcessDetails(
            pid: 4343,
            name: "node",
            path: "/opt/homebrew/Cellar/node/26.10.0_1/bin/node",
            parentPid: 1,
            bundleIdentifier: nil,
            commandLine: "node /Users/me/Projects/other/server.js --port 4020")
        #expect(!otherNode.isManagedServer)
    }
}
