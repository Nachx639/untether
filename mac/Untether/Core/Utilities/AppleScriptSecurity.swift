import CoreGraphics
import Foundation

/// Security utilities for AppleScript execution
enum AppleScriptSecurity {
    /// Escapes a string for safe use in AppleScript
    ///
    /// This function properly escapes all special characters that could be used
    /// for AppleScript injection attacks, including:
    /// - Double quotes (")
    /// - Backslashes (\)
    /// - Newlines and carriage returns
    /// - Tabs
    /// - Other control characters
    ///
    /// - Parameter string: The string to escape
    /// - Returns: The escaped string safe for use in AppleScript
    static func escapeString(_ string: String) -> String {
        var escaped = string

        // Order matters: escape backslashes first
        escaped = escaped.replacingOccurrences(of: "\\", with: "\\\\")
        escaped = escaped.replacingOccurrences(of: "\"", with: "\\\"")
        escaped = escaped.replacingOccurrences(of: "\n", with: "\\n")
        escaped = escaped.replacingOccurrences(of: "\r", with: "\\r")
        escaped = escaped.replacingOccurrences(of: "\t", with: "\\t")

        // Remove any other control characters that could cause issues
        let controlCharacterSet = CharacterSet.controlCharacters
        escaped = escaped.components(separatedBy: controlCharacterSet)
            .joined(separator: " ")

        return escaped
    }

    /// Escapes a numeric value for safe use in AppleScript
    ///
    /// - Parameter value: The numeric value
    /// - Returns: The string representation of the number
    static func escapeNumber(_ value: Int) -> String {
        String(value)
    }

    /// Escapes a numeric value for safe use in AppleScript
    ///
    /// - Parameter value: The numeric value (UInt32/CGWindowID)
    /// - Returns: The string representation of the number
    static func escapeNumber(_ value: UInt32) -> String {
        String(value)
    }
}
