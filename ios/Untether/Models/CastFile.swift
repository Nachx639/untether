import Foundation
import Observation

/// Cast file theme configuration for terminal appearance.
///
/// This struct represents the theme settings that can be included in an Asciinema cast file,
/// controlling the visual appearance of the terminal recording.
struct CastTheme: Codable {
    let foreground: String?
    let background: String?
    let palette: String?

    enum CodingKeys: String, CodingKey {
        case foreground = "fg"
        case background = "bg"
        case palette
    }
}

/// Represents the header structure of an Asciinema cast v2 file.
///
/// The CastFile struct contains metadata about a terminal recording,
/// including dimensions, timing, and optional theme information.
/// This follows the Asciinema cast v2 format specification.
struct CastFile: Codable {
    let version: Int
    let width: Int
    let height: Int
    let timestamp: TimeInterval?
    let title: String?
    let env: [String: String]?
    let theme: CastTheme?
}

/// Represents a single event in a terminal recording.
///
/// Events capture terminal output, input, or resize operations
/// with timestamps relative to the recording start.
struct CastEvent: Codable {
    let time: TimeInterval
    let type: String // "o" for output, "i" for input, "r" for resize
    let data: String
}

/// Records terminal sessions in Asciinema cast v2 format.
///
/// CastRecorder captures terminal output and resize events during a session,
/// allowing export of the recording as a standard cast file that can be
/// played back with any Asciinema-compatible player.
///
/// ## Usage
/// ```swift
/// let recorder = CastRecorder(sessionId: "session123")
/// recorder.startRecording()
/// // Terminal output is recorded...
/// recorder.stopRecording()
/// let castData = recorder.exportCastFile()
/// ```
@MainActor
@Observable
class CastRecorder {
    var isRecording = false
    var recordingStartTime: Date?
    var events: [CastEvent] = []

    private let sessionId: String
    /// The terminal's size when the recording started: the header of the cast file. Players
    /// lay the output out with it, so it has to be the real one.
    private var width = 80
    private var height = 24
    private var startTime: TimeInterval = 0

    /// Creates a new cast recorder for a terminal session.
    init(sessionId: String) {
        self.sessionId = sessionId
    }

    /// Begins recording terminal events.
    ///
    /// - Parameters:
    ///   - cols: The terminal's width now (kept at 80 when not known yet).
    ///   - rows: The terminal's height now (kept at 24 when not known yet).
    ///
    /// Clears any previous events and sets the recording start time.
    /// Has no effect if recording is already in progress.
    func startRecording(cols: Int = 0, rows: Int = 0) {
        guard !self.isRecording else { return }

        self.width = cols > 0 ? cols : 80
        self.height = rows > 0 ? rows : 24

        self.isRecording = true
        self.recordingStartTime = Date()
        self.startTime = Date().timeIntervalSince1970
        self.events.removeAll()
    }

    /// Stops recording terminal events.
    ///
    /// Has no effect if recording is not in progress.
    func stopRecording() {
        guard self.isRecording else { return }

        self.isRecording = false
        self.recordingStartTime = nil
    }

    /// Records terminal output data.
    ///
    /// - Parameter data: The terminal output text to record.
    ///
    /// Output events are timestamped relative to the recording start time.
    /// Has no effect if recording is not active.
    func recordOutput(_ data: String) {
        guard self.isRecording else { return }

        let currentTime = Date().timeIntervalSince1970
        let relativeTime = currentTime - self.startTime

        let event = CastEvent(
            time: relativeTime,
            type: "o", // output
            data: data)

        self.events.append(event)
    }

    /// Records a terminal resize event.
    ///
    /// - Parameters:
    ///   - cols: New terminal width in columns.
    ///   - rows: New terminal height in rows.
    ///
    /// Resize events are timestamped relative to the recording start time.
    /// Has no effect if recording is not active.
    func recordResize(cols: Int, rows: Int) {
        guard self.isRecording else { return }

        let currentTime = Date().timeIntervalSince1970
        let relativeTime = currentTime - self.startTime

        let resizeData = "\(cols)x\(rows)"
        let event = CastEvent(
            time: relativeTime,
            type: "r", // resize
            data: resizeData)

        self.events.append(event)
    }

