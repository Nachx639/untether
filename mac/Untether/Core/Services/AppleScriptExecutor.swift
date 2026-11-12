@preconcurrency import AppKit
import Foundation
import OSLog

/// Sendable wrapper for NSAppleEventDescriptor.
///
/// Provides thread-safe wrapping of NSAppleEventDescriptor for use
/// across actor boundaries while maintaining safety guarantees.
private struct SendableDescriptor: @unchecked Sendable {
    let descriptor: NSAppleEventDescriptor?
}

/// Safely executes AppleScript commands with proper error handling and crash prevention.
///
/// This class ensures AppleScript execution is deferred to the next run loop to avoid
/// crashes when called directly from SwiftUI actions. It provides centralized error
/// handling and logging for all AppleScript operations in the app.
@MainActor
final class AppleScriptExecutor {
    private let logger = Logger(
        subsystem: BundleIdentifiers.loggerSubsystem,
        category: "AppleScriptExecutor")

    /// Shared instance for app-wide AppleScript execution
    static let shared = AppleScriptExecutor()

    private init() {}

    /// Core AppleScript execution logic shared between sync and async methods.
    ///
    /// - Parameter script: The AppleScript source code to execute
    /// - Returns: The result of the AppleScript execution, if any
    /// - Throws: `AppleScriptError` if execution fails
    /// - Note: This method must be called on the main thread
    @MainActor
    private func executeCore(_ script: String, timeout: TimeInterval) throws -> NSAppleEventDescriptor? {
        var error: NSDictionary?
        guard let scriptObject = NSAppleScript(source: Self.bounded(script, timeout: timeout)) else {
            self.logger.error("Failed to create NSAppleScript object")
            throw AppleScriptError.scriptCreationFailed
        }

        let result = scriptObject.executeAndReturnError(&error)

        if let error {
            let errorMessage = error["NSAppleScriptErrorMessage"] as? String ?? "Unknown error"
            let errorNumber = error["NSAppleScriptErrorNumber"] as? Int

            // Log error details
            self.logger.error("AppleScript execution failed:")
            self.logger.error("  Error code: \(errorNumber ?? -1)")
            self.logger.error("  Error message: \(errorMessage)")
            if let errorRange = error["NSAppleScriptErrorRange"] as? NSRange {
                self.logger.error("  Error range: \(errorRange)")
            }
            if let errorBriefMessage = error["NSAppleScriptErrorBriefMessage"] as? String {
                self.logger.error("  Brief message: \(errorBriefMessage)")
            }

            if errorNumber == Self.appleEventTimedOut {
                throw AppleScriptError.timeout
            }
            throw AppleScriptError.executionFailed(
                message: errorMessage,
                errorCode: errorNumber)
        }

        self.logger.debug("AppleScript \(script) executed successfully")
        return result
    }

    /// errAETimeout: the other app did not answer an Apple event in time.
    nonisolated static let appleEventTimedOut = -1712

    /// The script inside AppleScript's own `with timeout`, so the other app has `timeout`
    /// seconds (1 to 30) to answer each Apple event.
    ///
    /// 2026-11-10: the `timeout` parameter was ignored. NSAppleScript runs on the main thread
    /// and waits for the other app with the system's default of two minutes, so a terminal
    /// that did not answer (or an Automation prompt nobody answered) froze the menu bar app
    /// for two minutes per script.
    nonisolated static func bounded(_ script: String, timeout: TimeInterval) -> String {
        let seconds = Int(min(max(timeout, 1), 30).rounded(.up))
        return "with timeout of \(seconds) seconds\n\(script)\nend timeout"
    }

    /// Executes an AppleScript synchronously with proper error handling.
    ///
    /// This method runs on the main thread and is suitable for use in
    /// synchronous contexts where async/await is not available.
    ///
    /// - Parameters:
    ///   - script: The AppleScript source code to execute
    ///   - timeout: The timeout in seconds (default: 5.0, max: 30.0)
    /// - Throws: `AppleScriptError` if execution fails
    /// - Returns: The result of the AppleScript execution, if any
    @discardableResult
    func execute(_ script: String, timeout: TimeInterval = 5.0) throws -> NSAppleEventDescriptor? {
        // If we're already on the main thread, execute directly
        if Thread.isMainThread {
            // Add a small delay to avoid crashes from SwiftUI actions
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
            return try self.executeCore(script, timeout: timeout)
        } else {
            // If on background thread, dispatch to main and wait
            var result: Result<NSAppleEventDescriptor?, Error>?

            DispatchQueue.main.sync {
                do {
                    result = try .success(self.execute(script, timeout: timeout))
                } catch {
                    result = .failure(error)
                }
            }

            switch result {
            case let .success(value):
                return value
            case let .failure(error):
                throw error
            case .none:
                throw AppleScriptError.executionFailed(message: "Script execution result was nil", errorCode: nil)
            }
        }
    }

