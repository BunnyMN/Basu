import XCTest

/**
 The Home Screen widget, added the way a person adds it and looked at.

 Driven through Springboard's own edit mode. It removes what it added, so the
 simulator is left the way it was found. Skips when nothing of the demo
 guest's is running: the widget's populated state is what this photographs.
 */
@MainActor
final class WidgetTests: XCTestCase {
  private let base = URL(string: ProcessInfo.processInfo.environment["BASU_API"] ?? "http://localhost:3000")!

  override func setUp() { continueAfterFailure = false }

  private func shot(_ name: String, of app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testTheWidgetShowsTheOrderInBothSizes() async throws {
    let server = DemoAPI(base: base)
    try await server.requireServer()
    let order = try await server.runningOrder()
    defer { Task { await server.cancel(order) } }

    // The app first, so the snapshot in the App Group is fresh.
    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launchEnvironment["BASU_DEMO_SIGNIN"] = "1"
    app.launch()
    let live = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'live.'"))
    XCTAssertTrue(live.firstMatch.waitForExistence(timeout: 15), "the order just placed should be on the launcher")
    XCUIDevice.shared.press(.home)

    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 10))
    try await Task.sleep(for: .seconds(1))

    // Anything an earlier run left behind goes first, so the screen has one.
    for _ in 0..<4 {
      let stale = springboard.staticTexts.matching(
        NSPredicate(format: "label BEGINSWITH 'СУУХ' OR label BEGINSWITH 'Захиалга алга'"),
      ).firstMatch
      guard stale.waitForExistence(timeout: 2) else { break }
      removeWidget(at: stale, on: springboard)
    }

    // ── add it ────────────────────────────────────────────────────────
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(forDuration: 2)
    let edit = springboard.buttons["Edit"]
    XCTAssertTrue(edit.waitForExistence(timeout: 5), "a long press should open edit mode")
    edit.tap()
    let addWidget = springboard.buttons["Add Widget"]
    XCTAssertTrue(addWidget.waitForExistence(timeout: 5))
    addWidget.tap()

    let search = springboard.searchFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 5), "the widget gallery should have a search field")
    search.tap()
    search.typeText("Basu")
    let ours = springboard.cells.matching(NSPredicate(format: "label CONTAINS 'Basu'")).firstMatch
    XCTAssertTrue(ours.waitForExistence(timeout: 5), "the gallery should list Basu")
    ours.tap()
    try await Task.sleep(for: .seconds(1.5))
    shot("1-gallery-small", of: springboard)

    // The gallery pages through the sizes; the second page is the medium.
    springboard.swipeLeft()
    try await Task.sleep(for: .seconds(1))
    shot("2-gallery-medium", of: springboard)

    let add = springboard.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS 'Add Widget' AND elementType != 8")).firstMatch
    XCTAssertTrue(add.waitForExistence(timeout: 5), "the gallery should offer to add it")
    add.tap()
    try await Task.sleep(for: .seconds(1.5))
    let done = springboard.buttons["Done"]
    if done.waitForExistence(timeout: 3) { done.tap() }
    try await Task.sleep(for: .seconds(2))
    shot("3-home-with-widget", of: springboard)

    // The medium widget carries the venue and the stage; the sentence is the
    // empty state, and must not be what is showing now.
    // `СУУХ` on the medium, `СУУХ · №0971` on the small — whichever page
    // the gallery landed on, the seating time is labelled.
    let label = springboard.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'СУУХ'")).firstMatch
    XCTAssertTrue(label.waitForExistence(timeout: 10), "the widget should show the seating time's label")
    XCTAssertFalse(springboard.staticTexts["Захиалга алга. Товшиж хоол сонгоно."].exists)

    // ── and take it away again ────────────────────────────────────────
    removeWidget(at: label, on: springboard)
    XCUIDevice.shared.press(.home)
    await server.cancel(order)
  }

  /// Long-press a widget, Remove, confirm, and leave edit mode.
  private func removeWidget(at element: XCUIElement, on springboard: XCUIApplication) {
    element.press(forDuration: 2)
    let remove = springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove'")).firstMatch
    if remove.waitForExistence(timeout: 5) {
      remove.tap()
      let confirm = springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove'")).firstMatch
      if confirm.waitForExistence(timeout: 3) { confirm.tap() }
    }
    let done = springboard.buttons["Done"]
    if done.waitForExistence(timeout: 3) { done.tap() }
    XCUIDevice.shared.press(.home)
  }
}
