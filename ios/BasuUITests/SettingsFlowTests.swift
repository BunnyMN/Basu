import XCTest

/**
 The profile's settings, doing what they say.

 Appearance is checked by the colour of the ground itself — a pixel near the
 top of the screen — because the only thing «Бараан» promises is that the
 screen goes dark, the launcher behind the profile included. Each run puts it
 back on «Систем», so the next suite sees the phone's own setting.

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

  func testAppearanceTurnsTheWholeAppAndTheCacheClears() async throws {
    try await DemoAPI(base: base).requireServer()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launchEnvironment["BASU_DEMO_SIGNIN"] = "1"
    app.launch()
    app.signInIfSignedOut()
    XCTAssertEqual(app.landing(), .shell)

    app.buttons["tab.profile"].tap()
    let dark = app.buttons["settings.appearance.dark"]
    XCTAssertTrue(dark.waitForExistence(timeout: 10), "the profile offers light and dark")

    // ── dark, here and on the launcher ────────────────────────────────
    dark.tap()
    XCTAssertTrue(waitForGround(darker: true), "«Бараан» turns the profile dark")
    shot("1-dark-profile")
    app.buttons["tab.home"].tap()
    XCTAssertTrue(waitForGround(darker: true), "…and the launcher with it")
    shot("2-dark-home")

    // ── light, whatever the phone says ────────────────────────────────
    app.buttons["tab.profile"].tap()
    app.buttons["settings.appearance.light"].tap()
    XCTAssertTrue(waitForGround(darker: false), "«Цайвар» turns it light")
    shot("3-light-profile")

    // ── back to the phone's own ───────────────────────────────────────
    app.buttons["settings.appearance.system"].tap()
    XCTAssertTrue(app.buttons["settings.appearance.system"].isSelected, "«Систем» is the one chosen")

    // ── the kept pages ────────────────────────────────────────────────
    let cache = app.buttons["settings.cache"]
    for _ in 0..<4 where !cache.isHittable { app.swipeUp() }
    cache.tap()
    XCTAssertTrue(
      app.staticTexts["Цэвэрлэлээ"].waitForExistence(timeout: 5),
      "clearing the cache says it did",
    )
    XCTAssertTrue(app.buttons["profile.signout"].exists, "and nobody was signed out by it")
    shot("4-cache-cleared")
  }

  /// The ground just under the status bar, dark or light — asked until it
  /// settles, since the change is animated.
  private func waitForGround(darker: Bool, timeout: TimeInterval = 5) -> Bool {
    let deadline = Date.now.addingTimeInterval(timeout)
    repeat {
      if let luma = groundLuma(), darker ? luma < 0.25 : luma > 0.75 { return true }
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
