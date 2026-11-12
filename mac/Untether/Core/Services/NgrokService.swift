import Foundation
import Observation
import os

/// Errors that can occur during ngrok operations.
///
/// Represents various failure modes when working with ngrok tunnels,
/// from installation issues to runtime configuration problems.
enum NgrokError: LocalizedError, Equatable {
    case notInstalled
    case authTokenMissing
    case tunnelCreationFailed(String)
    case invalidConfiguration
    case networkError(String)

    var errorDescription: String? {
        switch self {
        case .notInstalled:
            ErrorMessages.ngrokNotInstalled
        case .authTokenMissing:
            ErrorMessages.ngrokAuthTokenMissing
        case let .tunnelCreationFailed(message):
            String(localized: "Failed to create tunnel: \(message)", comment: "Error: ngrok remote access")
        case .invalidConfiguration:
            ErrorMessages.invalidNgrokConfiguration
        case let .networkError(message):
            String(localized: "Network error: \(message)", comment: "Error: ngrok remote access")
        }
    }
}

/// Represents the status of an ngrok tunnel.
///
/// Contains the current state of an active ngrok tunnel including
/// its public URL, traffic metrics, and creation timestamp.
struct NgrokTunnelStatus: Codable {
    let publicUrl: String
    let metrics: TunnelMetrics
    let startedAt: Date
}

/// Protocol for ngrok tunnel operations.
///
/// Defines the interface for managing ngrok tunnel lifecycle,
/// including creation, monitoring, and termination.
protocol NgrokTunnelProtocol {
    func start(port: Int) async throws -> String
    func stop() async throws
    func getStatus() async -> NgrokTunnelStatus?
    func isRunning() async -> Bool
}

/// Manages ngrok tunnel lifecycle and configuration.
///
/// `NgrokService` provides a high-level interface for creating and managing ngrok tunnels
/// to expose local Untether servers to the internet. It handles authentication,
/// process management, and status monitoring while integrating with the system keychain
/// for secure token storage. The service operates as a singleton on the main actor.
@Observable
@MainActor
final class NgrokService: NgrokTunnelProtocol {
    static let shared = NgrokService()

    /// Current tunnel status
    private(set) var tunnelStatus: NgrokTunnelStatus?

    /// Indicates if a tunnel is currently active
    private(set) var isActive = false

    /// The public URL of the active tunnel
    private(set) var publicUrl: String?

    /// Auth token for ngrok (stored securely in Keychain)
    var authToken: String? {
        get {
            let token = KeychainHelper.getNgrokAuthToken()
            self.logger.info("Getting auth token from keychain: \(token != nil ? "present" : "nil")")
            return token
        }
        set {
            self.logger.info("Setting auth token in keychain: \(newValue != nil ? "present" : "nil")")
            if let token = newValue {
                KeychainHelper.setNgrokAuthToken(token)
            } else {
                KeychainHelper.deleteNgrokAuthToken()
            }
        }
    }

    /// Check if auth token exists without triggering keychain prompt
    var hasAuthToken: Bool {
        KeychainHelper.hasNgrokAuthToken()
    }

    /// The ngrok process if using CLI mode
    private var ngrokProcess: Process?

    /// Task for periodic status updates
    private var statusTask: Task<Void, Never>?

    private let logger = Logger(subsystem: BundleIdentifiers.main, category: "NgrokService")

    private init() {}

    /// Starts an ngrok tunnel for the specified port
    func start(port: Int) async throws -> String {
        self.logger.info("Starting ngrok tunnel on port \(port)")
        // 2026-10-20: no tunnel to a server without sign-in (ServerNetworkPolicy).
        guard !ServerNetworkPolicy.tunnelsBlockedByNoAuth else {
            throw NgrokError.tunnelCreationFailed(ServerNetworkPolicy.tunnelBlockedMessage)
        }

        guard let authToken, !authToken.isEmpty else {
            self.logger.error("Auth token is missing")
            throw NgrokError.authTokenMissing
        }

        self.logger.info("Auth token is present, proceeding with CLI start")

        // For now, we'll use the ngrok CLI approach
        // Later we can switch to the SDK when available
        return try await self.startWithCLI(port: port)
    }

