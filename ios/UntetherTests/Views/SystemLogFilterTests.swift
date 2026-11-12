import Testing
@testable import Untether

/// The filters of the log viewer against lines as the server writes them
/// (web/src/server/utils/logger.ts: `<time> <LEVEL padded to 5> [<module>] <message>`).
@Suite("System log filters")
struct SystemLogFilterTests {
    static let log = """
    2026-11-10T09:12:30.001Z LOG   [server] listening on 127.0.0.1:4020
    2026-11-10T09:12:31.002Z DEBUG [pty-manager] spawn zsh
    2026-11-10T09:12:32.003Z WARN  [auth] token about to expire
    2026-11-10T09:12:33.004Z ERROR [sessions] failed to create session
        at createSession (sessions.ts:1035)
        at Router.handle (router.js:12)
    2026-11-10T09:12:34.005Z LOG   [[FE] terminal] resized to 80x24
    2026-11-10T09:12:35.006Z ERROR [[FE] app] Error: socket closed
    2026-11-10T09:12:36.007Z LOG   [sessions] error: none, all good
    """

    private func lines(_ filter: SystemLogFilter) -> [String] {
        filter.apply(to: Self.log).split(separator: "\n").map(String.init)
    }

    @Test("Without filters every line is shown")
    func noFilters() {
        #expect(self.lines(SystemLogFilter()).count == 9)
    }

    @Test("Each level shows its own entries", arguments: [
        (SystemLogFilter.Level.error, 4), (.warn, 1), (.log, 3), (.debug, 1),
    ])
    func levels(level: SystemLogFilter.Level, count: Int) {
        #expect(self.lines(SystemLogFilter(level: level)).count == count)
    }

    @Test("Error keeps the stack of its entry and ignores the word error in a LOG line")
    func errorLevel() {
        let shown = self.lines(SystemLogFilter(level: .error))
        #expect(shown.contains { $0.contains("at createSession") })
        #expect(shown.contains { $0.contains("[[FE] app]") })
        #expect(!shown.contains { $0.contains("all good") })
    }

    @Test("Client is what the web client logged ([FE]); Server is the rest")
    func sources() {
        let client = self.lines(SystemLogFilter(showServer: false))
        #expect(client.count == 2)
        #expect(client.allSatisfy { $0.contains("[[FE] ") })

        let server = self.lines(SystemLogFilter(showClient: false))
        #expect(server.count == 7)
        #expect(!server.contains { $0.contains("[[FE] ") })

        #expect(self.lines(SystemLogFilter(showClient: false, showServer: false)).isEmpty)
    }

    @Test("Search finds an entry by any of its lines and shows it whole")
    func search() {
        let shown = self.lines(SystemLogFilter(search: "router.handle"))
        #expect(shown.count == 3)
        #expect(shown[0].contains("failed to create session"))
    }

    @Test("A log that starts in the middle of an entry (a tail) keeps those lines as server log")
    func tailStartsMidEntry() {
        let tail = "    at somewhere (file.ts:1)\n2026-11-10T09:12:34.005Z LOG   [[FE] terminal] hi"
        #expect(SystemLogFilter(showClient: false).apply(to: tail) == "    at somewhere (file.ts:1)")
    }
}
