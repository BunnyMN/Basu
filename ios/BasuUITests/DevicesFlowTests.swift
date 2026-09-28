import XCTest

/**
 «Нэвтэрсэн төхөөрөмж» after a lot of signing in: readable, and emptied in
 one tap.

 The demo guest is signed in on a handful of other devices first, the way a
 few weeks of real use leave an account. The profile shows this phone and
 three others, the rest behind «Бүгдийг харах»; «Бусад … төхөөрөмжөөс
 гаргах» leaves this phone alone.

 Runs against the developer's server on localhost and skips when nothing is
 listening, like the other flows.
 */
@MainActor
final class DevicesFlowTests: XCTestCase {
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

  func testManyDevicesStayReadableAndGoInOneTap() async throws {
    let server = DemoAPI(base: base)
    try await server.requireServer()
    for device in ["iPhone 15", "Вэб", "iPad", "Батын MacBook", "Вэб"] {
      _ = try await server.guestToken(device: device)
    }

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launchEnvironment["BASU_DEMO_SIGNIN"] = "1"
    app.launch()
    app.signInIfSignedOut()
    XCTAssertEqual(app.landing(), .shell)

    app.buttons["tab.profile"].tap()
    let all = app.buttons["profile.devices.all"]
    reveal(all, in: app)
    XCTAssertTrue(all.exists, "past three others, the rest wait behind «Бүгдийг харах»")
    XCTAssertEqual(
      app.descendants(matching: .any).matching(identifier: "profile.device").count, 4,
      "this phone and three others, not every session",
    )
    shot("1-devices")

    all.tap()
    XCTAssertTrue(app.navigationBars["Бусад төхөөрөмж"].waitForExistence(timeout: 5), "the whole list opens on its own")
    shot("2-all-devices")
    app.buttons["Болсон"].tap()

    let out = app.buttons["profile.revokeothers"]
    reveal(out, in: app)
    out.tap()
    let confirm = app.buttons["Гаргах"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 5), "everywhere else goes only once asked")
    confirm.tap()
    let gone = NSPredicate(format: "exists == false")
    let emptied = expectation(for: gone, evaluatedWith: out)
    await fulfillment(of: [emptied], timeout: 10)
    XCTAssertFalse(all.exists, "with nobody else signed in there is nothing behind «Бүгдийг харах»")
    XCTAssertTrue(app.buttons["profile.signout"].exists, "and this phone is still in")
    shot("3-only-this-phone")
  }

  /// Clear of the tab bar, which lies over the bottom of the scroll.
  private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    let bar = app.buttons["tab.home"].frame.minY
    for _ in 0..<10 where !(element.exists && element.frame.maxY < bar - 8) {
      app.swipeUp(velocity: .slow)
    }
  }
}
