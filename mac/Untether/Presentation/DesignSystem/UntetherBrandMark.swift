import AppKit
import SwiftUI

/// The Untether app icon, used as the header of Welcome and About.
///
/// Uses the running app's icon so it always matches the Dock and Finder artwork.
/// `size` is the full icon canvas; the macOS template keeps its own margins and shadow.
struct UntetherBrandMark: View {
    var size: CGFloat = 96

    var body: some View {
        Image(nsImage: NSApplication.shared.applicationIconImage ?? NSImage())
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(width: self.size, height: self.size)
            .accessibilityLabel(Text(verbatim: "Untether"))
    }
}

#Preview {
    HStack {
        UntetherBrandMark(size: 64)
        UntetherBrandMark()
        UntetherBrandMark(size: 128)
    }
    .padding()
}
