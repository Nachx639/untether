import SwiftUI

/// A simplified terminal preview that shows only the last visible lines.
/// More efficient for small previews in session cards.
/// Compact terminal preview for session cards.
/// Displays a small, non-interactive view of terminal content.
struct CompactTerminalPreview: View {
    let snapshot: BufferSnapshot
    let maxLines: Int

    init(snapshot: BufferSnapshot, maxLines: Int = 6) {
        self.snapshot = snapshot
        self.maxLines = maxLines
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            // Get the last non-empty lines
            let visibleLines = self.getVisibleLines()

            ForEach(Array(visibleLines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(Theme.Typography.terminalSystem(size: 10))
                    .foregroundColor(Theme.Colors.terminalForeground.opacity(0.8))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
    }

    private func getVisibleLines() -> [String] {
        var lines: [String] = []

        // Start from the bottom and work up to find non-empty lines
        for row in (0..<self.snapshot.rows).reversed() {
            guard row < self.snapshot.cells.count else { continue }

            let line = self.snapshot.cells[row]
                .map { $0.char.isEmpty ? " " : $0.char }
                .joined()
                .trimmingCharacters(in: .whitespaces)

            if !line.isEmpty {
                lines.insert(line, at: 0)
                if lines.count >= self.maxLines {
                    break
                }
            }
        }

        // If we have fewer lines than maxLines, add empty lines at the top
        while lines.count < min(self.maxLines, self.snapshot.rows), lines.count < self.maxLines {
            lines.insert("", at: 0)
        }

        return lines
    }
}
