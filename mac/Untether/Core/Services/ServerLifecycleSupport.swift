import Foundation

// Pure policies and parsers used by the server lifecycle (BunServer, ServerManager,
// PortConflictResolver). Kept free of side effects so they can be unit tested.

// MARK: - Server log classification

/// Log level of one line of server output.
enum ServerLogLevel: Equatable {
    case debug
    case info
    case warning
    case error
}

/// Classifies server output lines by the level prefix the server's logger writes
/// (`<ISO timestamp> ERROR|WARN|LOG|DEBUG [module] message`, see web/src/server/utils/logger.ts),
/// instead of guessing from words like "error" or "failed" in the message.
enum ServerLogClassifier {
    /// Returns the level a line's own prefix declares, or nil for an unprefixed line.
    static func prefixedLevel(of line: String) -> ServerLogLevel? {
        let plain = self.stripANSI(line)
        let tokens = plain.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
        guard tokens.count >= 2, self.looksLikeTimestamp(tokens[0]) else { return nil }
        switch tokens[1] {
        case "ERROR": return .error
        case "WARN": return .warning
        case "DEBUG": return .debug
        case "LOG", "INFO": return .info
        default: return nil
        }
    }

    /// Level for a line. Indented continuation lines (stack frames of a multi-line message)
    /// inherit the previous line's level; other unprefixed lines are errors on stderr
    /// (uncaught exceptions, the wrapper's exit message) and info on stdout.
    static func level(of line: String, isStderr: Bool, previous: ServerLogLevel?) -> ServerLogLevel {
        if let level = self.prefixedLevel(of: line) {
            return level
        }
        if let previous, let first = line.first, first == " " || first == "\t" {
            return previous
        }
        return isStderr ? .error : .info
    }

    static func stripANSI(_ line: String) -> String {
        guard line.contains("\u{1B}[") else { return line }
        return line.replacingOccurrences(
            of: "\u{1B}\\[[0-9;]*[A-Za-z]",
            with: "",
            options: .regularExpression)
    }

    private static func looksLikeTimestamp(_ token: Substring) -> Bool {
        // 2026-10-12T10:20:30.123Z
        token.count >= 19 && token.first?.isNumber == true && token.contains("T") && token.contains(":")
    }
}

// MARK: - Local auth token

/// How the server gets the token that skips the login on localhost.
///
/// 2026-10-27 (security sweep): it went as `--local-auth-token <token>`, which every user of the
/// Mac reads with `ps -ww`, then sends to 127.0.0.1 for a shell. It goes in the server's
/// environment instead (macOS shows that to its own user only); the server removes it from its
/// own environment at startup (web/src/server/utils/local-auth-token.ts).
enum LocalAuthTokenEnvironment {
    static let key = "UNTETHER_LOCAL_AUTH_TOKEN"

    /// Sets the token for the server process, or removes any inherited one when there is none.
    static func apply(token: String?, to environment: inout [String: String]) {
        environment[self.key] = token
    }
}

// MARK: - Secret redaction

/// Removes secrets from command lines before they are logged.
enum CommandLineRedactor {
    static let secretFlags = ["--local-auth-token"]

    static func redact(_ commandLine: String) -> String {
        var result = commandLine
        for flag in self.secretFlags {
            // --local-auth-token value | '--local-auth-token' 'value' | --local-auth-token=value
            let pattern = NSRegularExpression.escapedPattern(for: flag) + "(['\"]?)(=|\\s+)('[^']*'|\"[^\"]*\"|\\S+)"
            result = result.replacingOccurrences(
                of: pattern,
                with: "\(flag)$1$2<redacted>",
                options: .regularExpression)
        }
        return result
    }

    static func redact(arguments: [String]) -> [String] {
        var redacted = arguments
        for index in redacted.indices where index > 0 && self.secretFlags.contains(redacted[index - 1]) {
            redacted[index] = "<redacted>"
        }
        return redacted.map { argument in
            self.secretFlags.contains { argument.hasPrefix("\($0)=") } ? self.redact(argument) : argument
        }
    }
}

// MARK: - lsof listener parsing

/// A process holding a TCP port in LISTEN state.
struct ListeningProcess: Equatable {
    let pid: Int
    let command: String
}

