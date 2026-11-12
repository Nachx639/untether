import SwiftUI

// MARK: - Identifiable Error

/// Makes any Error conform to Identifiable for SwiftUI presentation.
/// Wraps errors with a unique ID to enable SwiftUI sheet and alert presentation.
struct IdentifiableError: Identifiable {
    let id = UUID()
    let error: Error
}

/// View extension for identifiable error alerts.
/// Enables error presentation using SwiftUI's item-based alert API.
extension View {
    /// Presents an error alert using an identifiable error wrapper
    func errorAlert(item: Binding<IdentifiableError?>) -> some View {
        alert(item: item) { identifiableError in
            Alert(
                title: Text("Error"),
                message: Text(identifiableError.error.localizedDescription),
                dismissButton: .default(Text("OK")))
        }
    }
}

// MARK: - Error Recovery

/// Protocol for errors that can provide recovery suggestions.
/// Enables errors to provide user-friendly recovery guidance.
protocol RecoverableError: Error {
    var recoverySuggestion: String? { get }
}

/// APIError extension for recovery suggestions.
/// Provides user-friendly recovery messages for API-related errors.
extension APIError: RecoverableError {
    var recoverySuggestion: String? {
        switch self {
        case .noServerConfigured:
            "Please configure a server connection in Settings."
        case .networkError:
            "Check your internet connection and try again."
        case let .serverError(code, _):
            switch code {
            case 401:
                "Check your authentication credentials in Settings."
            case 500...599:
                "The server is experiencing issues. Please try again later."
            default:
                nil
            }
        case .resizeDisabledByServer:
            "Terminal resizing is not supported by this server."
        default:
            nil
        }
    }
}

// MARK: - Error Banner View

/// A reusable error banner component.
/// Displays inline error messages with optional offline indicators and dismiss actions.
struct ErrorBanner: View {
    let message: String
    let isOffline: Bool
    let onDismiss: (() -> Void)?

    init(
        message: String,
        isOffline: Bool = false,
        onDismiss: (() -> Void)? = nil)
    {
        self.message = message
        self.isOffline = isOffline
        self.onDismiss = onDismiss
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            Image(systemName: self.isOffline ? "wifi.exclamationmark" : "exclamationmark.triangle.fill")
                .font(.system(size: 14))

            Text(self.message)
                .font(Theme.Typography.terminalSystem(size: 13))
                .fixedSize(horizontal: false, vertical: true)

            Spacer()

            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundColor(Theme.Colors.terminalForeground.opacity(0.5))
                }
            }
        }
        .foregroundColor(Theme.Colors.errorAccent)
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.vertical, Theme.Spacing.small)
        .background(
            RoundedRectangle(cornerRadius: Theme.CornerRadius.small)
                .fill(Theme.Colors.errorAccent.opacity(0.15)))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.CornerRadius.small)
                .stroke(Theme.Colors.errorAccent.opacity(0.3), lineWidth: 1))
        .padding(.horizontal)
    }
}
