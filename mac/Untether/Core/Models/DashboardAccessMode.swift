import Foundation

/// Dashboard access mode for the Untether server.
///
/// Determines the network binding configuration for the Untether server.
/// Controls whether the web interface is accessible only locally or
/// from other devices on the network.
enum DashboardAccessMode: String, CaseIterable {
    // Raw values are automatically inferred as "localhost", "network", and "custom"
    // These must match AppConstants.DashboardAccessModeRawValues
    case localhost
    case network
    case custom

    var displayName: String {
        switch self {
        case .localhost: String(localized: "Localhost only", comment: "Settings, Server: access mode, only this Mac")
        case .network: String(localized: "access.mode.network", defaultValue: "Network", comment: "Settings, Server: access mode, devices on the network")
        case .custom: String(localized: "Custom address", comment: "Settings, Server: access mode, a custom bind address")
        }
    }

    var fixedBindAddress: ServerBindAddress? {
        switch self {
        case .localhost: ServerBindAddress("127.0.0.1")
        case .network: ServerBindAddress("0.0.0.0")
        case .custom: nil
        }
    }

    func resolvedBindAddress(customAddress: String?) -> ServerBindAddress {
        self.fixedBindAddress ?? customAddress.flatMap(ServerBindAddress.init) ?? ServerBindAddress("127.0.0.1")!
    }

    var description: String {
        switch self {
        case .localhost: String(localized: "Only accessible from this Mac.", comment: "Settings, Server: access mode caption")
        case .network: String(localized: "Accessible from other devices on this network.", comment: "Settings, Server: access mode caption")
        case .custom: String(localized: "Bind to a specific IPv4 or IPv6 address.", comment: "Settings, Server: access mode caption")
        }
    }
}
