import AppKit
import SwiftUI

/// A URL as a form row: title (and optional caption), the address as an accent link with
/// middle truncation, and quiet copy and open buttons.
///
/// One look on every screen that shows an address (Server, Tailscale, Cloudflare, Pinggy, ngrok).
struct URLRow: View {
    let title: Text
    let url: URL
    let caption: Text?

    @State private var didCopy = false

    init(title: Text, url: URL, caption: Text? = nil) {
        self.title = title
        self.url = url
        self.caption = caption
    }

    /// Literal titles and captions are localized (extracted into Localizable.xcstrings).
    init(_ title: LocalizedStringKey, url: URL, caption: LocalizedStringKey? = nil) {
        self.init(title: Text(title), url: url, caption: caption.map { Text($0) })
    }

    var body: some View {
        LabeledContent {
            HStack(spacing: DS.Spacing.s) {
                Link(destination: self.url) {
                    Text(verbatim: self.url.absoluteString)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .buttonStyle(.plain)
                .font(.body)
                .foregroundStyle(.tint)
                .help(Text(verbatim: self.url.absoluteString))
                // Addresses read left to right even in right-to-left languages.
                .environment(\.layoutDirection, .leftToRight)

                Button(action: self.copy) {
                    Image(systemName: self.didCopy ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help(Text("Copy address", comment: "Tooltip: button that copies an address"))
                .accessibilityLabel(
                    self.didCopy
                        ? Text("Copied", comment: "VoiceOver: copy button state after copying")
                        : Text("Copy \(self.title)", comment: "VoiceOver: copy button. Placeholder: the address's name, e.g. Public URL"))

                Button {
                    NSWorkspace.shared.open(self.url)
                } label: {
                    Image(systemName: "arrow.up.right.square")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help(Text("Open in browser", comment: "Tooltip: button that opens an address in the web browser"))
                .accessibilityLabel(Text("Open \(self.title)", comment: "VoiceOver: open button. Placeholder: the address's name, e.g. Public URL"))
            }
        } label: {
            self.title
            if let caption {
                caption
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func copy() {
        appPasteboard.clearContents()
        appPasteboard.setString(self.url.absoluteString, forType: .string)
        self.didCopy = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            self.didCopy = false
        }
    }
}

/// Legacy wrapper kept for existing call sites; renders a `URLRow`.
struct ClickableURLView: View {
    let label: LocalizedStringKey
    let url: String
    let showOpenButton: Bool

    init(label: LocalizedStringKey = "Address", url: String, showOpenButton: Bool = true) {
        self.label = label
        self.url = url
        self.showOpenButton = showOpenButton
    }

    var body: some View {
        URLTextRow(title: Text(self.label), value: self.url)
    }
}

/// Legacy inline wrapper; renders the same `URLRow`.
struct InlineClickableURLView: View {
    let label: LocalizedStringKey
    let url: String

    init(label: LocalizedStringKey = "Address", url: String) {
        self.label = label
        self.url = url
    }

    var body: some View {
        URLTextRow(title: Text(self.label), value: self.url)
    }
}

/// A `URLRow` for a string that may not parse as a URL; falls back to selectable text.
private struct URLTextRow: View {
    let title: Text
    let value: String

    var body: some View {
        if let url = URL(string: self.value), url.scheme != nil {
            URLRow(title: self.title, url: url)
        } else {
            LabeledContent {
                Text(verbatim: self.value)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(Text(verbatim: self.value))
                    .environment(\.layoutDirection, .leftToRight)
            } label: {
                self.title
            }
        }
    }
}

#Preview("URL rows") {
    Form {
        Section("Remote Access") {
            URLRow("Public URL", url: URL(string: "https://example.ngrok.io")!)
            URLRow(
                "Private URL",
                url: URL(string: "http://my-machine.tailnet.ts.net:4020")!,
                caption: "Only devices on your tailnet.")
            InlineClickableURLView(label: "Inline URL", url: "https://tunnel.trycloudflare.com")
        }
    }
    .formStyle(.grouped)
    .tint(DS.Accent.color)
    .frame(width: 520, height: 240)
}
