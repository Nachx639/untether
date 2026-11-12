import Darwin
import Foundation
import OSLog

/// A server child process spawned as the leader of its own process group.
///
/// 2026-10-12: Stop left the dev server running. `Process.terminate()` only signalled the
/// `/bin/zsh` wrapper while its children (pnpm → node scripts/dev.js → tsx watch → node)
/// kept port 4020. Spawning the wrapper with `POSIX_SPAWN_SETPGROUP` makes its pid the
/// pgid of the whole tree, so `kill(-pgid, …)` reaches every descendant that didn't
/// deliberately leave the group.
final class ServerProcess: @unchecked Sendable {
    private static let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "ServerProcess")

    /// Process id of the wrapper; also the process group id of the whole server tree.
    let pid: pid_t
    let stdout: FileHandle
    let stderr: FileHandle

    private let lock = NSLock()
    private var exitStatus: Int32?
    private var exitWaiters: [CheckedContinuation<Int32, Never>] = []
    private var exitSource: DispatchSourceProcess?

    var pgid: pid_t { self.pid }

    /// Exit status: the exit code, or 128 + signal number when killed by a signal.
    var terminationStatus: Int32? {
        self.lock.withLock { self.exitStatus }
    }

    var isRunning: Bool {
        self.terminationStatus == nil
    }

    private init(pid: pid_t, stdout: FileHandle, stderr: FileHandle) {
        self.pid = pid
        self.stdout = stdout
        self.stderr = stderr
    }

    // MARK: - Spawning

    static func spawn(
        executable: String,
        arguments: [String],
        environment: [String: String],
        currentDirectory: String)
        throws -> ServerProcess
    {
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()

        var fileActions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fileActions)
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        posix_spawn_file_actions_addopen(&fileActions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&fileActions, stdoutPipe.fileHandleForWriting.fileDescriptor, STDOUT_FILENO)
        posix_spawn_file_actions_adddup2(&fileActions, stderrPipe.fileHandleForWriting.fileDescriptor, STDERR_FILENO)
        posix_spawn_file_actions_addchdir_np(&fileActions, currentDirectory)

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // Own process group (pgid = child pid), no inherited descriptors besides 0-2,
        // default signal dispositions and an empty mask (the app ignores SIGPIPE).
        let flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF |
            POSIX_SPAWN_SETSIGMASK
        posix_spawnattr_setflags(&attributes, Int16(flags))
        posix_spawnattr_setpgroup(&attributes, 0)
        var allSignals = sigset_t()
        sigfillset(&allSignals)
        sigdelset(&allSignals, SIGKILL)
        sigdelset(&allSignals, SIGSTOP)
        posix_spawnattr_setsigdefault(&attributes, &allSignals)
        var emptyMask = sigset_t()
        sigemptyset(&emptyMask)
        posix_spawnattr_setsigmask(&attributes, &emptyMask)

        let argv: [UnsafeMutablePointer<CChar>?] = ([executable] + arguments).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }

        var pid: pid_t = 0
        let result = posix_spawn(&pid, executable, &fileActions, &attributes, argv, envp)

        // The child owns the write ends now; close ours so readers see EOF when it exits.
        try? stdoutPipe.fileHandleForWriting.close()
        try? stderrPipe.fileHandleForWriting.close()

        guard result == 0 else {
            try? stdoutPipe.fileHandleForReading.close()
            try? stderrPipe.fileHandleForReading.close()
            throw POSIXError(POSIXErrorCode(rawValue: result) ?? .EINVAL)
        }

        let process = ServerProcess(
            pid: pid,
            stdout: stdoutPipe.fileHandleForReading,
            stderr: stderrPipe.fileHandleForReading)
        process.startExitMonitoring()
        return process
    }

    // MARK: - Exit monitoring

    private func startExitMonitoring() {
        let source = DispatchSource.makeProcessSource(
            identifier: self.pid,
            eventMask: .exit,
            queue: DispatchQueue.global(qos: .utility))
        source.setEventHandler { [weak self] in
            self?.reap()
        }
        self.lock.withLock { self.exitSource = source }
        source.activate()
        // The child may have exited before the source was armed.
        self.reap()
    }

    private func reap() {
        var status: Int32 = 0
        let result = waitpid(self.pid, &status, WNOHANG)
        guard result == self.pid else { return }

        let code: Int32 = if (status & 0x7F) == 0 {
            (status >> 8) & 0xFF // WEXITSTATUS
        } else {
            128 + (status & 0x7F) // WTERMSIG
        }

        let waiters: [CheckedContinuation<Int32, Never>] = self.lock.withLock {
            guard self.exitStatus == nil else { return [] }
            self.exitStatus = code
            self.exitSource?.cancel()
            self.exitSource = nil
            let waiters = self.exitWaiters
            self.exitWaiters.removeAll()
            return waiters
        }
        waiters.forEach { $0.resume(returning: code) }
    }

    /// Waits until the wrapper exits and returns its exit status.
    func waitForExit() async -> Int32 {
        await withCheckedContinuation { continuation in
            let status: Int32? = self.lock.withLock {
                if let status = self.exitStatus { return status }
                self.exitWaiters.append(continuation)
                return nil
            }
            if let status {
                continuation.resume(returning: status)
            }
        }
    }

    /// Waits for the wrapper to exit, up to `timeout`. Returns true if it exited.
    func waitForExit(timeout: Duration) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if !self.isRunning { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return !self.isRunning
    }

    // MARK: - Signals

    /// Sends `signal` to every process in the server's process group.
    @discardableResult
    func signalGroup(_ signal: Int32) -> Bool {
        Self.signalGroup(self.pgid, signal)
    }

    /// How long a stopping server gets before SIGKILL.
    ///
    /// 2026-10-20: the server's graceful shutdown (sessions, sockets, Tailscale Serve route
    /// removal) takes up to 6 s, but the app sent SIGKILL after 5 s (2 s on quit) and the
    /// wrapper after 4.5 s, so cleanup was cut short and e.g. a Serve/Funnel route survived
    /// pointing at the port. Every kill path now waits longer than the server's window.
    static let gracefulStopSeconds: TimeInterval = 8

    /// SIGTERM to the wrapper (which forwards it to the group once), then SIGKILL to whatever
    /// is left in the group after `grace`.
    func terminateGroup(grace: Duration = .seconds(ServerProcess.gracefulStopSeconds)) async {
        guard Self.groupExists(self.pgid) else { return }
        Self.logger.info("Sending SIGTERM to server wrapper \(self.pid) (process group \(self.pgid))")
        Self.requestStop(pgid: self.pgid, wrapperAlive: self.terminationStatus == nil)

        let deadline = ContinuousClock.now + grace
        while ContinuousClock.now < deadline {
            if !Self.groupExists(self.pgid) { return }
            try? await Task.sleep(for: .milliseconds(100))
        }

        if Self.groupExists(self.pgid) {
            Self.logger.warning("Server process group \(self.pgid) survived SIGTERM, sending SIGKILL")
            self.signalGroup(SIGKILL)
        }
    }

    /// Synchronous variant for `applicationWillTerminate`, where the main actor can't await.
    static func terminateGroupSynchronously(pgid: pid_t, grace: TimeInterval) {
        guard pgid > 1, self.groupExists(pgid) else { return }
        self.requestStop(pgid: pgid, wrapperAlive: true)
        let deadline = Date().addingTimeInterval(grace)
        while Date() < deadline {
            if !self.groupExists(pgid) { return }
            usleep(50000)
        }
        if self.groupExists(pgid) {
            self.signalGroup(pgid, SIGKILL)
        }
    }

    /// Asks the server tree to stop with one SIGTERM.
    ///
    /// 2026-10-20: SIGTERM went to the whole group, and the wrapper's TERM trap then sent the
    /// group a second one: the server took the repeated signal as "force exit" and quit with
    /// code 1, skipping its cleanup (sessions, sockets). The wrapper (the group leader, pid ==
    /// pgid) forwards TERM to the group itself, so only it is signalled while it lives; the
    /// group gets it directly only when the wrapper is already gone.
    static func requestStop(pgid: pid_t, wrapperAlive: Bool) {
        guard pgid > 1, pgid != getpgrp() else { return }
        if wrapperAlive, kill(pgid, SIGTERM) == 0 { return }
        self.signalGroup(pgid, SIGTERM)
    }

    @discardableResult
    static func signalGroup(_ pgid: pid_t, _ signal: Int32) -> Bool {
        // Never signal our own group (or init's): a bad pgid must not take the app down.
        guard pgid > 1, pgid != getpgrp() else { return false }
        return kill(-pgid, signal) == 0
    }

    /// True while any process (including an unreaped zombie) is left in the group.
    static func groupExists(_ pgid: pid_t) -> Bool {
        guard pgid > 1 else { return false }
        return kill(-pgid, 0) == 0 || errno == EPERM
    }
}
