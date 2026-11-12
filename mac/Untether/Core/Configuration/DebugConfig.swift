import Foundation

/// Debug configuration.
///
/// This struct manages the debug setting of Untether (development features).
struct DebugConfig {
    /// Whether debug mode is enabled.
    ///
    /// When `true`, additional debugging features are enabled such as:
    /// - More verbose logging output
    /// - Development-only UI elements
    /// - Diagnostic information in the interface
    /// - Relaxed security restrictions for testing
    let debugMode: Bool

    /// Creates a debug configuration from current user defaults.
    ///
    /// This factory method reads the current debug settings from user defaults
    /// to create a configuration instance that reflects the user's preferences.
    ///
    /// - Returns: A `DebugConfig` instance with current debug settings.
    static func current() -> Self {
        Self(
            debugMode: AppConstants.boolValue(for: AppConstants.UserDefaultsKeys.debugMode))
    }
}
