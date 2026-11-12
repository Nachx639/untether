import Foundation
import Testing
@testable import Untether

@Suite(
    "AppleScript Executor Tests",
    .tags(.integration),
    .disabled(if: TestConditions.isRunningInCI(), "AppleScript not available in CI"))
struct AppleScriptExecutorTests {
    @Test
    @MainActor
    func executeSimpleApplescript() throws {
        let script = """
        return "Hello from AppleScript"
        """

        let result = try AppleScriptExecutor.shared.executeWithResult(script)
        #expect(result == "Hello from AppleScript")
    }

    @Test
    @MainActor
    func executeScriptWithMath() throws {
        let script = """
        return 2 + 2
        """

        let result = try AppleScriptExecutor.shared.executeWithResult(script)
        #expect(result == "4")
    }

    @Test
    @MainActor
    func handleScriptError() throws {
        let script = """
        error "This is a test error"
        """

        do {
            _ = try AppleScriptExecutor.shared.executeWithResult(script)
            Issue.record("Expected error to be thrown")
        } catch {
            #expect(error.localizedDescription.contains("test error"))
        }
    }

    @Test
    @MainActor
    func handleInvalidSyntax() throws {
        let script = """
        this is not valid applescript syntax
        """

        do {
            _ = try AppleScriptExecutor.shared.executeWithResult(script)
            Issue.record("Expected error to be thrown")
        } catch {
            // Should throw a syntax error
            #expect(error is AppleScriptError)
        }
    }

    @Test
    @MainActor
    func executeEmptyScript() throws {
        let script = ""

        do {
            let result = try AppleScriptExecutor.shared.executeWithResult(script)
            #expect(result.isEmpty || result == "missing value")
        } catch {
            // Empty script might throw an error, which is also acceptable
            #expect(error is AppleScriptError)
        }
    }

    // 2026-11-10: two tests here sent Apple events to System Events from the test host. They
    // could raise the "wants to control System Events" prompt on the user's Mac and, with the
    // prompt unanswered, held the main thread for two minutes (which made other suites time
    // out). What they covered that is ours, the timeout, is tested without another app.

    @Test
    func everyScriptRunsInsideATimeout() {
        #expect(AppleScriptExecutor.bounded("return 1", timeout: 5)
            == "with timeout of 5 seconds\nreturn 1\nend timeout")
        #expect(AppleScriptExecutor.bounded("return 1", timeout: 0.2).hasPrefix("with timeout of 1 seconds\n"))
        #expect(AppleScriptExecutor.bounded("return 1", timeout: 15).hasPrefix("with timeout of 15 seconds\n"))
        // Never the system's two minutes, whatever the caller asks for.
        #expect(AppleScriptExecutor.bounded("return 1", timeout: 600).hasPrefix("with timeout of 30 seconds\n"))
    }

    @Test
    @MainActor
    func aScriptInsideTheTimeoutStillReturnsItsValue() throws {
        let script = """
        set total to 0
        repeat with n from 1 to 4
            set total to total + n
        end repeat
        return total
        """
        #expect(try AppleScriptExecutor.shared.executeWithResult(script, timeout: 2) == "10")
    }

    @Test
    @MainActor
    func anAppThatDoesNotAnswerInTimeIsATimeout() {
        // What AppleScript raises when the other app lets the timeout pass (errAETimeout).
        let script = "error \"AppleEvent timed out.\" number \(AppleScriptExecutor.appleEventTimedOut)"
        do {
            _ = try AppleScriptExecutor.shared.executeWithResult(script)
            Issue.record("expected a timeout")
        } catch AppleScriptError.timeout {
            // expected
        } catch {
            Issue.record("expected AppleScriptError.timeout, got \(error)")
        }
    }

    @Test
    @MainActor
    func singletonInstance() {
        let instance1 = AppleScriptExecutor.shared
        let instance2 = AppleScriptExecutor.shared
        #expect(instance1 === instance2)
    }
}
