import XCTest

/**
 The demo server, from the test runner's side.

 The screens outside the app — the island, the lock screen, the widget — need
 something of the guest's to be running, and only the server can make that
 true. This places an order the way the phone does and takes it back after.
 */
struct DemoAPI {
  let base: URL

  struct Running {
    let id: String
    let token: String
  }

  /// Skips the calling test when nothing is listening.
  func requireServer() async throws {
    var request = URLRequest(url: base.appendingPathComponent("/health"))
    request.timeoutInterval = 3
    guard let (_, response) = try? await URLSession.shared.data(for: request),
          (response as? HTTPURLResponse)?.statusCode == 200
    else {
      throw XCTSkip("No API on \(base). Start it with `npm run dev`.")
    }
  }

  /// An order of the demo guest's that is running, made if there is none.
  func runningOrder() async throws -> Running {
    guard let token = try await post("/dev/login", ["phone": "+97699001122"])["token"] as? String else {
      throw XCTSkip("The demo server did not sign the demo guest in.")
    }
    let live = try await list("/v1/orders", token: token, key: "orders")
    let running = ["PLACED", "ACCEPTED", "SCHEDULED", "ARMED", "HELD", "RESLOTTED", "FIRED", "COOKING", "READY"]
    let soonest = Date().addingTimeInterval(20 * 60)
    if let mine = live.first(where: { order in
      guard running.contains(order["state"] as? String ?? ""), let raw = order["slot_starts_at"] as? String,
            let at = ISO8601DateFormatter.lenient.date(from: raw) else { return false }
      return at > soonest
    }), let id = mine["id"] as? String {
      return Running(id: id, token: token)
    }

    let restaurants = try await list("/v1/restaurants", key: "restaurants")
    guard let open = restaurants.first(where: { $0["accepting_orders"] as? Bool == true }),
          let venue = open["id"] as? String
    else { throw XCTSkip("No restaurant is accepting orders; run `npm run seed`.") }
    let menu = try await list("/v1/restaurants/\(venue)/menu", key: "items")
    guard let dish = menu.first(where: { $0["sold_out"] as? Bool == false })?["id"] as? String else {
      throw XCTSkip("Nothing on the menu.")
    }
    // A sitting still ahead on the *phone's* clock, not only the demo one:
    // the island and the widget run on real time, and a seating that is
    // already past on the wall is an order that is over.
    let slots = try await list("/v1/restaurants/\(venue)/slots", key: "slots")
    let ahead = slots.first { slot in
      guard slot["available"] as? Bool == true, let raw = slot["starts_at"] as? String,
            let at = ISO8601DateFormatter.lenient.date(from: raw) else { return false }
      return at > soonest
    }
    guard let slot = (ahead ?? slots.first { $0["available"] as? Bool == true })?["starts_at"] as? String else {
      throw XCTSkip("No free sitting left today.")
    }
    let placed = try await post(
      "/v1/orders",
      ["restaurant_id": venue, "slot_starts_at": slot, "party_size": 2,
       "items": [["menu_item_id": dish, "qty": 1]]],
      token: token,
    )
    guard let id = placed["id"] as? String else { throw XCTSkip("Could not place an order: \(placed)") }
    _ = try await post("/v1/orders/\(id)/pay", nil, token: token)
    return Running(id: id, token: token)
  }

  /// Take it back. Past the fire the server refuses, and that is its call.
  func cancel(_ order: Running) async {
    _ = try? await post("/v1/orders/\(order.id)/cancel", nil, token: order.token)
  }

  private func post(_ path: String, _ body: [String: Any]?, token: String? = nil) async throws -> [String: Any] {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    let (data, _) = try await URLSession.shared.data(for: request)
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }

  private func list(_ path: String, token: String? = nil, key: String) async throws -> [[String: Any]] {
    var request = URLRequest(url: base.appendingPathComponent(path))
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    let (data, _) = try await URLSession.shared.data(for: request)
    let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    return json[key] as? [[String: Any]] ?? []
  }
}

extension ISO8601DateFormatter {
  /// The server writes milliseconds; the strict formatter refuses them.
  static var lenient: ISO8601DateFormatter {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }
}
