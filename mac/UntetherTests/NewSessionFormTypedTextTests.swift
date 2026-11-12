import SwiftUI
import Testing
@testable import Untether

// 2026-11-11: the menu closed on a click outside (or when another app took the focus) while
// the new session form had text typed in it, and the text was lost: the flag that should
// have held the menu open was never set.
@Suite("New session form keeps the menu open while it holds typed text")
@MainActor
struct NewSessionFormTypedTextTests {
    @Test
    func aNameACommandOrAFolderTypedIsText() {
        func typed(name: String = "", command: String = "zsh", directory: String = "~/Projects") -> Bool {
            NewSessionForm.hasTypedText(
                sessionName: name, command: command, workingDirectory: directory,
                loadedCommand: "zsh", loadedWorkingDirectory: "~/Projects")
        }
        #expect(!typed())
        #expect(!typed(name: "   "))
        #expect(typed(name: "deploy"))
        #expect(typed(command: "zsh -l"))
        #expect(typed(command: ""))
        #expect(typed(directory: "~/Projects/untether"))
    }

    @Test
    func theMenuClosesByItselfOnlyWithoutTypedTextOrAFolderDialog() {
        #expect(CustomMenuWindow.closesByItself(newSessionHasTypedText: false, fileSelectionInProgress: false))
        #expect(!CustomMenuWindow.closesByItself(newSessionHasTypedText: true, fileSelectionInProgress: false))
        #expect(!CustomMenuWindow.closesByItself(newSessionHasTypedText: false, fileSelectionInProgress: true))
    }

    @Test
    func losingTheKeyWindowKeepsTheMenuWhileTheFormHoldsText() {
        var hides = 0
        let window = CustomMenuWindow(contentView: EmptyView())
        window.onHide = { hides += 1 }

        window.newSessionHasTypedText = true
        window.resignKey()
        #expect(hides == 0)
        #expect(window.newSessionHasTypedText) // still held: nothing reset it

        window.newSessionHasTypedText = false
        window.resignKey()
        #expect(hides == 1)
    }
}
