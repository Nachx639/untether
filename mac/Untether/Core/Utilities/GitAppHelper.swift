import Foundation

/// Helper utilities for Git app preferences
enum GitAppHelper {
    /// Get the display name of the preferred Git app or a default
    static func getPreferredGitAppName() -> String {
        if let preferredApp = AppConstants.getPreferredGitApp(),
           !preferredApp.isEmpty,
           let gitApp = GitApp(rawValue: preferredApp)
        {
            return gitApp.displayName
        }
        // Return first installed git app or default
        return GitApp.installed.first?.displayName ?? String(localized: "Git App", comment: "Generic name for a Git client app")
    }
}