    /// Stops the active ngrok tunnel
    func stop() async throws {
        self.logger.info("Stopping ngrok tunnel")

        if let process = ngrokProcess {
            process.terminate()
            self.ngrokProcess = nil
        }

        self.statusTask?.cancel()
        self.statusTask = nil

        self.isActive = false
        self.publicUrl = nil
        self.tunnelStatus = nil
    }

    /// App exit: ends ngrok at once, without waiting.
    ///
    /// 2026-11-10: quitting signalled Cloudflare, Pinggy and Pangolin but not ngrok, which is
    /// a child of the app and not in the server's process group: it outlived the app and kept
    /// the public URL pointed at the port.
    func sendTerminationSignal() {
        self.ngrokProcess?.terminate()
        self.ngrokProcess = nil
        self.statusTask?.cancel()
        self.statusTask = nil
        self.isActive = false
        self.publicUrl = nil
        self.tunnelStatus = nil
    }

    /// Whether this app has an ngrok process.
    var hasProcess: Bool { self.ngrokProcess != nil }

    /// Gets the current tunnel status
    func getStatus() async -> NgrokTunnelStatus? {
        self.tunnelStatus
    }

    /// Checks if a tunnel is currently running
    func isRunning() async -> Bool {
        self.isActive && self.ngrokProcess?.isRunning == true
    }

    // MARK: - Private Methods

    /// Starts ngrok using the CLI
    private func startWithCLI(port: Int) async throws -> String {
        // Check if ngrok is installed
        let checkProcess = Process()
        checkProcess.executableURL = URL(fileURLWithPath: FilePathConstants.which)
        checkProcess.arguments = ["ngrok"]

        // Add common Homebrew paths to PATH for the check
        var environment = ProcessInfo.processInfo.environment
        let currentPath = environment[EnvironmentKeys.path] ?? "\(FilePathConstants.usrBin):\(FilePathConstants.bin)"
        let homebrewPaths = "\(FilePathConstants.optHomebrewBin):\(FilePathConstants.usrLocalBin)"
        environment[EnvironmentKeys.path] = "\(homebrewPaths):\(currentPath)"
        checkProcess.environment = environment

        let checkPipe = Pipe()
        checkProcess.standardOutput = checkPipe
        checkProcess.standardError = Pipe()

        var launched: Process?
        do {
            try checkProcess.run()
            checkProcess.waitUntilExit()

            let ngrokPath: String?
            do {
                if let data = try checkPipe.fileHandleForReading.readToEnd() {
                    ngrokPath = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                } else {
                    ngrokPath = nil
                }
            } catch {
                self.logger.debug("Could not read ngrok path: \(error.localizedDescription)")
                ngrokPath = nil
            }

            guard let ngrokPath, !ngrokPath.isEmpty else {
                throw NgrokError.notInstalled
            }

            guard let authToken else {
                throw NgrokError.authTokenMissing
            }

            // Start ngrok tunnel.
            // 2026-11-07 (secrets): the authtoken goes to ngrok through
            // NGROK_AUTHTOKEN in the process environment, never on argv and never
            // persisted via `ngrok config add-authtoken`, so a local `ps -ww`
            // cannot read it (same leak class fixed earlier with --local-auth-token).
            let process = Process()
            process.executableURL = URL(fileURLWithPath: ngrokPath)
            process.arguments = Self.tunnelArguments(port: port)
            process.environment = Self.tunnelEnvironment(authToken: authToken)

            // 2026-11-10: stdout was read only until the public URL appeared and stderr was a
            // pipe nobody read. ngrok logs every request to stdout: once the pipe's buffer was
            // full it blocked on the write and the tunnel stalled while the app still said
            // "connected". The watcher keeps reading (and discarding) for the tunnel's life.
            let outputPipe = Pipe()
            process.standardOutput = outputPipe
            process.standardError = FileHandle.nullDevice

            let watcher = NgrokOutputWatcher()
            outputPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    watcher.finish()
                } else {
                    watcher.feed(data)
                }
            }

