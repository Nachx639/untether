import Foundation

/// Centralized keychain service and account names
enum KeychainConstants {
    // MARK: - Service Names

    /// The test host keeps its items apart from the real ones (see isRunningTests).
    static let untetherService = isRunningTests ? "com.nachx639.untether.tests" : "com.nachx639.untether"

    // MARK: - Account Names

    static let ngrokAuthToken = "ngrokAuthToken"
    static let pinggyAccessToken = "pinggy-access-token"
    static let pangolinSiteCredentials = "pangolin-site-credentials"
    static let authToken = "authToken"
    static let dashboardPassword = "dashboard-password"
}
