import Darwin
import Foundation
import OSLog

/// Information about a process that's using a port.
///
/// Contains detailed information about a process occupying a network port,
/// including identification details and helpers to determine if it's an Untether-related process.
struct ProcessDetails {
    let pid: Int
    let name: String
    let path: String?
    let parentPid: Int?
    let bundleIdentifier: String?
    /// Full command line (argv joined by spaces), when the kernel gives it to us
    var commandLine: String?

    /// Check if this is an Untether process
    var isUntether: Bool {
        if let bundleId = bundleIdentifier {
            return bundleId.contains("untether") || bundleId.contains("Untether")
        }
        if let path {
            return path.contains("Untether")
        }
        return self.name.contains("Untether")
    }

    /// Check if this is one of our managed servers
    var isManagedServer: Bool {
        // The dev server (`tsx … src/cli.ts … --local-auth-token`) runs under the system node,
        // so neither its name nor its path say Untether. Left behind by an instance that
        // crashed, it was taken for an external app and the relaunched app stayed "Stopped"
        // (2026-10-12). Its command line still names the untether web folder.
        if let commandLine, commandLine.contains("src/cli.ts"),
           commandLine.lowercased().contains("untether")
        {
            return true
        }
        // Direct untether binary
        if self.name == "untether" || self.name.contains("untether") {
            return true
        }
        // Node server with Untether in path
        if self.name.contains("node"), path?.contains("Untether") ?? false {
            return true
        }
        // Bun executable (our untether binary is a Bun executable)
        if self.name.contains("bun"), path?.contains("Untether") ?? false {
            return true
        }
        // Check if the path contains our bundle identifier
        if let path, path.contains("com.nachx639.untether") {
            return true
        }
        return false
    }
}

/// Information about a port conflict.
///
/// Encapsulates complete details about a port conflict including the blocking process,
/// suggested remediation actions, and alternative port options.
struct PortConflict {
    let port: Int
    let process: ProcessDetails
    let rootProcess: ProcessDetails?
    let suggestedAction: ConflictAction
    let alternativePorts: [Int]
}

/// Suggested action for resolving a port conflict.
///
/// Provides specific recommendations for how to handle different types of port conflicts,
/// from killing our own processes to suggesting user intervention.
enum ConflictAction {
    case killOurInstance(pid: Int, processName: String)
    case suggestAlternativePort
    case reportExternalApp(name: String)
}

