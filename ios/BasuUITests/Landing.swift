import XCTest

/**
 Where a launch lands, and the way past it.

 Signed out, the app opens on the way in and nothing else — no launcher, no
 tab bar. Signed in from an earlier run, it opens on the launcher. The
 keychain outlives a run, so a test cannot know which, and asks.
 */
@MainActor
extension XCUIApplication {
  enum Landing { case shell, gate, neither }

  /// The splash covers both for a moment; this waits it out.
  func landing(timeout: TimeInterval = 15) -> Landing {
    let bar = buttons["tab.home"]
    let apple = buttons["signin.apple"]
    let deadline = Date.now.addingTimeInterval(timeout)
    repeat {
      if bar.exists { return .shell }
      if apple.exists { return .gate }
      _ = bar.waitForExistence(timeout: 0.5)
    } while Date.now < deadline
    return .neither
  }

  /// On the gate, the debug door straight to the demo guest — a developer's
  /// own server only, and at the foot of the doors, so perhaps below the fold.
  func signInIfSignedOut() {
    guard landing() == .gate else { return }
    let demo = buttons["signin.demo"]
    if !demo.waitForExistence(timeout: 3) { swipeUp() }
    if demo.waitForExistence(timeout: 5) { demo.tap() }
  }
}
