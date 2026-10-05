import XCTest

/**
 The profile's settings, doing what they say — and the app dark on every
 screen, whatever the phone's own appearance.

 «Тансаг хар» (2026-10-05) took away the light-or-dark choice: Basu is dark
 everywhere. That is checked by the colour of the ground itself — a pixel near
 the top of the screen — on the profile and on the launcher, because the only
 thing the promise means is that the screen is dark.

 The lock needs a face, which a test cannot give; `AppLockTests` covers when
 it asks, and a run with an enrolled simulator face can go further by hand.

 Runs against the developer's server on localhost and skips when nothing is
 listening, like the other flows.
 */
@MainActor
final class SettingsFlowTests: XCTestCase {
  private let base = URL(string: ProcessInfo.processInfo.environment["BASU_API"] ?? "http://localhost:3000")!

  override func setUp() {
    continueAfterFailure = false
  }

  private func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testTheAppIsDarkAndTheCacheClears() async throws {
    try await DemoAPI(base: base).requireServer()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launchEnvironment["BASU_DEMO_SIGNIN"] = "1"
    app.launch()
    app.signInIfSignedOut()
    XCTAssertEqual(app.landing(), .shell)

    // ── dark, here and on the launcher, with no choice to make ─────────
    app.buttons["tab.profile"].tap()
    XCTAssertTrue(app.buttons["profile.signout"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["settings.appearance.light"].exists, "there is no light to choose")
    XCTAssertTrue(waitForDarkGround(), "the profile is dark")
    shot("1-dark-profile")
    app.buttons["tab.home"].tap()
    XCTAssertTrue(waitForDarkGround(), "…and the launcher with it")
    shot("2-dark-home")

    // ── the kept pages ────────────────────────────────────────────────
    app.buttons["tab.profile"].tap()
    // Clear of the tab bar, which lies over the bottom of the scroll: a
    // row under it is «hittable» and the tap lands on the bar.
    let cache = app.buttons["settings.cache"]
    let bar = app.buttons["tab.home"].frame.minY
    for _ in 0..<8 where !(cache.exists && cache.frame.maxY < bar - 8) { app.swipeUp(velocity: .slow) }
    cache.tap()
    XCTAssertTrue(
      app.staticTexts["Цэвэрлэлээ"].waitForExistence(timeout: 5),
      "clearing the cache says it did",
    )
    XCTAssertTrue(app.buttons["profile.signout"].exists, "and nobody was signed out by it")
    shot("3-cache-cleared")
  }

  /// The ground just under the status bar is dark — asked until it settles,
  /// since the first frame may still be the splash fading.
  private func waitForDarkGround(timeout: TimeInterval = 5) -> Bool {
    let deadline = Date.now.addingTimeInterval(timeout)
    repeat {
      if let luma = groundLuma(), luma < 0.15 { return true }
      _ = XCTWaiter.wait(for: [XCTestExpectation(description: "settle")], timeout: 0.3)
    } while Date.now < deadline
    return false
  }

  private func groundLuma() -> CGFloat? {
    let image = XCUIScreen.main.screenshot().image
    guard let cg = image.cgImage else { return nil }
    // Left edge, a little below the status bar: ground, never a card.
    let x = Int(CGFloat(cg.width) * 0.02)
    let y = Int(CGFloat(cg.height) * 0.065)
    var pixel = [UInt8](repeating: 0, count: 4)
    guard let context = CGContext(
      data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
    ) else { return nil }
    context.draw(cg, in: CGRect(x: -x, y: y - cg.height + 1, width: cg.width, height: cg.height))
    return (0.299 * CGFloat(pixel[0]) + 0.587 * CGFloat(pixel[1]) + 0.114 * CGFloat(pixel[2])) / 255
  }
}