            try process.run()
            launched = process
            self.ngrokProcess = process

            // The old wait could not be cut short: a ngrok that stayed up without printing a
            // URL (no network) left "Starting…" on screen forever.
            let url = try await watcher.waitForURL(timeout: 10)

            self.publicUrl = url
            self.isActive = true

            // Start monitoring tunnel status
            self.startStatusMonitoring()

            self.logger.info("ngrok tunnel started: \(url)")
            return url
        } catch {
            self.logger.error("Failed to start ngrok: \(error)")
            // A start that failed after launching must not leave ngrok running: isRunning()
            // says false and the next attempt would launch a second one.
            if let launched {
                if launched.isRunning { launched.terminate() }
                if self.ngrokProcess === launched { self.ngrokProcess = nil }
            }
            throw error
        }
    }

    /// Monitors tunnel status periodically
    private func startStatusMonitoring() {
        self.statusTask?.cancel()

        self.statusTask = Task { @MainActor in
            while !Task.isCancelled {
                await self.updateTunnelStatus()
                try? await Task.sleep(nanoseconds: 5_000_000_000) // 5 seconds
            }
        }
    }

    /// Updates the current tunnel status
    private func updateTunnelStatus() async {
        // In a real implementation, we would query ngrok's API
        // For now, just check if the process is still running
        if let process = ngrokProcess, process.isRunning {
            if self.tunnelStatus == nil {
                self.tunnelStatus = NgrokTunnelStatus(
                    publicUrl: self.publicUrl ?? "",
                    metrics: TunnelMetrics(connectionsCount: 0, bytesIn: 0, bytesOut: 0),
                    startedAt: Date())
            }
        } else {
            self.isActive = false
            self.publicUrl = nil
            self.tunnelStatus = nil
        }
    }

    // MARK: - Tunnel command (testable)

    /// Arguments for the `ngrok http` process. The authtoken is deliberately
    /// absent here; it travels through the environment (`tunnelEnvironment`).
    nonisolated static func tunnelArguments(port: Int) -> [String] {
        ["http", "\(port)", "--log=stdout", "--log-format=json"]
    }

    /// Environment for the `ngrok http` process: Homebrew paths plus the
    /// authtoken in `NGROK_AUTHTOKEN`, so the secret never reaches the command
    /// line (`ps -ww` readable) nor the persisted ngrok config file.
    nonisolated static func tunnelEnvironment(
        authToken: String,
        base: [String: String] = ProcessInfo.processInfo.environment)
        -> [String: String]
    {
        var environment = base
        let currentPath = environment[EnvironmentKeys.path] ?? "\(FilePathConstants.usrBin):\(FilePathConstants.bin)"
        let homebrewPaths = "\(FilePathConstants.optHomebrewBin):\(FilePathConstants.usrLocalBin)"
        environment[EnvironmentKeys.path] = "\(homebrewPaths):\(currentPath)"
        environment[EnvironmentKeys.ngrokAuthToken] = authToken
        return environment
    }
}

// MARK: - AsyncSequence Extension for FileHandle

extension FileHandle {
    var lines: AsyncLineSequence {
        AsyncLineSequence(fileHandle: self)
    }
}

/// Async sequence for reading lines from a FileHandle.
///
/// Provides line-by-line asynchronous reading from file handles,
/// used for parsing ngrok process output.
struct AsyncLineSequence: AsyncSequence {
    typealias Element = String

    let fileHandle: FileHandle

    struct AsyncIterator: AsyncIteratorProtocol {
        let fileHandle: FileHandle
        var buffer = Data()

        mutating func next() async -> String? {
            while true {
                let lineBreakData = Data("\n".utf8)
                if let range = buffer.range(of: lineBreakData) {
                    let line = String(data: buffer[..<range.lowerBound], encoding: .utf8)
                    self.buffer.removeSubrange(..<range.upperBound)
                    return line
                }

                let newData = self.fileHandle.availableData
                if newData.isEmpty {
                    if !self.buffer.isEmpty {
                        defer { buffer.removeAll() }
                        return String(data: self.buffer, encoding: .utf8)
                    }
                    return nil
                }

                self.buffer.append(newData)
            }
        }
    }

