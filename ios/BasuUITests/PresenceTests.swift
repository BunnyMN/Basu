import XCTest

/**
 The order outside the app: the Dynamic Island and the lock screen.

 Driven through Springboard, because that is where they live. Needs the demo
 server and an order of the demo guest's that is still running — `npm run
 ios:test` seeds one before this file runs. Skips rather than fails when there
 is nothing to show.
 */
@MainActor
final class PresenceTests: XCTestCase {
  private let base = URL(string: ProcessInfo.processInfo.environment["BASU_API"] ?? "http://localhost:3000")!

  override func setUp() { continueAfterFailure = false }

  private func shot(_ name: String, of app: XCUIApplication? = nil) {
    let image = app?.screenshot() ?? XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testTheOrderReachesTheIslandAndTheLockScreen() async throws {
    let server = DemoAPI(base: base)
    try await server.requireServer()
    let order = try await server.runningOrder()
    defer { Task { await server.cancel(order) } }

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launchEnvironment["BASU_DEMO_SIGNIN"] = "1"
    app.launch()

    // Something of the guest's has to be running, or there is no activity.
    let live = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'live.'"))
    XCTAssertTrue(live.firstMatch.waitForExistence(timeout: 15), "the order just placed should be on the launcher")
    shot("1-launcher-live")

    // ── the island ────────────────────────────────────────────────────
    XCUIDevice.shared.press(.home)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 10))
    try await Task.sleep(for: .seconds(2))
    shot("2-island-compact", of: springboard)

    // The seating time is the one number the island carries when compact.
    let compact = springboard.staticTexts.matching(NSPredicate(format: "label MATCHES '\\\\d\\\\d:\\\\d\\\\d'"))
    XCTAssertTrue(compact.firstMatch.waitForExistence(timeout: 10), "the compact island should show the seating time")

    // A tap opens the order in the app — the deep link. A press expands the
    // island: the venue, the stage, the same time over СУУХ, the bar.
    // Left of centre: with two activities live the food one keeps the wide
    // slot on the left and the other collapses to a circle on the right.
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.04)).press(forDuration: 1)
    try await Task.sleep(for: .seconds(1.5))
    shot("3-island-expanded", of: springboard)
    XCTAssertTrue(
      springboard.staticTexts["СУУХ"].waitForExistence(timeout: 5),
      "the expanded island should label the seating time",
    )
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)).tap()

    // Tapping the compact island is the deep link, and lands on the order.
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.04)).tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "the island should open the app")
    XCTAssertTrue(app.buttons["status.close"].waitForExistence(timeout: 10), "…on the order it refers to")
    shot("3b-deep-link")
    XCUIDevice.shared.press(.home)
    try await Task.sleep(for: .seconds(1))

    // ── the lock screen ───────────────────────────────────────────────
    XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
    try await Task.sleep(for: .seconds(2))
    shot("4-lock-screen", of: springboard)
    XCTAssertTrue(
      springboard.staticTexts["СУУХ"].waitForExistence(timeout: 5),
      "the lock screen card should be up",
    )
    if springboard.buttons["Allow"].waitForExistence(timeout: 2) { springboard.buttons["Allow"].tap() }

    // Back out: unlock, and bring the app up so the next test starts clean.
    XCUIDevice.shared.press(.home)
    springboard.swipeUp()
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    await server.cancel(order)
  }
}
