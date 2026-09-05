import XCTest

/**
 The second app, driven the way a thumb drives it.

 The page itself is tested where it lives — `src/test/pages.test.ts` runs it in
 a real DOM against a real server, and `npm run smoke` walks a sheep from a
 stall to the handover. What only the phone can prove is the seam, the same
 four places the food app's test covers: the icon is on the launcher, tapping
 it shows the page rather than a blank view, the page is signed in as the
 shell's guest without asking again, and its `‹ Basu` is this screen's back.

 Runs against the demo server on localhost and skips rather than fails when
 nothing is listening, like the other flows.
 */
@MainActor
final class IdeshFlowTests: XCTestCase {
  private let base = URL(string: ProcessInfo.processInfo.environment["BASU_API"] ?? "http://localhost:3000")!
  private lazy var server = DemoAPI(base: base)

  override func setUp() {
    continueAfterFailure = false
  }

  private func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testTheIdeshIconOpensTheStallsAsTheShellsGuestAndComesBack() async throws {
    try await server.requireServer()
    try await requireStalls()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launch()

    // ── the launcher has two apps now ─────────────────────────────────
    let idesh = app.buttons["app.Идэш"]
    XCTAssertTrue(idesh.waitForExistence(timeout: 10), "the home screen should offer the winter-meat app")
    XCTAssertTrue(app.buttons["app.Хоол"].exists, "…beside the food one")
    shot("1-home-two-apps")

    // Signed out, the header offers the way in where the bell will be. Signed
    // in from an earlier run, there is a bell instead and nothing to do.
    if app.buttons["home.account"].waitForExistence(timeout: 2) {
      app.buttons["home.account"].firstMatch.tap()
      let demo = app.buttons["signin.demo"]
      if demo.waitForExistence(timeout: 5) { demo.tap() }
    }

    // ── the page, inside the app ──────────────────────────────────────
    // Signed in, whatever is running sits above the grid, and a lazy grid
    // below the fold has not drawn its tiles yet — so scroll to it.
    scroll(app, to: idesh)
    XCTAssertTrue(idesh.exists, "the tile should still be on the launcher after signing in")
    idesh.tap()

    let page = app.webViews.firstMatch
    XCTAssertTrue(page.waitForExistence(timeout: 15), "the icon should open a web page, not a native screen")
    XCTAssertFalse(app.buttons["tab.home"].exists, "an app takes the whole screen; the bar goes")

    let heading = page.staticTexts["Өвлийн идэш"]
    XCTAssertTrue(heading.waitForExistence(timeout: 20), "the page should render its heading")
    // A stall is a <button>, and the accessibility tree folds its text into
    // the button's label — found by label, not as a static text. The chip is
    // set in uppercase by CSS and WebKit reports it that way, hence [cd].
    let stall = page.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS[cd] %@", "гэрээт"))
      .firstMatch
    XCTAssertTrue(stall.waitForExistence(timeout: 20), "the stalls should be listed")
    // The shell's guest, already: the page must not have asked again.
    XCTAssertFalse(app.buttons["signin.demo"].exists, "no sign-in sheet should appear over the page")
    shot("2-stalls-in-app")

    // ── the way back is the page's own link, and it pops the shell ────
    let home = page.links["Basu нүүр"]
    XCTAssertTrue(home.waitForExistence(timeout: 10), "the page should carry its own way out")
    home.tap()
    XCTAssertTrue(app.buttons["tab.home"].waitForExistence(timeout: 10), "‹ Basu should land on the launcher")
    XCTAssertFalse(page.exists, "…and the page should be gone, not the web launcher inside it")
    shot("3-home-again")
  }

  /// Swipe until something is on screen, or give up after a screenful or ten.
  private func scroll(_ app: XCUIApplication, to element: XCUIElement, tries: Int = 10) {
    for _ in 0..<tries {
      if element.exists, element.isHittable { return }
      app.swipeUp()
    }
  }

  // MARK: what the server says is possible right now

  private func requireStalls() async throws {
    let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("/v1/idesh/listings"))
    let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    guard let listings = json["listings"] as? [[String: Any]], !listings.isEmpty else {
      throw XCTSkip("No stalls are listed; run `npm run seed`.")
    }
  }
}
