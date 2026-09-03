import XCTest

/**
 The whole flow, driven the way a thumb drives it.

 This is the app's answer to `npm run smoke`: not "does the view compile" but
 "can somebody actually buy lunch". It runs against the demo server on
 localhost — the same one `npm run dev` starts — and asks that server which
 restaurant is open rather than hard-coding a name the seed is free to change.

 If nothing is listening on :3000 the test says so and stops, because a red
 test that means "you forgot to start the server" is worse than no test.
 */
@MainActor
final class OrderFlowTests: XCTestCase {
  private let base = URL(string: ProcessInfo.processInfo.environment["BASU_API"] ?? "http://localhost:3000")!

  override func setUp() {
    continueAfterFailure = false
  }

  /// Keep a picture of each step. A test that passes says the buttons are
  /// wired; the pictures are how somebody checks the app is not hideous.
  private func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testAGuestCanFindLunchAndPayForIt() async throws {
    let venue = try await openVenue()
    // Yesterday's run left the demo guest holding lunch, and the app is right
    // to reopen it — which would put a status sheet over the map this test
    // needs to tap. So the guest starts the way a new one would.
    try await clearDemoGuest()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launch()

    // ── the launcher ─────────────────────────────────────────────────
    let dine = app.buttons["app.Хоол"]
    XCTAssertTrue(dine.waitForExistence(timeout: 10), "the home screen should offer the dine-in app")

    shot("1-home")

    // ── signing in, the demo way ─────────────────────────────────────
    app.buttons["home.account"].firstMatch.tap()
    let demo = app.buttons["signin.demo"]
    if demo.waitForExistence(timeout: 5) {
      demo.tap()
    } else if app.buttons["Хаах"].firstMatch.waitForExistence(timeout: 2) {
      // Already signed in from an earlier run; close the sheet and carry on.
      app.buttons["Хаах"].firstMatch.tap()
    }
    // Otherwise the guest was already signed in, the account button is inert,
    // and no sheet opened — nothing to dismiss.

    // ── the map ──────────────────────────────────────────────────────
    XCTAssertTrue(dine.waitForExistence(timeout: 10))
    dine.tap()

    // If anything of the guest's survived the reset, the app reopens it. Close
    // it rather than fail: the map is what this step is about.
    let reopened = app.buttons["status.close"]
    if reopened.waitForExistence(timeout: 3) { reopened.tap() }

    shot("2-map")

    let pin = app.otherElements["pin.\(venue.name)"]
    XCTAssertTrue(pin.waitForExistence(timeout: 15), "\(venue.name) should have a pin on the map")
    pin.tap()

    // ── the menu ─────────────────────────────────────────────────────
    let add = app.buttons["qty.\(venue.dish).plus"]
    XCTAssertTrue(add.waitForExistence(timeout: 10), "the menu should list \(venue.dish)")
    add.tap()

    // The sittings are under the menu, which is where they belong — nobody
    // picks 12:45 before they know they want the хуушуур — so the thumb has to
    // travel to reach them.
    shot("3-menu")

    let slot = app.buttons["slot.\(venue.slot)"]
    scroll(app, to: slot)
    XCTAssertTrue(slot.exists, "\(venue.slot) should be offered")
    slot.tap()

    // ── paying ───────────────────────────────────────────────────────
    let pay = app.buttons["venue.pay"]
    XCTAssertTrue(pay.waitForExistence(timeout: 5))
    XCTAssertTrue(pay.label.contains("төлөх"), "the button should quote the price, saw: \(pay.label)")
    pay.tap()

    // ── the order exists ─────────────────────────────────────────────
    // A fresh order is waiting for the kitchen to see it, and says so.
    let waiting = app.staticTexts["Хүлээгдэж байна"]
    XCTAssertTrue(
      waiting.waitForExistence(timeout: 20),
      "paying should land on the order's status, saw: \(app.sheets.count) sheet(s), "
        + "banner: \(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Алдаа")).count)",
    )
    XCTAssertTrue(app.otherElements["status.card"].exists, "the status card should be one element")
    shot("4-status")

    // …and the home screen knows about it without being told which one it is.
    app.buttons["status.close"].tap()
    app.buttons["dine.home"].tap()
    XCTAssertTrue(
      app.staticTexts[venue.name].waitForExistence(timeout: 10),
      "the live order should be on the launcher",
    )
    shot("5-home-with-order")
  }

  /// Cancel whatever the demo guest is still holding, so the run starts level.
  private func clearDemoGuest() async throws {
    guard let token = try await post("/dev/login", ["phone": "+97699001122"])["token"] as? String
    else { return }
    let mine = (try await get("/v1/orders", token: token)["orders"] as? [[String: Any]]) ?? []
    for order in mine {
      guard let id = order["id"] as? String else { continue }
      // Past the fire it cannot be cancelled, and that is the server's call to
      // make, not this test's — a refusal here is fine.
      _ = try? await post("/v1/orders/\(id)/cancel", nil, token: token)
    }
  }

  /// Swipe until something is on screen, or give up after a screenful or ten.
  private func scroll(_ app: XCUIApplication, to element: XCUIElement, tries: Int = 10) {
    for _ in 0..<tries {
      if element.exists, element.isHittable { return }
      app.swipeUp()
    }
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
    shot("6-offline")
  }

  // MARK: what the server says is possible right now

  private struct Venue {
    let id: String
    let name: String
    let dish: String
    let slot: String
  }

  /// A restaurant taking orders, one dish it has, and a sitting with room.
  private func openVenue() async throws -> Venue {
    guard let health = try? await get("/health"), health["ok"] != nil || !health.isEmpty else {
      throw XCTSkip("No API on \(base). Start it with `npm run dev`.")
    }

    let restaurants = try await list("/v1/restaurants", key: "restaurants")
    guard let open = restaurants.first(where: { $0["accepting_orders"] as? Bool == true }),
          let id = open["id"] as? String, let name = open["name"] as? String
    else {
      throw XCTSkip("No restaurant is accepting orders; run `npm run seed`.")
    }

    let menu = try await list("/v1/restaurants/\(id)/menu", key: "items")
    guard let dish = menu.first(where: { $0["sold_out"] as? Bool == false })?["name"] as? String else {
      throw XCTSkip("\(name) has nothing on the menu.")
    }

    let slots = try await list("/v1/restaurants/\(id)/slots", key: "slots")
    guard let slot = slots.first(where: { $0["available"] as? Bool == true })?["label"] as? String else {
      throw XCTSkip("\(name) has no free sitting left today.")
    }

    return Venue(id: id, name: name, dish: dish, slot: slot)
  }

  private func get(_ path: String, token: String? = nil) async throws -> [String: Any] {
    var request = URLRequest(url: base.appendingPathComponent(path))
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    return try await call(request)
  }

  private func post(
    _ path: String,
    _ body: [String: Any]?,
    token: String? = nil,
  ) async throws -> [String: Any] {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    return try await call(request)
  }

  private func call(_ request: URLRequest) async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(for: request)
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }

  private func list(_ path: String, key: String) async throws -> [[String: Any]] {
    (try await get(path)[key] as? [[String: Any]]) ?? []
  }
}
