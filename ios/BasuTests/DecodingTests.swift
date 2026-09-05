import Foundation
import Testing

@testable import Basu

/**
 The payloads, decoded.

 These are not "does Swift parse JSON" tests. Every fixture here is a real
 response copied from the running server, and what they catch is the failure
 that has no other alarm: a field the API renames, a date format that loses its
 milliseconds, a state the phone has never heard of. All three show up as a
 blank screen rather than as an error.

 Only the shell's payloads are here. The food service decodes its own JSON in
 its own page, and `src/test/pages.test.ts` is where that is checked.
 */
struct DecodingTests {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      guard let date = ISODate.parse(text) else {
        throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: text))
      }
      return date
    }
    return try decoder.decode(type, from: Data(json.utf8))
  }

  @Test func liveOrderCarriesEverythingTheHomeScreenDraws() throws {
    let order = try decode(LiveOrder.self, """
      {
        "id": "38ecb474-7c42-471b-88b4-04b12a054a27",
        "code": "0970",
        "state": "PLACED",
        "restaurant": { "id": "43df612f", "name": "Модерн Номадс" },
        "table": "T10",
        "total_mnt": 32000,
        "slot_starts_at": "2026-09-01T03:30:00.000Z",
        "fire_at": null,
        "ready_at": null
      }
      """)

    #expect(order.code == "0970")
    #expect(order.state == .placed)
    #expect(order.restaurant.name == "Модерн Номадс")
    #expect(order.totalMnt == 32000)
    #expect(order.fireAt == nil)
  }

  @Test func aLiveIdeshCarriesADayNotAnInstant() throws {
    let order = try decode(LiveIdesh.self, """
      {
        "id": "8c1f2a2e-1d1e-4b4a-9f0e-2b1a3c4d5e6f",
        "code": "7003",
        "state": "PAID",
        "supplier": { "id": "s1", "name": "Архангай · Дорж" },
        "kind": "sheep",
        "unit": "whole",
        "title": "Хонь, залуу ирэг",
        "qty": 1,
        "total_mnt": 460000,
        "receive": "pickup",
        "receive_on": "2026-11-03",
        "paid_at": "2026-10-01T04:12:00.000Z"
      }
      """)

    #expect(order.code == "7003")
    #expect(order.state == .paid)
    #expect(order.supplier.name == "Архангай · Дорж")
    #expect(order.receiveOnDay == "2026-11-03")
    // The day is sorted as noon in Ulaanbaatar and printed as a day.
    #expect(Format.day(order.receiveOn) == "11/3")
    #expect(order.asLiveItem().timeLabel == "АВАХ")
    #expect(order.asLiveItem().when == "11/3")
  }

  @Test func anUnknownStateDoesNotBrickThePhone() throws {
    // A server that learns a new state should not take the app down with it.
    let order = try decode(LiveOrder.self, """
      {
        "id": "x", "code": "0001", "state": "TELEPORTED",
        "restaurant": { "id": "r", "name": "Ц" }, "table": null,
        "total_mnt": 1, "slot_starts_at": "2026-09-01T03:30:00.000Z",
        "fire_at": null, "ready_at": null
      }
      """)
    #expect(order.state == .placed)
  }

  @Test func timestampsSurviveWithAndWithoutMilliseconds() {
    #expect(ISODate.parse("2026-09-01T03:30:00.000Z") != nil)
    #expect(ISODate.parse("2026-09-01T03:30:00Z") != nil)
    #expect(ISODate.parse("half past eleven") == nil)
  }
}
