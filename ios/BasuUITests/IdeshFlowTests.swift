import XCTest

/**
 The second app, driven the way a thumb drives it.

 The page itself is tested where it lives — `src/test/pages.test.ts` runs it in
 a real DOM against a real server. What only the phone can prove is the join:
 that the icon is on the launcher, that tapping it shows the page rather than
 a blank view, that the page knows who is signed in without asking again, and
 that the way back is the shell's.

 Runs against the demo server on localhost and skips rather than fails when
 nothing is listening, like the other flows.
 */
@MainActor
final class IdeshFlowTests: XCTestCase {
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

  func testTheStallsOpenInsideTheAppForASignedInGuest() async throws {
    try await requireStalls()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launch()

    // ── the launcher has two apps now ─────────────────────────────────
    let idesh = app.buttons["app.Идэш"]
    XCTAssertTrue(idesh.waitForExistence(timeout: 10), "the home screen should offer the winter-meat app")
    XCTAssertTrue(app.buttons["app.Хоол"].exists, "…beside the dine-in one")
    shot("1-home-two-apps")

    // ── signed in, the demo way ───────────────────────────────────────
    app.buttons["home.account"].firstMatch.tap()
    let demo = app.buttons["signin.demo"]
    if demo.waitForExistence(timeout: 5) { demo.tap() }

    // ── the page, inside the app ──────────────────────────────────────
    // Signed in, the launcher puts whatever is running above the grid, and a
    // lazy grid below the fold has not drawn its tiles yet — so scroll to it.
    scroll(app, to: idesh)
    XCTAssertTrue(idesh.exists, "the tile should still be on the launcher after signing in")
    idesh.tap()

    let web = app.webViews.firstMatch
    XCTAssertTrue(web.waitForExistence(timeout: 15), "tapping the icon should show the page")
    // The page draws the stalls, which means it loaded and talked to the API.
    let heading = web.staticTexts["Өвлийн идэш"]
    XCTAssertTrue(heading.waitForExistence(timeout: 20), "the page should render its heading")
    // A stall is a <button>, and the accessibility tree folds its text into
    // the button's label — so it is found by label, not as a static text. The
    // chip is set in uppercase by CSS and WebKit reports it that way, hence
    // the case-insensitive match.
    let contracted = web.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS[cd] %@", "гэрээт"))
      .firstMatch
    XCTAssertTrue(contracted.waitForExistence(timeout: 20), "the stalls should be listed")
    shot("2-stalls-in-app")

    // The person is signed in already; the page must not have asked again.
    XCTAssertFalse(app.sheets.firstMatch.exists, "no sign-in sheet should appear over the page")

    // ── the way back is the shell's, and lands on the launcher ────────
    let back = app.buttons["idesh.home"]
    XCTAssertTrue(back.waitForExistence(timeout: 5), "the way back should name Basu")
    back.tap()
    let launcher = app.buttons["home.account"]
    XCTAssertTrue(launcher.waitForExistence(timeout: 10), "back should land on the launcher")
    scroll(app, to: idesh)
    XCTAssertTrue(idesh.exists, "…with the tile still there")
    shot("3-home-again")
  }

  /// Swipe until something is on screen, or give up after a screenful or ten.
  private func scroll(_ app: XCUIApplication, to element: XCUIElement, tries: Int = 10) {
    for _ in 0..<tries {
      if element.exists, element.isHittable { return }
      app.swipeUp()
    }
  }

  func testAStrangerIsAskedToSignInBeforeThePageOpens() async throws {
    try await requireStalls()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launch()

    let idesh = app.buttons["app.Идэш"]
    XCTAssertTrue(idesh.waitForExistence(timeout: 10))
    // Nobody signed in: the tile opens, but the page waits for a person.
    if app.buttons["home.account"].firstMatch.isEnabled {
      idesh.tap()
      XCTAssertTrue(
        app.buttons["idesh.signin"].waitForExistence(timeout: 10),
        "a stranger should be asked to sign in rather than shown a page that cannot buy",
      )
      shot("4-idesh-sign-in-first")
    } else {
      throw XCTSkip("The demo guest is already signed in on this simulator; the sign-in gate is not reachable.")
    }
  }

  // MARK: what the server says is possible right now

  private func requireStalls() async throws {
    guard let health = try? await get("/health"), !health.isEmpty else {
      throw XCTSkip("No API on \(base). Start it with `npm run dev`.")
    }
    let listings = (try await get("/v1/idesh/listings")["listings"] as? [[String: Any]]) ?? []
    guard !listings.isEmpty else {
      throw XCTSkip("No stalls are listed; run `npm run seed`.")
    }
  }

  private func get(_ path: String) async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent(path))
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }
}
