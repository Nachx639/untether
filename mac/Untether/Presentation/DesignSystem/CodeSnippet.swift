import AppKit
import SwiftUI

/// A monospaced command with a copy button.
struct CodeSnippet: View {
    let code: String
    @State private var didCopy = false

    init(_ code: String) {
        self.code = code
    }

    var body: some View {
        HStack(spacing: DS.Spacing.s) {
            Text(verbatim: self.code)
                .font(.body.monospaced())
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: DS.Spacing.s)

            Button {
                appPasteboard.clearContents()
                appPasteboard.setString(self.code, forType: .string)
                self.didCopy = true
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(1.5))
                    self.didCopy = false
                }
            } label: {
                Label(
                    self.didCopy
                        ? String(localized: "Copied", comment: "Copy button state after copying")
                        : String(localized: "Copy", comment: "Copy button: copies a value to the clipboard"),
                    systemImage: self.didCopy ? "checkmark" : "doc.on.doc")
                    .labelStyle(.iconOnly)
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .help(Text("Copy to Clipboard", comment: "Tooltip: copy button next to a command"))
            .accessibilityLabel(
                self.didCopy
                    ? Text("Copied", comment: "VoiceOver: copy button state after copying")
                    : Text("Copy \(self.code)", comment: "VoiceOver: copy button. Placeholder: the command to copy"))
        }
        // Commands read left to right even in right-to-left languages.
        .environment(\.layoutDirection, .leftToRight)
        .padding(.horizontal, DS.Spacing.m)
        .padding(.vertical, DS.Spacing.s)
        .background(.fill.tertiary, in: .ds(DS.Radius.small))
    }
}

#Preview {
    CodeSnippet("ut claude")
        .padding()
        .frame(width: 320)
}
