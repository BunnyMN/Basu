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
      app.buttons["home.account"].waitForExistence(timeout: 10),
      "the launcher should be up",
    )
    app.buttons["home.account"].firstMatch.tap()
    let demo = app.buttons["signin.demo"]
    if demo.waitForExistence(timeout: 5) {
      demo.tap()
    }
    // Already signed in, the account button is inert and no sheet opens — the
    // profile is a tab now, so there is nothing to back out of.

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
    app.buttons["shell.back"].tap()
    XCTAssertTrue(app.buttons["home.inbox"].waitForExistence(timeout: 10))
    app.buttons["home.inbox"].tap()

    let welcome = app.buttons["inbox.welcome"]
    XCTAssertTrue(
      welcome.waitForExistence(timeout: 10),
      "the seeded welcome message should be in the inbox",
    )
    shot("4-inbox")

    if app.buttons["inbox.readall"].exists {
      app.buttons["inbox.readall"].tap()
      XCTAssertFalse(
        app.buttons["inbox.readall"].waitForExistence(timeout: 5),
        "with nothing unread the read-all button should go away",
      )
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
    shot("5-profile")
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
