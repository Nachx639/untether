import Darwin
import Foundation
import OSLog

/// Utility to detect and terminate other Untether instances
@MainActor
enum ProcessKiller {
    private static let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "ProcessKiller")

    /// Kill all other Untether instances except the current one.
    ///
    /// Only sends signals (no sleeping on the main thread); returns the PIDs it signalled so
    /// callers can `await waitForExit(_:timeout:)` before they need the port or socket.
    @discardableResult
    static func killOtherInstances() -> [pid_t] {
        let currentPID = ProcessInfo.processInfo.processIdentifier
        self.logger.info("🔍 Current process PID: \(currentPID)")

        // Find all Untether processes
        let untetherProcesses = self.findUntetherProcesses()

        // Kill other instances
        var killed: [pid_t] = []
        for process in untetherProcesses where process.pid != currentPID {
            logger.info("🎯 Found other Untether instance: PID \(process.pid) at \(process.path)")

            if killProcess(pid: process.pid) {
                killed.append(process.pid)
                logger.info("✅ Successfully killed PID \(process.pid)")
            } else {
                logger.warning("⚠️ Failed to kill PID \(process.pid)")
            }
        }

        if killed.isEmpty {
            self.logger.info("✨ No other Untether instances found")
        } else {
            self.logger.info("🧹 Killed \(killed.count) other Untether instance(s)")
        }
        return killed
    }

    /// Waits (without blocking the main thread) until the given processes are gone.
    static func waitForExit(_ pids: [pid_t], timeout: Duration) async {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            let alive = pids.contains { kill($0, 0) == 0 }
            if !alive { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    /// Find all running Untether processes
    private static func findUntetherProcesses() -> [(pid: Int32, path: String)] {
        var processes: [(pid: Int32, path: String)] = []

        // Get all processes
        let allProcesses = self.getAllProcesses()
        self.logger.debug("🔍 Found \(allProcesses.count) total processes")

        for process in allProcesses where process.path.contains("Untether.app/Contents/MacOS/Untether") {
            logger.debug("🎯 Found Untether process: PID \(process.pid) at \(process.path)")
            processes.append(process)
        }

        self.logger.info("📊 Found \(processes.count) Untether app processes")
        return processes
    }

    /// Get all running processes with their paths
    private static func getAllProcesses() -> [(pid: Int32, path: String)] {
        var processes: [(pid: Int32, path: String)] = []

        self.logger.debug("🔎 Getting process list...")

        // Set up the mib (Management Information Base) for getting all processes
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]

        // Get process list size
        var size: size_t = 0
        if sysctl(&mib, 4, nil, &size, nil, 0) != 0 {
            self.logger.error("❌ Failed to get process list size, errno: \(errno)")
            return processes
        }

        // Allocate memory for process list
        let count = size / MemoryLayout<kinfo_proc>.size
        var procList = [kinfo_proc](repeating: kinfo_proc(), count: count)
        size = procList.count * MemoryLayout<kinfo_proc>.size

        // Get process list - reuse the same mib
        if sysctl(&mib, 4, &procList, &size, nil, 0) != 0 {
            self.logger.error("❌ Failed to get process list, errno: \(errno)")
            return processes
        }

        // Extract process information
        let actualCount = size / MemoryLayout<kinfo_proc>.size
        for i in 0..<actualCount {
            let proc = procList[i]
            let pid = proc.kp_proc.p_pid

            // Get process path
            var pathBuffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
            let pathSize = UInt32(MAXPATHLEN)

            if proc_pidpath(pid, &pathBuffer, pathSize) > 0 {
                // Convert CChar array to String safely
                pathBuffer.withUnsafeBufferPointer { buffer in
                    if let baseAddress = buffer.baseAddress,
                       let path = String(validatingCString: baseAddress)
                    {
                        processes.append((pid: pid, path: path))
                    }
                }
            }
        }

        return processes
    }

    /// Kill a process by PID
    private static func killProcess(pid: Int32) -> Bool {
        // First check if we can signal the process
        if kill(pid, 0) != 0 {
            // Process doesn't exist or we don't have permission
            if errno == ESRCH {
                // Process doesn't exist, consider it a success
                self.logger.debug("Process \(pid) doesn't exist")
                return true
            } else if errno == EPERM {
                self.logger.error("No permission to kill process \(pid)")
                return false
            }
        }

        // For suspended processes or stubborn ones, try SIGKILL first
        // This is more aggressive but ensures we clean up properly
        if kill(pid, SIGKILL) == 0 {
            self.logger.info("Forcefully killed process \(pid) with SIGKILL")
            return true
        }

        // If SIGKILL failed, check why
        if errno == ESRCH {
            // Process died between our check and kill attempt
            return true
        }

        self.logger.error("Failed to kill process \(pid), errno: \(errno)")
        return false
    }
}
