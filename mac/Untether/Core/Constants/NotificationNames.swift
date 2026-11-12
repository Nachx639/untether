import Foundation

/// Centralized notification names
extension Notification.Name {
    // MARK: - Settings

    static let showSettings = Notification.Name("\(BundleIdentifiers.untether).showSettings")

    // MARK: - Welcome

    static let showWelcomeScreen = Notification.Name("showWelcomeScreen")

    // MARK: - Services

    static let notificationServiceConnectionChanged = Notification.Name("notificationServiceConnectionChanged")
}