    /// Exports the recording as an Asciinema cast v2 file.
    ///
    /// - Returns: The cast file data, or nil if export fails.
    ///
    /// The exported data contains a JSON header followed by
    /// newline-delimited JSON arrays representing each event.
    func exportCastFile() -> Data? {
        // Create header
        let header = CastFile(
            version: 2,
            width: width,
            height: height,
            timestamp: startTime,
            title: "Untether Recording - \(sessionId)",
            env: ["TERM": "xterm-256color", "SHELL": "/bin/zsh"],
            theme: nil)

        guard let headerData = try? JSONEncoder().encode(header),
              let headerString = String(data: headerData, encoding: .utf8)
        else {
            return nil
        }

        // Build the cast file content
        var castContent = headerString + "\n"

        // Add all events
        for event in self.events {
            // Cast events are encoded as arrays [time, type, data]
            let eventArray: [JSONValue] = [
                .number(event.time),
                .string(event.type),
                .string(event.data),
            ]

            if let jsonData = try? JSONEncoder().encode(eventArray),
               let jsonString = String(data: jsonData, encoding: .utf8)
            {
                castContent += jsonString + "\n"
            }
        }

        return castContent.data(using: .utf8)
    }
}

/// Plays back terminal recordings from Asciinema cast files.
///
/// CastPlayer parses cast v2 files and provides playback functionality
/// with proper timing between events.
///
/// ## Example
/// ```swift
/// if let player = CastPlayer(data: castFileData) {
///     try await player.play { _, event in
///         // Handle each event
///     }
/// }
/// ```
class CastPlayer {
    /// The cast file header containing metadata.
    let header: CastFile

    /// All events in the recording.
    let events: [CastEvent]

    /// Creates a cast player from cast file data.
    ///
    /// - Parameter data: Raw cast file data.
    ///
    /// - Returns: A configured player, or nil if the data is invalid.
    ///
    /// The initializer parses the cast file format, extracting the header
    /// from the first line and events from subsequent lines.
    init?(data: Data) {
        guard let content = String(data: data, encoding: .utf8) else {
            return nil
        }

        let lines = content.components(separatedBy: .newlines)
        guard !lines.isEmpty else { return nil }

        // Parse header (first line)
        guard let headerData = lines[0].data(using: .utf8),
              let header = try? JSONDecoder().decode(CastFile.self, from: headerData)
        else {
            return nil
        }

        // Parse events (remaining lines)
        var parsedEvents: [CastEvent] = []
        for index in 1..<lines.count {
            let line = lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty,
                  let lineData = line.data(using: .utf8),
                  let array = JSONValue.decodeArray(from: lineData),
                  array.count >= 3,
                  let time = array[0].double,
                  let type = array[1].string,
                  let data = array[2].string
            else {
                continue
            }

            let event = CastEvent(time: time, type: type, data: data)
            parsedEvents.append(event)
        }

        self.header = header
        self.events = parsedEvents
    }

    /// The total duration of the recording in seconds.
    ///
    /// Calculated from the timestamp of the last event.
    var duration: TimeInterval {
        self.events.last?.time ?? 0
    }

    /// Plays the recording with its original timing, from one of its events on.
    ///
    /// - Parameters:
    ///   - firstIndex: Index of the first event to deliver (0 plays everything).
    ///   - startTime: The recording time playback starts at; the first event is delivered
    ///     after the time that separates it from this point.
    ///   - speed: Playback speed multiplier.
    ///   - onEvent: Called with each event and its index when its time comes.
    /// - Throws: `CancellationError` when the task is cancelled, which is how playback is
    ///   paused: this function runs in the caller's task, so cancelling that task stops it.
    @MainActor
    func play(
        fromEvent firstIndex: Int = 0,
        at startTime: TimeInterval = 0,
        speed: Double = 1.0,
        onEvent: @MainActor (Int, CastEvent) -> Void)
        async throws
    {
        var lastEventTime = startTime
        for index in self.events.indices.dropFirst(firstIndex) {
            let event = self.events[index]
            let waitTime = (event.time - lastEventTime) / speed
            if waitTime > 0 {
                try await Task.sleep(nanoseconds: UInt64(waitTime * 1_000_000_000))
            }
            try Task.checkCancellation()

            onEvent(index, event)
            lastEventTime = event.time
        }
    }
}
