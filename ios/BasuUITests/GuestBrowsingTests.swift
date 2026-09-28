import XCTest

/**
 Looking around without an account — what App Review asks for (guideline
 5.1.1(v); 1.0.3 was sent back for it on 2026-09-26).

 The way in stays the first screen, with «Бүртгэлгүйгээр үзэх» at its top.
 Past it: the launcher and both apps' stalls and menus open without an
 account; the wallet and the profile offer the way in rather than forcing
 it; and the header's «Нэвтрэх» brings the doors as a sheet.

 Runs against the developer's server on localhost and skips when nothing is
 listening. Ends signed out on the way in, as it began.
 */
@MainActor
final class GuestBrowsingTests: XCTestCase {
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

  func testAStrangerBrowsesTheStallsAndIsAskedOnlyForWhatIsTheirs() async throws {
    try await DemoAPI(base: base).requireServer()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launchEnvironment["BASU_SCREEN"] = "signin"
    app.launch()

    // ── the way in, and the way past it ──────────────────────────────
    let browse = app.buttons["signin.browse"]
    XCTAssertTrue(browse.waitForExistence(timeout: 15), "«Бүртгэлгүйгээр үзэх» is on the first screen")
    XCTAssertTrue(browse.isHittable, "…where it is seen without scrolling")
    shot("1-gate")
    browse.tap()

    // ── the launcher, signed out ─────────────────────────────────────
    XCTAssertTrue(app.buttons["app.Идэш"].waitForExistence(timeout: 10), "a stranger sees the apps")
    XCTAssertTrue(app.buttons["home.account"].exists, "and the way in where the bell would be")
    XCTAssertFalse(app.buttons["home.inbox"].exists, "no bell: nothing to be told yet")
    shot("2-launcher")

    // ── the stalls, without an account ───────────────────────────────
    app.buttons["app.Идэш"].tap()
    let page = app.webViews.firstMatch
    XCTAssertTrue(page.waitForExistence(timeout: 15))
    let stall = page.buttons.matching(NSPredicate(format: "label CONTAINS %@", "₮")).firstMatch
    XCTAssertTrue(stall.waitForExistence(timeout: 20), "the stalls show with no account")
    XCTAssertFalse(app.buttons["signin.apple"].exists, "and nothing asks to sign in just to look")
    shot("3-stalls")
    let home = page.links["Basu нүүр"]
    if home.waitForExistence(timeout: 5) { home.tap() } else { app.swipeRight() }
    XCTAssertTrue(app.buttons["tab.home"].waitForExistence(timeout: 10))

    // ── what is the account's offers the way in ──────────────────────
    app.buttons["tab.wallet"].tap()
    XCTAssertTrue(app.buttons["wallet.signin"].waitForExistence(timeout: 5), "the wallet is the account's")
    shot("4-wallet")
    app.buttons["tab.profile"].tap()
    XCTAssertTrue(app.buttons["profile.signin"].waitForExistence(timeout: 5), "so is the profile")
    XCTAssertTrue(app.buttons["settings.appearance.dark"].exists, "but how this phone looks is not")
    XCTAssertFalse(app.buttons["settings.lock"].exists, "and a lock guards an account, so none yet")
    app.buttons["profile.signin"].tap()
    XCTAssertTrue(app.buttons["signin.apple"].waitForExistence(timeout: 5), "the doors, as a sheet")
    shot("5-sheet")
  }
}