/// Resolves port conflicts and suggests remediation.
///
/// Provides comprehensive port conflict detection and resolution capabilities,
/// including process identification, conflict analysis, and automated remediation
/// for Untether-owned processes. Uses system tools like lsof to detect port usage
/// and can automatically kill conflicting processes when appropriate.
@MainActor
final class PortConflictResolver {
    private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "PortConflictResolver")

    static let shared = PortConflictResolver()

    private init() {}

    /// Attempt to bind to a port to verify it's truly available.
    ///
    /// 2026-10-12: this used to bind INADDR_ANY with SO_REUSEPORT, which succeeds while another
    /// process listens on 127.0.0.1:<port>. Now it binds the server's own address plus the
    /// loopback and wildcard addresses (what the app and the server use), with SO_REUSEADDR
    /// like Node (so TIME_WAIT doesn't count as busy) but without SO_REUSEPORT.
    func canBindToPort(_ port: Int, bindAddress: String = "127.0.0.1") async -> Bool {
        var addresses = [bindAddress]
        for address in ["127.0.0.1", "0.0.0.0"] where !addresses.contains(address) {
            addresses.append(address)
        }
        let candidates = addresses
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                for address in candidates where !Self.canBind(port: port, address: address) {
                    continuation.resume(returning: false)
                    return
                }
                continuation.resume(returning: true)
            }
        }
    }

    private nonisolated static func canBind(port: Int, address: String) -> Bool {
        let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "PortConflictResolver")
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        guard inet_pton(AF_INET, address, &addr.sin_addr) == 1 else {
            // Not an IPv4 literal (e.g. a hostname): nothing to test here
            return true
        }

        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else {
            logger.debug("Failed to create socket for port check")
            return false
        }
        defer { close(sock) }

        var reuseAddr: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &reuseAddr, socklen_t(MemoryLayout<Int32>.size))

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(sock, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if result == 0 {
            return true
        }
        let error = errno
        // EADDRNOTAVAIL: the configured address isn't on this machine right now; not a conflict
        if error == EADDRNOTAVAIL {
            return true
        }
        logger.debug("Port \(port) on \(address) is not available (bind failed with errno \(error))")
        return false
    }

    /// Detect what process is listening on a port.
    ///
    /// Only TCP listeners count (browsers with an open connection to the port used to be
    /// picked up and killed), and never this app itself.
    func detectConflict(on port: Int) async -> PortConflict? {
        let ownPID = Int(ProcessInfo.processInfo.processIdentifier)
        let output: String
        do {
            output = try await Self.runTool(
                "/usr/sbin/lsof",
                arguments: ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpc"])
        } catch {
            self.logger.error("Failed to check port conflict: \(error)")
            return nil
        }

        // lsof exits 1 when nothing matches: the port is free
        guard let listener = LsofListenerParser.parse(output, excludingPID: ownPID).first else {
            return nil
        }

        let processInfo = self.processDetails(pid: listener.pid, fallbackName: listener.command)
        let rootProcess = await findRootProcess(for: processInfo)
        let alternatives = await findAvailablePorts(near: port, count: 3)
        let action = self.determineAction(for: processInfo, rootProcess: rootProcess)

        return PortConflict(
            port: port,
            process: processInfo,
            rootProcess: rootProcess,
            suggestedAction: action,
            alternativePorts: alternatives)
    }

    /// Kill a process and optionally its parent Untether instance
    func resolveConflict(_ conflict: PortConflict) async throws {
        switch conflict.suggestedAction {
        case let .killOurInstance(pid, processName):
            self.logger.info("Killing conflicting process: \(processName) (PID: \(pid))")
            try await self.terminate(pid: pid)
            try await self.waitForPortRelease(conflict.port)

        case .suggestAlternativePort, .reportExternalApp:
            // These require user action
            throw PortConflictError.requiresUserAction
        }
    }

    /// Force kill any process, regardless of type (user-initiated from Settings)
    func forceKillProcess(_ conflict: PortConflict) async throws {
        self.logger.info("Force killing process: \(conflict.process.name) (PID: \(conflict.process.pid))")
        try await self.terminate(pid: conflict.process.pid)
        try await self.waitForPortRelease(conflict.port)
    }

    /// SIGTERM, then SIGKILL if the process is still there after 2 s.
    private func terminate(pid: Int) async throws {
        let target = pid_t(pid)
        guard target > 1, target != ProcessInfo.processInfo.processIdentifier else {
            throw PortConflictError.failedToKillProcess(pid: pid)
        }
        if kill(target, SIGTERM) != 0 {
            if errno == ESRCH { return }
            throw PortConflictError.failedToKillProcess(pid: pid)
        }
        for _ in 0..<20 {
            try await Task.sleep(for: .milliseconds(100))
            if kill(target, 0) != 0, errno == ESRCH { return }
        }
        self.logger.warning("PID \(pid) ignored SIGTERM, sending SIGKILL")
        if kill(target, SIGKILL) != 0, errno != ESRCH {
            throw PortConflictError.failedToKillProcess(pid: pid)
        }
    }

    /// Wait with exponential backoff for the port to be released
    private func waitForPortRelease(_ port: Int) async throws {
        for attempt in 0..<5 {
            if await self.canBindToPort(port) {
                self.logger.info("Port \(port) released after \(attempt) retries")
                return
            }
            try await Task.sleep(for: .milliseconds(500 * UInt64(pow(2.0, Double(attempt)))))
        }
        if await self.canBindToPort(port) { return }
        throw PortConflictError.portStillInUse(port: port)
    }

    /// Find available ports near a given port
    func findAvailablePorts(near port: Int, count: Int) async -> [Int] {
        var availablePorts: [Int] = []
        let range = max(1024, port - 10)...(port + 100)

        for candidatePort in range where candidatePort != port {
            // Bind checks only: running lsof for every candidate is slow
            if await canBindToPort(candidatePort, bindAddress: "0.0.0.0") {
                availablePorts.append(candidatePort)
                if availablePorts.count >= count {
                    break
                }
            }
        }

        return availablePorts
    }

    // MARK: - Private Methods

    /// Name, path and parent of a process from the kernel (no subprocesses).
    private func processDetails(pid: Int, fallbackName: String) -> ProcessDetails {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        let gotInfo = proc_pidinfo(pid_t(pid), PROC_PIDTBSDINFO, 0, &info, size) == size
        let parentPid = gotInfo ? Int(info.pbi_ppid) : nil

        var pathBuffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        let path: String? = proc_pidpath(pid_t(pid), &pathBuffer, UInt32(MAXPATHLEN)) > 0
            ? String(decoding: pathBuffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            : nil

        let name = fallbackName.isEmpty ? (path.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "") : fallbackName
        return ProcessDetails(
            pid: pid,
            name: name,
            path: path,
            parentPid: parentPid,
            bundleIdentifier: self.bundleIdentifier(forPath: path),
            commandLine: Self.commandLine(pid: pid))
    }

    /// argv of a process via KERN_PROCARGS2 (no subprocess), joined by spaces.
    private nonisolated static func commandLine(pid: Int) -> String? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, Int32(pid)]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return nil }
        let argc = buffer.withUnsafeBytes { $0.load(as: Int32.self) }
        // Layout: argc, exec path, NULs, then argc NUL-terminated arguments.
        var index = MemoryLayout<Int32>.size
        while index < size, buffer[index] != 0 { index += 1 }
        while index < size, buffer[index] == 0 { index += 1 }
        var args: [String] = []
        var start = index
        while index < size, args.count < Int(argc) {
            if buffer[index] == 0 {
                args.append(String(decoding: buffer[start..<index], as: UTF8.self))
                start = index + 1
            }
            index += 1
        }
        return args.isEmpty ? nil : args.joined(separator: " ")
    }

    /// Bundle id of the app containing `path`, if any.
    private func bundleIdentifier(forPath path: String?) -> String? {
        guard let path, let range = path.range(of: ".app/") else { return nil }
        let bundlePath = String(path[..<range.lowerBound]) + ".app"
        return Bundle(path: bundlePath)?.bundleIdentifier
    }

    /// Runs a command-line tool off the main thread and returns its stdout.
    private nonisolated static func runTool(_ executable: String, arguments: [String]) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = arguments
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = FileHandle.nullDevice
                do {
                    try process.run()
                    let data = pipe.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit()
                    continuation.resume(returning: String(decoding: data, as: UTF8.self))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func findRootProcess(for process: ProcessDetails) async -> ProcessDetails? {
        var current = process
        var visited = Set<Int>()

        while let parentPid = current.parentPid, parentPid > 1, !visited.contains(parentPid) {
            visited.insert(current.pid)

            // Get parent process info
            if let parentInfo = await getProcessInfo(pid: parentPid) {
                // If parent is Untether, it's our root
                if parentInfo.isUntether {
                    return parentInfo
                }
                current = parentInfo
            } else {
                break
            }
        }

        return nil
    }

    private func getProcessInfo(pid: Int) async -> ProcessDetails? {
        guard kill(pid_t(pid), 0) == 0 || errno == EPERM else { return nil }
        let details = self.processDetails(pid: pid, fallbackName: "")
        return details.name.isEmpty ? nil : details
    }

    private func determineAction(for process: ProcessDetails, rootProcess: ProcessDetails?) -> ConflictAction {
        self.logger
            .debug(
                "Determining action for process: \(process.name) (PID: \(process.pid), Path: \(process.path ?? "unknown"))")

        let ownPID = Int(ProcessInfo.processInfo.processIdentifier)

        // Never kill ourselves (or the test runner hosting us)
        if process.pid == ownPID {
            self.logger.warning("Port is held by this process. Avoiding self-termination.")
            return .suggestAlternativePort
        }

        // Never kill browsers or Tailscale, whatever they hold
        if ProtectedProcesses.isProtected(name: process.name, path: process.path) {
            self.logger.info("Port is held by a protected process: \(process.name)")
            return .reportExternalApp(name: process.name)
        }

        // If it's our managed server, kill it
        if process.isManagedServer {
            self.logger.info("Process identified as managed server: \(process.name)")
            return .killOurInstance(pid: process.pid, processName: process.name)
        }

        // A server left behind by another Untether instance: kill that instance.
        // If the root is this app, only the listener goes.
        if let root = rootProcess, root.isUntether {
            if root.pid == ownPID {
                self.logger.info("Listener \(process.name) is a stale child of this app")
                return .killOurInstance(pid: process.pid, processName: process.name)
            }
            self.logger.info("Root process identified as Untether: \(root.name)")
            return .killOurInstance(pid: root.pid, processName: root.name)
        }

        // If the process itself is Untether
        if process.isUntether {
            self.logger.info("Process identified as Untether: \(process.name)")
            return .killOurInstance(pid: process.pid, processName: process.name)
        }

        // Otherwise, it's an external app
        self.logger.info("Process identified as external app: \(process.name)")
        return .reportExternalApp(name: process.name)
    }
}

// MARK: - Errors

/// Errors that can occur during port conflict resolution.
///
/// Represents various failure modes when attempting to resolve port conflicts,
/// from process termination failures to ports remaining occupied.
enum PortConflictError: LocalizedError {
    case failedToKillProcess(pid: Int)
    case requiresUserAction
    case portStillInUse(port: Int)

    var errorDescription: String? {
        switch self {
        case let .failedToKillProcess(pid):
            String(localized: "Failed to terminate process with PID \(pid)", comment: "Error: freeing the server port")
        case .requiresUserAction:
            String(localized: "This conflict requires user action to resolve", comment: "Error: freeing the server port")
        case let .portStillInUse(port):
            String(localized: "Port \(port) is still in use after multiple attempts to free it", comment: "Error: freeing the server port")
        }
    }
}
