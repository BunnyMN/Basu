import XCTest

/**
 The shell's own three screens, driven the way a thumb drives them.

 Deliberately a separate test from the lunch one, and deliberately never touches
 a restaurant: wallet, profile and inbox belong to the platform, and if this
 test needed an order to exist first then they would not.

 Like the order flow, it runs against the demo server on localhost and skips
 rather than fails when nothing is listening — a red test that means "you forgot
 to start the server" is worse than no test.
 */
@MainActor
final class PlatformFlowTests: XCTestCase {
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

  func testTheWalletTopsUpAndTheInboxClears() async throws {
    try await requireServer()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launch()

    // ── in ────────────────────────────────────────────────────────────
    XCTAssertTrue(
      app.buttons["app.Хоол"].waitForExistence(timeout: 10),
      "the launcher should be up",
    )
    // Signed out, the header offers the way in where the bell will be. Signed
    // in from an earlier run, there is a bell instead and nothing to do.
    if app.buttons["home.account"].waitForExistence(timeout: 2) {
      app.buttons["home.account"].firstMatch.tap()
      let demo = app.buttons["signin.demo"]
      if demo.waitForExistence(timeout: 5) { demo.tap() }
    }

    // ── the launcher, signed in ───────────────────────────────────────
    XCTAssertTrue(
      app.buttons["app.Хоол"].waitForExistence(timeout: 10),
      "the launcher should be showing its one app",
    )
    shot("1-launcher")

    // ── the wallet, from the tab bar ──────────────────────────────────
    app.buttons["tab.wallet"].tap()
    let balance = app.staticTexts["wallet.balance"]
    XCTAssertTrue(balance.waitForExistence(timeout: 10), "the wallet should show a balance")
    let before = money(balance.label)
    shot("2-wallet")

    app.buttons["wallet.topup.20000"].tap()
    let confirm = app.buttons["QPay-ээр төлөх"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 5), "tapping an amount should ask first")
    confirm.tap()

    // The demo provider settles at once, so the number moves without leaving
    // the app. Against a real QPay this is where the deeplink would open.
    let grew = NSPredicate(format: "label != %@", balance.label)
    let changed = expectation(for: grew, evaluatedWith: balance)
    await fulfillment(of: [changed], timeout: 15)
    XCTAssertEqual(money(balance.label), before + 20_000, "topping up 20 000₮ should add 20 000₮")
    shot("3-wallet-topped-up")

    // ── the inbox, from the bell ──────────────────────────────────────
    // The wallet is a tab root: there is no back link, the launcher is a tab.
    XCTAssertFalse(app.buttons["shell.back"].exists, "a tab root has nothing to go back to")
    app.buttons["tab.home"].tap()
    XCTAssertTrue(app.buttons["home.inbox"].waitForExistence(timeout: 10))
    app.buttons["home.inbox"].tap()

    // The seeded welcome is there on the first run; a swipe below removes it,
    // so a later run finds the empty state instead. Both are the design.
    let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'inbox.'"))
    let empty = app.staticTexts["inbox.empty"]
    let landed = NSPredicate { _, _ in rows.count > 0 || empty.exists }
    await fulfillment(of: [expectation(for: landed, evaluatedWith: nil)], timeout: 10)
    XCTAssertFalse(app.buttons["inbox.readall"].exists, "there is no mark-all-read")
    shot("4-inbox")

    if rows.count > 0 {
      // Swiping a row left reveals Устгах; the row goes and the server agrees.
      let first = rows.firstMatch
      let rowsBefore = rows.count
      first.swipeLeft()
      let delete = app.buttons["inbox.delete"]
      XCTAssertTrue(delete.waitForExistence(timeout: 5), "swiping left should reveal Устгах")
      shot("4b-inbox-swiped")
      delete.tap()
      let fewer = NSPredicate { _, _ in rows.count == rowsBefore - 1 }
      await fulfillment(of: [expectation(for: fewer, evaluatedWith: nil)], timeout: 10)
      XCTAssertEqual(rows.count, rowsBefore - 1, "one row fewer, and nothing else moved")
    } else {
      XCTAssertTrue(empty.exists, "an empty inbox is a sentence, not a blank")
    }

    // ── the profile, from the tab bar ─────────────────────────────────
    app.buttons["shell.back"].tap()
    app.buttons["tab.profile"].tap()
    XCTAssertTrue(
      app.buttons["profile.name"].waitForExistence(timeout: 10),
      "the profile should offer the name for editing",
    )
    XCTAssertTrue(
      app.buttons["profile.signout"].exists,
      "signing out has to be reachable without hunting for it",
    )
    // This phone has to be in the list, or nobody can revoke a lost one.
    XCTAssertTrue(
      app.staticTexts["Энэ утас"].waitForExistence(timeout: 10),
      "the session list should mark the phone doing the asking",
    )
    shot("5-profile")

    // Closing an account is an App Store requirement, not a nice-to-have, and
    // it has to be reachable without asking anybody.
    app.swipeUp()
    XCTAssertTrue(
      app.buttons["profile.close"].waitForExistence(timeout: 5),
      "closing the account must be reachable in the app itself",
    )
    shot("6-profile-foot")
  }

  // MARK: - the wire

  /// `50,000₮` → `50000`. The label is what a person reads; this test is about
  /// the number underneath it.
  private func money(_ label: String) -> Int {
    Int(label.filter(\.isNumber)) ?? 0
  }

  private func requireServer() async throws {
    var request = URLRequest(url: base.appendingPathComponent("/health"))
    request.timeoutInterval = 3
    guard let (_, response) = try? await URLSession.shared.data(for: request),
          (response as? HTTPURLResponse)?.statusCode == 200
    else {
      throw XCTSkip("No API on \(base). Start it with `npm run dev`.")
    }
  }
}
