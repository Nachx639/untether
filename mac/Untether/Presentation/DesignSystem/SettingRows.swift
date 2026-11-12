import SwiftUI

// Localization: every row takes its title and caption as `Text`. Literal call sites
// resolve to the `LocalizedStringKey` overloads (extracted into Localizable.xcstrings);
// `String` values (already localized or technical) use the `@_disfavoredOverload`
// initialisers and render verbatim, the way `Text` itself does.

/// A form row: title with an optional one-line caption, trailing control.
///
/// Built on `LabeledContent` so it aligns with native controls in a grouped `Form`.
struct SettingRow<Content: View>: View {
    let title: Text
    let caption: Text?
    let content: Content

    init(title: Text, caption: Text? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.caption = caption
        self.content = content()
    }

    init(_ title: LocalizedStringKey, caption: LocalizedStringKey? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: Text(title), caption: caption.map { Text($0) }, content: content)
    }

    @_disfavoredOverload
    init(_ title: some StringProtocol, caption: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: Text(title), caption: caption.map { Text($0) }, content: content)
    }

    var body: some View {
        LabeledContent {
            self.content
        } label: {
            self.title
            if let caption {
                caption
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// A native toggle with an optional caption under its title.
struct ToggleRow: View {
    let title: Text
    let caption: Text?
    @Binding var isOn: Bool

    init(title: Text, caption: Text? = nil, isOn: Binding<Bool>) {
        self.title = title
        self.caption = caption
        self._isOn = isOn
    }

    init(_ title: LocalizedStringKey, caption: LocalizedStringKey? = nil, isOn: Binding<Bool>) {
        self.init(title: Text(title), caption: caption.map { Text($0) }, isOn: isOn)
    }

    @_disfavoredOverload
    init(_ title: some StringProtocol, caption: String? = nil, isOn: Binding<Bool>) {
        self.init(title: Text(title), caption: caption.map { Text($0) }, isOn: isOn)
    }

    var body: some View {
        Toggle(isOn: self.$isOn) {
            self.title
            if let caption {
                caption
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// A folder or file path as a form row: title, a full-width field with a "Choose…" button,
/// and the caption underneath so it never wraps against the field.
struct PathFieldRow<Trailing: View>: View {
    let title: Text
    let caption: Text?
    let prompt: Text
    @Binding var path: String
    let onChoose: () -> Void
    let trailing: Trailing

    init(
        _ title: LocalizedStringKey,
        caption: LocalizedStringKey? = nil,
        prompt: LocalizedStringKey,
        path: Binding<String>,
        onChoose: @escaping () -> Void,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() })
    {
        self.init(
            title: Text(title),
            caption: caption.map { Text($0) },
            prompt: Text(prompt),
            path: path,
            onChoose: onChoose,
            trailing: trailing)
    }

    init(
        title: Text,
        caption: Text? = nil,
        prompt: Text,
        path: Binding<String>,
        onChoose: @escaping () -> Void,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() })
    {
        self.title = title
        self.caption = caption
        self.prompt = prompt
        self._path = path
        self.onChoose = onChoose
        self.trailing = trailing()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.xs) {
            HStack(spacing: DS.Spacing.s) {
                self.title
                Spacer(minLength: DS.Spacing.s)
                self.trailing
            }
            HStack(spacing: DS.Spacing.s) {
                TextField(text: self.$path, prompt: self.prompt) { self.title }
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 220, maxWidth: .infinity)
                    .help(Text(verbatim: self.path))
                    // Paths read left to right even in right-to-left languages.
                    .environment(\.layoutDirection, .leftToRight)
                Button(String(localized: "Choose…", comment: "Settings: button that opens a folder or file picker"), action: self.onChoose)
            }
            if let caption {
                caption
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A system permission with its state and the action that grants it.
///
/// Works inside a grouped `Form` and on its own (Welcome).
struct PermissionRow: View {
    let symbol: String?
    let title: LocalizedStringKey
    let caption: LocalizedStringKey
    let isGranted: Bool
    var grantTitle: LocalizedStringKey = "Grant…"
    let onGrant: () -> Void
    var onRefresh: (() -> Void)?

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 28)
                    .accessibilityHidden(true)
            }

            VStack(alignment: .leading, spacing: DS.Spacing.xxs) {
                Text(self.title)
                Text(self.caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: DS.Spacing.m)

            if self.isGranted {
                StatusBadge("Granted", kind: .ok)
                    .font(.callout)
                    .contextMenu {
                        if let onRefresh {
                            Button("Refresh Status", action: onRefresh)
                        }
                        Button("Open System Settings…", action: self.onGrant)
                    }
            } else {
                Button(self.grantTitle, action: self.onGrant)
                    .accessibilityLabel(Text(self.grantTitle) + Text(verbatim: " ") + Text(self.title))
            }
        }
        .accessibilityElement(children: .contain)
    }
}

#Preview("Rows") {
    Form {
        Section {
            ToggleRow("Launch at Login", caption: "Start Untether when you log in.", isOn: .constant(true))
            SettingRow("Port", caption: "Restarts the server.") { Text("4020") }
            PermissionRow(
                symbol: "applescript",
                title: "Automation",
                caption: "Open and control your terminal.",
                isGranted: false,
                onGrant: {})
        }
    }
    .formStyle(.grouped)
    .frame(width: 520, height: 300)
}
