import XCTest

/**
 The supplier's page inside the app, and the way out of it.

 Inside the app the page's corner button is the way home — one tap back to
 the launcher. It never signs anybody out and never draws a way in of its
 own (no «Код авах» inside a page inside the app).

 Signs in as a seeded supplier's owner through the developer door, so it
 runs against the developer's server on localhost and skips when nothing is
 listening. Signs out again at the end: the next suite expects the demo
 guest or nobody.
 */
@MainActor
final class SupplierFlowTests: XCTestCase {
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

  func testTheCornerButtonGoesHomeNotToASignInForm() async throws {
    try await DemoAPI(base: base).requireServer()
    guard let owner = try await supplierOwnerPhone() else { throw XCTSkip("No seeded supplier with an owner.") }

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launchEnvironment["BASU_SCREEN"] = "signin"
    app.launch()

    // ── in, as the supplier's owner ──────────────────────────────────
    let passwordWay = app.buttons["signin.passwordWay"]
    XCTAssertTrue(passwordWay.waitForExistence(timeout: 15))
    passwordWay.tap()
    let login = app.textFields["signin.login"]
    XCTAssertTrue(login.waitForExistence(timeout: 5))
    login.tap()
    login.typeText(owner)
    let demo = app.buttons["signin.demo"]
    for _ in 0..<4 where !demo.isHittable { app.swipeUp() }
    demo.tap()

    // ── the supplier's tile, and its page ────────────────────────────
    let tile = app.buttons["app.Нийлүүлэгч"]
    XCTAssertTrue(tile.waitForExistence(timeout: 15), "a supplier's owner has the supplier tile")
    tile.tap()
    let page = app.webViews.firstMatch
    XCTAssertTrue(page.waitForExistence(timeout: 15))
    let home = page.buttons["Basu нүүр"]
    XCTAssertTrue(home.waitForExistence(timeout: 20), "inside the app the corner button is the way home")
    // A supplier who has never been asked about notifications is asked as
    // the counter opens (`PushAsk`): its one button, then iOS's own sheet.
    let ask = app.buttons["push.continue"]
    if ask.waitForExistence(timeout: 3) {
      ask.tap()
      let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
      if alert.waitForExistence(timeout: 5) { alert.buttons.element(boundBy: 0).tap() }
    }
    shot("1-supplier-page")

    // ── one tap, and the launcher ────────────────────────────────────
    home.tap()
    XCTAssertTrue(app.buttons["tab.home"].waitForExistence(timeout: 10), "the corner button lands on the launcher")
    XCTAssertFalse(page.exists, "…with the page gone")
    XCTAssertFalse(app.staticTexts["Код авах"].exists, "and no web sign-in anywhere")
    XCTAssertFalse(app.buttons["signin.apple"].exists, "still signed in: going home is not signing out")
    // Leaving the page cancels its last question to the server. A cancelled
    // question is not a server that is down: no banner, and the tile stays.
    try await Task.sleep(for: .seconds(2))
    XCTAssertFalse(app.otherElements["offline.banner"].exists, "leaving a page is not losing the server")
    XCTAssertTrue(tile.waitForExistence(timeout: 5), "and the supplier's tile is still on the launcher")
    shot("2-home")

    // ── out, for the next suite ──────────────────────────────────────
    app.buttons["tab.profile"].tap()
    let out = app.buttons["profile.signout"]
    let bar = app.buttons["tab.home"].frame.minY
    for _ in 0..<10 where !(out.exists && out.frame.maxY < bar - 8) { app.swipeUp(velocity: .slow) }
    out.tap()
    XCTAssertTrue(app.buttons["signin.apple"].waitForExistence(timeout: 10))
  }

  private func supplierOwnerPhone() async throws -> String? {
    let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("/dev/suppliers"))
    let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    let suppliers = json["suppliers"] as? [[String: Any]] ?? []
    return suppliers.compactMap { $0["phone"] as? String }.first
  }
}
