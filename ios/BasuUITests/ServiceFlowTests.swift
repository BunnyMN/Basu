import XCTest

/**
 An app inside the shell, driven the way a thumb drives it.

 The food service is a web page, and what it does — the map, the menu, paying,
 the status — is `npm run smoke`'s and `pages.test.ts`'s to prove. What this
 proves is the seam: that tapping the icon opens the page, that the page is
 signed in as the shell's guest rather than as nobody, that its `‹ Basu` is
 this screen's back, and that the lock screen's deep link lands on the order
 inside the page. Those four are the only places the native and the web halves
 can disagree, so they are the four that get a test.

 It runs against the demo server on localhost — the same one `npm run dev`
 starts. If nothing is listening the test says so and stops, because a red
 test that means "you forgot to start the server" is worse than no test.
 */
@MainActor
final class ServiceFlowTests: XCTestCase {
  private let base = URL(string: ProcessInfo.processInfo.environment["BASU_API"] ?? "http://localhost:3000")!
  private lazy var server = DemoAPI(base: base)

  override func setUp() {
    continueAfterFailure = false
  }

  /// Keep a picture of each step. A test that passes says the seam holds; the
  /// pictures are how somebody checks the page looks like it belongs.
  private func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testTheFoodIconOpensThePageAsTheShellsGuestAndComesBack() async throws {
    try await server.requireServer()
    // Something of the guest's running, so the page has a status to show and
    // the launcher has a row — which is how the two halves are seen to agree.
    let order = try await server.runningOrder()
    defer { Task { await server.cancel(order) } }

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launch()

    // ── the launcher ─────────────────────────────────────────────────
    let food = app.buttons["app.Хоол"]
    XCTAssertTrue(food.waitForExistence(timeout: 10), "the home screen should offer the food app")

    // Signed out, the header offers the way in where the bell will be. Signed
    // in from an earlier run, there is a bell instead and nothing to do.
    if app.buttons["home.account"].waitForExistence(timeout: 2) {
      app.buttons["home.account"].firstMatch.tap()
      let demo = app.buttons["signin.demo"]
      if demo.waitForExistence(timeout: 5) { demo.tap() }
    }
    XCTAssertTrue(
      app.staticTexts["ИДЭВХТЭЙ"].waitForExistence(timeout: 15),
      "the order should be on the launcher",
    )
    shot("1-home")

    // ── the page ─────────────────────────────────────────────────────
    XCTAssertTrue(food.waitForExistence(timeout: 10))
    food.tap()

    let page = app.webViews.firstMatch
    XCTAssertTrue(page.waitForExistence(timeout: 15), "the icon should open a web page, not a native screen")
    XCTAssertFalse(app.buttons["tab.home"].exists, "an app takes the whole screen; the bar goes")

    // The page is signed in as the shell's guest: it reopens the guest's own
    // order rather than showing a stranger an empty map. The order number is
    // the one thing on the status sheet that only the right guest could see.
    let number = page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '№'")).firstMatch
    XCTAssertTrue(number.waitForExistence(timeout: 30), "the page should be the shell's guest, with their order")
    shot("2-page")

    // ── the way back ─────────────────────────────────────────────────
    // The status sheet sits over the map with a scrim behind it, so the map's
    // corner is reached the way a thumb reaches it: close the sheet first.
    let close = page.buttons["Хаах"]
    if close.waitForExistence(timeout: 3) { close.tap() }

    // `‹ Basu` is a link to `/` — the web launcher in a browser, this screen's
    // parent here. It pops rather than loading the web launcher inside itself.
    let home = page.links["Basu нүүр"]
    XCTAssertTrue(home.waitForExistence(timeout: 10), "the page should carry its own way out")
    home.tap()
    XCTAssertTrue(food.waitForExistence(timeout: 10), "‹ Basu should land on the launcher")
    XCTAssertFalse(page.exists, "…and the page should be gone, not the web launcher inside it")
    XCTAssertTrue(app.buttons["tab.home"].exists, "the bar is back with the shell")
    shot("3-home-again")

    // ── the deep link ────────────────────────────────────────────────
    // The lock screen card, the island and both widgets all open this. It
    // must land inside the page, on the order — not on the map to search.
    XCUIDevice.shared.system.open(URL(string: "basu://order/\(order.id)")!)
    XCTAssertTrue(page.waitForExistence(timeout: 15), "the deep link should open the food app")
    XCTAssertTrue(number.waitForExistence(timeout: 30), "…on the order it names")
    shot("4-deep-link")
  }

  /// The failure the developer met first: the API was not running and the app
  /// simply looked empty. An empty screen is not an answer.
  func testAnUnreachableServerSaysSoRatherThanLookingEmpty() async throws {
    let app = XCUIApplication()
    // Nothing listens on the discard port, so the connection is refused at
    // once — the same shape as a server that was never started.
    app.launchEnvironment["BASU_API"] = "http://127.0.0.1:9"
    app.launch()

    XCTAssertTrue(
      app.staticTexts["Серверт холбогдож чадсангүй"].waitForExistence(timeout: 20),
      "an unreachable server should say so on the home screen",
    )
    XCTAssertTrue(app.buttons["offline.retry"].exists, "…and offer to try again")
    XCTAssertTrue(app.otherElements["offline.banner"].exists, "…as one element")
    shot("5-offline")

    // The same inside an app: a page that cannot load is said out loud too,
    // over the page's place, rather than left as a white rectangle.
    app.buttons["app.Хоол"].tap()
    XCTAssertTrue(
      app.staticTexts["Серверт холбогдож чадсангүй"].waitForExistence(timeout: 20),
      "an app that cannot load should say so",
    )
    shot("6-offline-in-app")
  }
}
