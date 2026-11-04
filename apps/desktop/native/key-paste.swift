import ApplicationServices
import CoreGraphics
import Foundation

// Synthesizes a ⌘V keystroke so Remember dictation can insert a transcript at
// the cursor in the frontmost app (the transcript is placed on the clipboard by
// the main process first). Requires the responsible app — Remember — to hold
// macOS Accessibility. Exit codes: 0 = pasted, 2 = no Accessibility, 1 = failure.

guard AXIsProcessTrusted() else {
    FileHandle.standardError.write("no-accessibility\n".data(using: .utf8)!)
    exit(2)
}

let vKeyCode: CGKeyCode = 0x09  // ANSI 'v'
guard let source = CGEventSource(stateID: .combinedSessionState),
    let keyDown = CGEvent(keyboardEventSource: source, virtualKey: vKeyCode, keyDown: true),
    let keyUp = CGEvent(keyboardEventSource: source, virtualKey: vKeyCode, keyDown: false)
else {
    exit(1)
}

keyDown.flags = .maskCommand
keyUp.flags = .maskCommand
keyDown.post(tap: .cghidEventTap)
keyUp.post(tap: .cghidEventTap)

// Give the events time to be delivered before the process exits.
usleep(20_000)
exit(0)