    /// Executes an AppleScript asynchronously.
    ///
    /// This method ensures AppleScript runs on the main thread with proper
    /// timeout handling using Swift's modern concurrency features.
    ///
    /// - Parameters:
    ///   - script: The AppleScript source code to execute
    ///   - timeout: The timeout in seconds (default: 5.0, max: 30.0)
    /// - Returns: The result of the AppleScript execution, if any
    func executeAsync(_ script: String, timeout: TimeInterval = 5.0) async throws -> NSAppleEventDescriptor? {
        let timeoutDuration = min(timeout, 30.0)

        return try await withTaskCancellationHandler {
            let sendableResult: SendableDescriptor = try await withCheckedThrowingContinuation { continuation in
                let wrapper = ContinuationWrapper<SendableDescriptor>(continuation: continuation)

                // Set up timeout. Cancelled once the script finishes: left running it logged
                // "timed out" after every execution, one per second with the permissions pane open.
                let timeoutTask = Task {
                    do {
                        try await Task.sleep(nanoseconds: UInt64(timeoutDuration * 1_000_000_000))
                        self.logger.error("AppleScript execution timed out after \(timeoutDuration) seconds")
                        wrapper.resume(throwing: AppleScriptError.timeout)
                    } catch {
                        // Task was cancelled, do nothing
                    }
                }

                Task { @MainActor in
                    defer { timeoutTask.cancel() }
                    // Small delay to ensure we're not in a SwiftUI action context
                    do {
                        try await Task.sleep(nanoseconds: 100_000_000) // 0.1 seconds
                    } catch {
                        wrapper.resume(throwing: error)
                        return
                    }

                    do {
                        let result = try executeCore(script, timeout: timeoutDuration)
                        wrapper.resume(returning: SendableDescriptor(descriptor: result))
                    } catch {
                        wrapper.resume(throwing: error)
                    }
                }
            }
            return sendableResult.descriptor
        } onCancel: {
            // Handle cancellation if needed
        }
    }

    /// Executes an AppleScript and returns its string result.
    ///
    /// This method is useful when you need to get a string result from AppleScript,
    /// such as window IDs or other identifiers.
    ///
    /// - Parameters:
    ///   - script: The AppleScript source code to execute
    ///   - timeout: The timeout in seconds (default: 5.0, max: 30.0)
    /// - Returns: The string result of the AppleScript execution
    /// - Throws: `AppleScriptError` if execution fails
    func executeWithResult(_ script: String, timeout: TimeInterval = 5.0) throws -> String {
        let descriptor = try execute(script, timeout: timeout)
        return descriptor?.stringValue ?? ""
    }
}

/// Errors that can occur during AppleScript execution.
///
/// Provides detailed error cases for AppleScript failures including
/// script creation issues, execution errors, and permission problems.
enum AppleScriptError: LocalizedError {
    case scriptCreationFailed
    case executionFailed(message: String, errorCode: Int?)
    case permissionDenied
    case timeout

    var errorDescription: String? {
        switch self {
        case .scriptCreationFailed:
            String(localized: "Failed to create AppleScript object", comment: "Error: controlling another app with AppleScript")
        case let .executionFailed(message, errorCode):
            if let code = errorCode {
                String(localized: "AppleScript error \(code): \(message)", comment: "Error: controlling another app with AppleScript")
            } else {
                String(localized: "AppleScript error: \(message)", comment: "Error: controlling another app with AppleScript")
            }
        case .permissionDenied:
            String(localized: "AppleScript permission denied. Please grant permission in System Settings.", comment: "Error: controlling another app with AppleScript")
        case .timeout:
            String(localized: "AppleScript execution timed out", comment: "Error: controlling another app with AppleScript")
        }
    }

    var failureReason: String? {
        switch self {
        case .permissionDenied:
            return String(localized: "Untether needs Automation permission to control other applications.", comment: "Error detail: controlling another app with AppleScript")
        case let .executionFailed(_, errorCode):
            if let code = errorCode {
                switch code {
                case -1743:
                    return String(localized: "User permission is required to control other applications.", comment: "Error detail: controlling another app with AppleScript")
                case 1002, -25211, -1719:
                    return String(localized: "Accessibility permission is required to send keystrokes.", comment: "Error detail: controlling another app with AppleScript")
                case -1728:
                    return String(localized: "The application is not running or cannot be controlled.", comment: "Error detail: controlling another app with AppleScript")
                case -1708:
                    return String(localized: "The event was not handled by the target application.", comment: "Error detail: controlling another app with AppleScript")
                case -2741:
                    return String(localized: "AppleScript syntax error - check for unescaped quotes or invalid identifiers.", comment: "Error detail: controlling another app with AppleScript")
                default:
                    return nil
                }
            }
            return nil
        default:
            return nil
        }
    }

    /// Checks if this error represents a permission denial
    var isPermissionError: Bool {
        switch self {
        case .permissionDenied:
            true
        case let .executionFailed(_, errorCode):
            errorCode == -1743
        default:
            false
        }
    }

    /// Checks if this error represents a denied System Events keystroke.
    var isAccessibilityPermissionError: Bool {
        guard case let .executionFailed(_, errorCode) = self else {
            return false
        }
        return errorCode == 1002 || errorCode == -25211 || errorCode == -1719
    }

    /// Converts this error to a TerminalLauncherError if appropriate
    func toTerminalLauncherError() -> TerminalLauncherError {
        if self.isAccessibilityPermissionError {
            return .accessibilityPermissionDenied
        }

        if self.isPermissionError {
            return .appleScriptPermissionDenied
        }

        switch self {
        case let .executionFailed(message, errorCode):
            return .appleScriptExecutionFailed(message, errorCode: errorCode)
        default:
            return .appleScriptExecutionFailed(self.localizedDescription, errorCode: nil)
        }
    }
}
