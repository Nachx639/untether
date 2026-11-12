import Observation
import SwiftUI

/// View model for the Add Server form (`AddServerView`).
@Observable
class ConnectionViewModel {
    var host: String = "127.0.0.1"
    var port: String = "4020"
    var name: String = ""
    var errorMessage: String?
}
