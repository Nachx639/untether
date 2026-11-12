import Observation
import SwiftUI
import UniformTypeIdentifiers

/// View for playing back terminal recordings from cast files.
///
/// Displays recorded terminal sessions with playback controls,
/// supporting the Asciinema cast v2 format.
struct CastPlayerView: View {
    let castFileURL: URL
    @Environment(\.dismiss)
    var dismiss
    @State private var viewModel = CastPlayerViewModel()
    @State private var fontSize: CGFloat = 14
    @State private var currentTime: TimeInterval = 0

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Colors.terminalBackground
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    if self.viewModel.isLoading {
                        self.loadingView
                    } else if let error = viewModel.errorMessage {
                        self.errorView(error)
                    } else if self.viewModel.player != nil {
                        self.playerContent
                    }
                }
            }
            .navigationTitle("Recording Playback")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Close") {
                        self.dismiss()
                    }
                    .foregroundColor(Theme.Colors.primaryAccent)
                }
            }
        }
        .navigationViewStyle(StackNavigationViewStyle())
        .onAppear {
            self.viewModel.loadCastFile(from: self.castFileURL)
        }
    }

    private var loadingView: some View {
        VStack(spacing: Theme.Spacing.large) {
            ProgressView()
                .progressViewStyle(CircularProgressViewStyle(tint: Theme.Colors.primaryAccent))
                .scaleEffect(1.5)

            Text("Loading recording...")
                .font(Theme.Typography.terminalSystem(size: 14))
                .foregroundColor(Theme.Colors.terminalForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorView(_ error: String) -> some View {
        VStack(spacing: Theme.Spacing.large) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundColor(Theme.Colors.errorAccent)

            Text("Failed to load recording")
                .font(.headline)
                .foregroundColor(Theme.Colors.terminalForeground)

            Text(error)
                .font(Theme.Typography.terminalSystem(size: 12))
                .foregroundColor(Theme.Colors.terminalForeground.opacity(0.7))
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var playerContent: some View {
        VStack(spacing: 0) {
            // Terminal display
            CastTerminalView(fontSize: self.$fontSize, viewModel: self.viewModel)
                .background(Theme.Colors.terminalBackground)

            // Playback controls
            VStack(spacing: Theme.Spacing.medium) {
                // Progress bar
                VStack(spacing: Theme.Spacing.extraSmall) {
                    Slider(value: self.$currentTime, in: 0...self.viewModel.duration) { editing in
                        if !editing {
                            // Show the new position (and go on from it when playing)
                            self.viewModel.seekTo(time: self.currentTime)
                        }
                    }
                    .accentColor(Theme.Colors.primaryAccent)

                    HStack {
                        Text(self.formatTime(self.currentTime))
                            .font(Theme.Typography.terminalSystem(size: 10))
                        Spacer()
                        Text(self.formatTime(self.viewModel.duration))
                            .font(Theme.Typography.terminalSystem(size: 10))
                    }
                    .foregroundColor(Theme.Colors.terminalForeground.opacity(0.7))
                }

                // Control buttons
                HStack(spacing: Theme.Spacing.extraLarge) {
                    // Speed control
                    Menu {
                        Button("0.5x") { self.viewModel.speed = 0.5 }
                        Button("1x") { self.viewModel.speed = 1.0 }
                        Button("2x") { self.viewModel.speed = 2.0 }
                        Button("4x") { self.viewModel.speed = 4.0 }
                    } label: {
                        Text("\(self.viewModel.speed, specifier: "%.1f")x")
                            .font(Theme.Typography.terminalSystem(size: 14))
                            .foregroundColor(Theme.Colors.primaryAccent)
                            .padding(.horizontal, Theme.Spacing.small)
                            .padding(.vertical, Theme.Spacing.extraSmall)
                            .background(
                                RoundedRectangle(cornerRadius: Theme.CornerRadius.small)
                                    .stroke(Theme.Colors.primaryAccent, lineWidth: 1))
                    }

                    // Play/Pause
                    Button(action: self.togglePlayback) {
                        Image(systemName: self.viewModel.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                            .font(.system(size: 44))
                            .foregroundColor(Theme.Colors.primaryAccent)
                    }

                    // Restart
                    Button(action: self.restart) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 20))
                            .foregroundColor(Theme.Colors.primaryAccent)
                    }
                }
            }
            .padding()
            .background(Theme.Colors.cardBackground)
        }
        .onChange(of: self.viewModel.currentTime) { _, newTime in
            if !self.viewModel.isSeeking {
                self.currentTime = newTime
            }
        }
    }

    private func togglePlayback() {
        if self.viewModel.isPlaying {
            self.viewModel.pause()
        } else {
            self.viewModel.play()
        }
    }

    private func restart() {
        self.viewModel.restart()
        self.currentTime = 0
    }

    private func formatTime(_ seconds: TimeInterval) -> String {
        let minutes = Int(seconds) / 60
        let remainingSeconds = Int(seconds) % 60
        return String(format: "%d:%02d", minutes, remainingSeconds)
    }
}

/// Terminal view specialized for cast file playback.
///
/// Provides a read-only terminal emulator for displaying recorded
/// terminal sessions, handling font sizing and terminal dimensions
/// based on the cast file metadata.
/// UIKit terminal view for rendering cast file playback.
/// Displays terminal content frame-by-frame during recording playback.
struct CastTerminalView: View {
    @Binding var fontSize: CGFloat
    let viewModel: CastPlayerViewModel

    private var terminalSize: GhosttyWebView.TerminalSize? {
        guard let header = viewModel.header else { return nil }
        return GhosttyWebView.TerminalSize(cols: Int(header.width), rows: Int(header.height))
    }

    var body: some View {
        GhosttyWebView(
            fontSize: self.$fontSize,
            theme: TerminalTheme.selected,
            onInput: nil,
            onResize: nil,
            viewModel: nil,
            disableInput: true,
            terminalSize: self.terminalSize,
            onReady: { coordinator in
                self.viewModel.onTerminalOutput = { [weak coordinator] data in
                    coordinator?.feedData(data)
                }
                self.viewModel.onTerminalClear = { [weak coordinator] in
                    coordinator?.clear()
                }
            })
    }
}

/// View model for cast file playback control.
/// View model for cast file playback control.
/// Manages playback state, timing, and frame navigation for recordings.
@MainActor
@Observable
class CastPlayerViewModel {
    var isLoading = true
    var errorMessage: String?
    var currentTime: TimeInterval = 0
    var isSeeking = false

    var player: CastPlayer?
    var header: CastFile? { self.player?.header }
    var duration: TimeInterval { self.player?.duration ?? 0 }

    var onTerminalOutput: ((String) -> Void)?
    var onTerminalClear: (() -> Void)?

    /// Whether the recording is playing now (it goes back to false when it reaches the end).
    private(set) var isPlaying = false
    /// Playback speed. Changing it while playing takes effect at once.
    var speed: Double = 1.0 {
        didSet {
            if self.isPlaying, oldValue != self.speed {
                self.startPlayback()
            }
        }
    }

    private var playbackTask: Task<Void, Never>?
    /// Index of the next event to show: everything before it is already on screen.
    private var nextEventIndex = 0

    func loadCastFile(from url: URL) {
        Task {
            // A file picked in the importer lives outside the sandbox and can only be read
            // between these two calls
            let scoped = url.startAccessingSecurityScopedResource()
            defer {
                if scoped { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let data = try Data(contentsOf: url)

                guard let player = CastPlayer(data: data) else {
                    self.errorMessage = "Invalid cast file format"
                    self.isLoading = false
                    return
                }

                self.player = player
                self.isLoading = false
            } catch {
                self.errorMessage = error.localizedDescription
                self.isLoading = false
            }
        }
    }

    func play() {
        guard let player else { return }
        // Play at the end starts over
        if self.nextEventIndex >= player.events.count {
            self.rewind()
        }
        self.isPlaying = true
        self.startPlayback()
    }

    /// (Re)starts the playback task from the current position. The previous task is
    /// cancelled first: 2026-11-10, pause cancelled a task that had already finished (the
    /// real loop ran in another one), so pause, restart and speed did nothing and resuming
    /// played the output twice.
    private func startPlayback() {
        self.playbackTask?.cancel()
        guard let player else { return }

        let firstIndex = self.nextEventIndex
        let startTime = self.currentTime
        let speed = self.speed
        self.playbackTask = Task { [weak self] in
            do {
                try await player.play(fromEvent: firstIndex, at: startTime, speed: speed) { index, event in
                    guard let self else { return }
                    if event.type == "o" {
                        self.onTerminalOutput?(event.data)
                    }
                    self.currentTime = event.time
                    self.nextEventIndex = index + 1
                }
                // Reached the end
                self?.isPlaying = false
            } catch {
                // Cancelled: paused, or replaced by a newer playback
            }
        }
    }

    func pause() {
        self.playbackTask?.cancel()
        self.playbackTask = nil
        self.isPlaying = false
    }

    func seekTo(time: TimeInterval) {
        guard let player else { return }
        self.playbackTask?.cancel()
        self.isSeeking = true
        self.currentTime = time

        // Clear terminal and replay up to the seek point instantly
        self.onTerminalClear?()
        self.nextEventIndex = player.events.firstIndex { $0.time > time } ?? player.events.count
        for event in player.events.prefix(self.nextEventIndex) where event.type == "o" {
            self.onTerminalOutput?(event.data)
        }

        self.isSeeking = false
        if self.isPlaying {
            self.startPlayback()
        }
    }

    func restart() {
        self.rewind()
        if self.isPlaying {
            self.startPlayback()
        }
    }

    private func rewind() {
        self.playbackTask?.cancel()
        self.currentTime = 0
        self.nextEventIndex = 0
        self.onTerminalClear?()
    }
}
