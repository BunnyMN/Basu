import XCTest

/**
 The App Store's pictures, taken by the phone itself.

 Not a test of anything: a walk through the app on the largest iPhone,
 saving what is on screen at each stop to the directory `BASU_SHOTS_DIR`
 names. Skipped when nothing names one, so `npm run ios:test` never waits
 on it. Wants the demo server on localhost with its seed.
 */
@MainActor
final class StoreShots: XCTestCase {
  private let base = URL(string: ProcessInfo.processInfo.environment["BASU_API"] ?? "http://localhost:3000")!
  private lazy var server = DemoAPI(base: base)

  override func setUp() {
    continueAfterFailure = true
  }

  private func save(_ name: String, to dir: URL) throws {
    let png = XCUIScreen.main.screenshot().pngRepresentation
    try png.write(to: dir.appendingPathComponent("\(name).png"))
  }

  /// A lazy grid draws its tiles as they come into view; swipe until this one has.
  private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    for _ in 0..<6 where !(element.exists && element.isHittable) {
      app.swipeUp()
    }
  }

  func testTakeTheStorePictures() async throws {
    guard let path = ProcessInfo.processInfo.environment["BASU_SHOTS_DIR"], !path.isEmpty else {
      throw XCTSkip("Set BASU_SHOTS_DIR to take the store pictures.")
    }
    let dir = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try await server.requireServer()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launchEnvironment["BASU_DEMO_SIGNIN"] = "1"
    app.launch()

    let idesh = app.buttons["app.Идэш"]
    XCTAssertTrue(app.staticTexts["Basu"].firstMatch.waitForExistence(timeout: 30) || idesh.waitForExistence(timeout: 5))
    app.signInIfSignedOut()
    try await Task.sleep(for: .seconds(2))
    try save("1-home", to: dir)

    // ── the food app ──
    let food = app.buttons["app.Хоол"]
    reveal(food, in: app)
    food.tap()
    let page = app.webViews.firstMatch
    XCTAssertTrue(page.waitForExistence(timeout: 15))
    // The map draws its tiles and pins over the network; give it a moment.
    try await Task.sleep(for: .seconds(10))
    try save("2-food", to: dir)
    let back = page.links["Basu нүүр"]
    if back.waitForExistence(timeout: 5) { back.tap() } else { app.buttons["tab.home"].firstMatch.tap() }

    // ── the winter meat ──
    XCTAssertTrue(idesh.waitForExistence(timeout: 15))
    reveal(idesh, in: app)
    idesh.tap()
    XCTAssertTrue(page.waitForExistence(timeout: 15))
    // A stall is a <button> whose label folds in its chip; the trust strip
    // above the list says «гэрээт» too, so ask for buttons only.
    let stall = page.buttons
      .matching(NSPredicate(format: "label CONTAINS[cd] %@ AND label CONTAINS %@", "гэрээт", "₮"))
      .firstMatch
    XCTAssertTrue(stall.waitForExistence(timeout: 20))
    try await Task.sleep(for: .seconds(2))
    try save("3-idesh", to: dir)

    stall.tap()
    let next = page.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Үргэлжлүүлэх")).firstMatch
    XCTAssertTrue(next.waitForExistence(timeout: 15))
    try await Task.sleep(for: .seconds(2))
    try save("4-stall", to: dir)

    next.tap()
    let pay = page.buttons["Төлөх"]
    if pay.waitForExistence(timeout: 10) {
      try await Task.sleep(for: .seconds(1))
      try save("5-review", to: dir)
      pay.tap()
      let paid = page.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "баталгаажлаа")).firstMatch
      if paid.waitForExistence(timeout: 20) {
        try await Task.sleep(for: .seconds(2))
        try save("6-paid", to: dir)
        // …and the launcher, with the order now running above the apps. A
        // fresh launch lands there, which is also how a guest next sees it.
        app.terminate()
        app.launch()
        if app.staticTexts["ИДЭВХТЭЙ"].waitForExistence(timeout: 20) {
          try await Task.sleep(for: .seconds(2))
          try save("7-home-live", to: dir)
        }
      }
    }
  }
}
