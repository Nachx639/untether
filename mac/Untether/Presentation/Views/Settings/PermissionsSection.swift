import SwiftUI

/// System permissions configuration section
struct PermissionsSection: View {
    let hasAppleScriptPermission: Bool
    let hasAccessibilityPermission: Bool
    let permissionManager: SystemPermissionManager

    var body: some View {
        Section {
            PermissionRow(
                symbol: nil,
                title: "Automation",
                caption: "Open and control your terminal app.",
                isGranted: self.hasAppleScriptPermission,
                onGrant: { self.permissionManager.requestPermission(.appleScript) },
                onRefresh: { self.permissionManager.forcePermissionRecheck() })

            PermissionRow(
                symbol: nil,
                title: "Accessibility",
                caption: "Type startup commands into new terminal windows.",
                isGranted: self.hasAccessibilityPermission,
                onGrant: { self.permissionManager.requestPermission(.accessibility) },
                onRefresh: { self.permissionManager.forcePermissionRecheck() })
        } header: {
            Text("Permissions")
        } footer: {
            if !(self.hasAppleScriptPermission && self.hasAccessibilityPermission) {
                Text("Without these, \"ut\" can still capture terminals, but Untether can't open new windows.")
            }
        }
    }
}

#Preview {
    Form {
        PermissionsSection(
            hasAppleScriptPermission: true,
            hasAccessibilityPermission: false,
            permissionManager: SystemPermissionManager.shared)
    }
    .formStyle(.grouped)
    .frame(width: 560, height: 260)
}
