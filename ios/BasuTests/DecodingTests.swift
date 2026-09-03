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

  @Test func orderDetailKeepsTheCancelWindowAndTheLines() throws {
    let detail = try decode(OrderDetail.self, """
      {
        "lines": [{ "menu_item_id": "m1", "name": "Хуушуур", "qty": 2, "image_url": "/dishes/khuushuur.svg" }],
        "review": null,
        "can_review": false,
        "id": "o1",
        "code": "0971",
        "state": "SCHEDULED",
        "restaurant": { "id": "r1", "name": "Модерн Номадс" },
        "table": "T4",
        "total_mnt": 24000,
        "slot_starts_at": "2026-09-01T04:45:00.000Z",
        "fire_at": "2026-09-01T04:21:00.000Z",
        "ready_at": null,
        "free_cancel_until": "2026-09-01T04:21:00.000Z",
        "can_cancel": true,
        "receipt": null
      }
      """)

    #expect(detail.canCancel)
    #expect(detail.freeCancelUntil == detail.fireAt)
    #expect(detail.lines.first?.qty == 2)
    #expect(detail.state.subtitle == "Энэ цагт гал дээр гарна")
  }

  @Test func reviewsAreCamelCaseWhileOrdersAreNot() throws {
    // The API is snake_case except for the review payloads, which are not. A
    // blanket key strategy would silently empty one of them.
    let review = try decode(Review.self, """
      { "stars": 4, "onTime": true, "comment": "Сайхан", "dishes": [{ "menuItemId": "m1", "stars": 5 }] }
      """)
    #expect(review.onTime == true)
    #expect(review.dishes.first?.menuItemId == "m1")
  }

  @Test func slotsAndDishesDecode() throws {
    let slot = try decode(Slot.self, """
      { "starts_at": "2026-09-01T04:45:00.000Z", "label": "12:45", "available": true, "remaining": 2 }
      """)
    #expect(slot.label == "12:45")

    let table = try decode(DishTable.self, """
      {
        "fallback": { "form": "soup", "fill": "#B98A52", "detail": "#EFE3CC", "ground": "#EBE5D9" },
        "dishes": { "khuushuur": { "form": "fried", "fill": "#D9A03F", "detail": "#B87A28", "ground": "#EDE3D2" } }
      }
      """)
    #expect(table["khuushuur"].form == .fried)
    // A dish nobody drew still has something to show.
    #expect(table["a_dish_from_the_future"].form == .soup)
    #expect(table[nil].form == .soup)
  }

  @Test func timestampsSurviveWithAndWithoutMilliseconds() {
    #expect(ISODate.parse("2026-09-01T03:30:00.000Z") != nil)
    #expect(ISODate.parse("2026-09-01T03:30:00Z") != nil)
    #expect(ISODate.parse("half past eleven") == nil)
  }
}