    func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(fileHandle: self.fileHandle)
    }
}

// MARK: - Keychain Helper

/// Helper for secure storage of ngrok auth tokens in Keychain.
///
/// Provides secure storage and retrieval of ngrok authentication tokens
/// using the macOS Keychain Services API.
private enum KeychainHelper {
    private static let service = KeychainConstants.untetherService
    private static let account = "ngrok-auth-token"

    static func getNgrokAuthToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: self.account,
            kSecReturnData as String: true,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8)
        else {
            return nil
        }

        return token
    }

    /// Check if a token exists without retrieving it (won't trigger keychain prompt)
    static func hasNgrokAuthToken() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: self.account,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnAttributes as String: false,
            kSecReturnData as String: false,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        return status == errSecSuccess
    }

    static func setNgrokAuthToken(_ token: String) {
        guard let data = token.data(using: .utf8) else {
            return
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: self.account,
        ]

        // Try to update first
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)

        if status == errSecItemNotFound {
            // Item doesn't exist, create it
            var addQuery = query
            addQuery[kSecValueData as String] = data
            status = SecItemAdd(addQuery as CFDictionary, nil)
        }
    }

    static func deleteNgrokAuthToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: self.account,
        ]

        SecItemDelete(query as CFDictionary)
    }
}

/// Reads ngrok's log (JSON lines on stdout) for as long as it runs: finds the public URL, then
/// throws the rest away so the pipe never fills.
final class NgrokOutputWatcher: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private var result: Result<String, Error>?
    private var continuation: CheckedContinuation<String, Error>?

    /// The public URL in one line of ngrok's JSON log, if it announces one.
    static func publicURL(inLine line: String) -> String? {
        guard let data = line.data(using: .utf8), let json = JSONValue.decodeObject(from: data) else { return nil }
        if let msg = json["msg"]?.string, msg.contains("started tunnel"), let url = json["url"]?.string {
            return url
        }
        if let addr = json["addr"]?.string, addr.starts(with: "https://") {
            return addr
        }
        return nil
    }

    func feed(_ data: Data) {
        self.lock.lock()
        guard self.result == nil else {
            // URL known (or given up): the output is only drained.
            self.lock.unlock()
            return
        }
        self.buffer.append(data)
        var found: String?
        while found == nil, let newline = self.buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: self.buffer[self.buffer.startIndex..<newline], as: UTF8.self)
            self.buffer.removeSubrange(self.buffer.startIndex...newline)
            found = Self.publicURL(inLine: line)
        }
        // A log line is never this long: do not keep what will not be a line.
        if self.buffer.count > 1_048_576 { self.buffer.removeAll() }
        self.lock.unlock()
        if let found { self.resolve(.success(found)) }
    }

    /// ngrok closed its output without a URL.
    func finish() {
        self.resolve(.failure(NgrokError.tunnelCreationFailed(ErrorMessages.ngrokPublicURLNotFound)))
    }

    func waitForURL(timeout: TimeInterval) async throws -> String {
        let timer = Task {
            try? await Task.sleep(for: .seconds(timeout))
            guard !Task.isCancelled else { return }
            self.resolve(.failure(NgrokError.networkError(ErrorMessages.operationTimeout)))
        }
        defer { timer.cancel() }
        return try await withCheckedThrowingContinuation { continuation in
            self.lock.lock()
            if let result = self.result {
                self.lock.unlock()
                continuation.resume(with: result)
            } else {
                self.continuation = continuation
                self.lock.unlock()
            }
        }
    }

    private func resolve(_ result: Result<String, Error>) {
        self.lock.lock()
        guard self.result == nil else {
            self.lock.unlock()
            return
        }
        self.result = result
        self.buffer.removeAll()
        let continuation = self.continuation
        self.continuation = nil
        self.lock.unlock()
        continuation?.resume(with: result)
    }
}