/// Parses `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` output (one `p<pid>` line per process,
/// followed by `c<command>` and per-file `f<fd>` lines).
enum LsofListenerParser {
    static func parse(_ output: String, excludingPID ownPID: Int? = nil) -> [ListeningProcess] {
        var results: [ListeningProcess] = []
        var currentPID: Int?
        var currentCommand: String?

        func flush() {
            if let pid = currentPID, pid != ownPID, !results.contains(where: { $0.pid == pid }) {
                results.append(ListeningProcess(pid: pid, command: currentCommand ?? ""))
            }
        }

        for rawLine in output.split(whereSeparator: \.isNewline) {
            guard let tag = rawLine.first else { continue }
            let value = String(rawLine.dropFirst())
            switch tag {
            case "p":
                flush()
                currentPID = Int(value)
                currentCommand = nil
            case "c":
                currentCommand = value
            default:
                continue
            }
        }
        flush()
        return results
    }
}

// MARK: - Processes that must never be killed

enum ProtectedProcesses {
    /// Never kill these even if they hold our port: browsers (and their helpers) and Tailscale.
    private static let protectedNameFragments = [
        "tailscale", "ipnextension", "chrome", "chromium", "safari", "webkit", "firefox",
        "arc", "brave", "edge", "opera", "vivaldi", "orion",
    ]

    static func isProtected(name: String, path: String?) -> Bool {
        let haystacks = [name.lowercased(), (path ?? "").lowercased()]
        for fragment in self.protectedNameFragments {
            for haystack in haystacks where haystack.contains(fragment) {
                // "arc"/"edge" are short: only match them as a whole word or app bundle name
                if fragment == "arc" || fragment == "edge" {
                    if haystack == fragment || haystack.contains("/\(fragment).app/") ||
                        haystack.contains("microsoft edge") || haystack.hasPrefix("\(fragment) ")
                    {
                        return true
                    }
                    continue
                }
                return true
            }
        }
        return false
    }
}

// MARK: - Crash restart policy

/// Decides how to react to consecutive server crashes.
///
/// The crash counter only resets after the server has passed health checks for
/// `stableRunDuration` (a successful start alone proves nothing: a server that dies
/// a minute after every start used to loop forever). After `maxFastRetries` the
/// policy keeps retrying slowly instead of giving up for good.
struct ServerCrashPolicy: Equatable {
    struct Decision: Equatable {
        let delay: TimeInterval
        /// True exactly once, when fast retries run out: tell the user.
        let notifyUser: Bool
        /// True while in the slow-retry phase.
        let isSlowRetry: Bool
    }

    var maxFastRetries = 3
    var baseDelay: TimeInterval = 2
    var slowRetryDelay: TimeInterval = 60
    var stableRunDuration: TimeInterval = 300

    private(set) var consecutiveCrashes = 0

    mutating func recordCrash() -> Decision {
        self.consecutiveCrashes += 1
        if self.consecutiveCrashes <= self.maxFastRetries {
            let delay = self.baseDelay * pow(2, Double(self.consecutiveCrashes - 1))
            return Decision(delay: delay, notifyUser: false, isSlowRetry: false)
        }
        return Decision(
            delay: self.slowRetryDelay,
            notifyUser: self.consecutiveCrashes == self.maxFastRetries + 1,
            isSlowRetry: true)
    }

    /// Call when health checks have passed continuously since `healthySince`.
    mutating func recordHealthy(since healthySince: Date, now: Date = Date()) {
        if now.timeIntervalSince(healthySince) >= self.stableRunDuration {
            self.consecutiveCrashes = 0
        }
    }

    mutating func reset() {
        self.consecutiveCrashes = 0
    }
}

// MARK: - Health watchdog policy

/// Counts HTTP health check results for a running server and decides when it is dead.
struct ServerHealthWatchdogPolicy: Equatable {
    enum Verdict: Equatable {
        case healthy
        case failing(consecutive: Int)
        /// The server is unresponsive: kill it and treat it as a crash.
        case dead
        /// Still inside the startup grace period: failures don't count yet.
        case starting
    }

    var failureThreshold = 3
    /// Failures before the first success only count after this long (dev server builds first).
    var startupGrace: TimeInterval

    let startedAt: Date
    private(set) var consecutiveFailures = 0
    private(set) var hasSucceeded = false
    private(set) var healthySince: Date?

    init(startedAt: Date, startupGrace: TimeInterval, failureThreshold: Int = 3) {
        self.startedAt = startedAt
        self.startupGrace = startupGrace
        self.failureThreshold = failureThreshold
    }

    mutating func record(success: Bool, now: Date = Date()) -> Verdict {
        if success {
            self.hasSucceeded = true
            self.consecutiveFailures = 0
            if self.healthySince == nil {
                self.healthySince = now
            }
            return .healthy
        }

        self.healthySince = nil
        if !self.hasSucceeded, now.timeIntervalSince(self.startedAt) < self.startupGrace {
            return .starting
        }
        self.consecutiveFailures += 1
        return self.consecutiveFailures >= self.failureThreshold
            ? .dead
            : .failing(consecutive: self.consecutiveFailures)
    }
}
