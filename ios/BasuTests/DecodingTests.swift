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
    // A whole animal is counted in heads, the web's word for it.
    #expect(order.asLiveItem().detail == "Хонь, залуу ирэг · 1 толгой · Төлсөн")
  }

  @Test func anIdeshIsOnTheLockScreenOnlyOnItsDay() throws {
    func idesh(_ state: String, on day: String, receive: String = "pickup") throws -> LiveIdesh {
      try decode(LiveIdesh.self, """
        {
          "id": "i", "code": "7042", "state": "\(state)",
          "supplier": { "id": "s", "name": "Архангай · Дорж" },
          "kind": "sheep", "unit": "whole", "title": "Хонь, залуу ирэг", "qty": 1, "total_mnt": 460000,
          "receive": "\(receive)", "receive_on": "\(day)", "paid_at": null,
          "pickup_address": "Нарантуул, хойд хаалга"
        }
        """)
    }
    let today = "2026-09-12"
    // Next week's sheep is not a thing to watch from the island.
    #expect(try !idesh("READY", on: "2026-09-19").wantsCard(today: today))
    #expect(try idesh("PAID", on: today).wantsCard(today: today))
    #expect(try idesh("READY", on: "2026-09-11").wantsCard(today: today))
    // On the road is today, whatever day was booked.
    #expect(try idesh("DISPATCHED", on: "2026-09-19", receive: "delivery").wantsCard(today: today))
    // In hand, or cancelled: the card says its last word and goes.
    #expect(try !idesh("HANDED", on: today).wantsCard(today: today))
    #expect(try idesh("HANDED", on: today).cardOver)

    let ready = try idesh("READY", on: today)
    #expect(ready.activityState == .init(state: "READY", word: "Бэлэн", step: 3, receiveOn: today))
    #expect(ready.cardAttributes.what == "Хонь, залуу ирэг · 1 толгой")
    #expect(ready.cardAttributes.code == "7042")
    #expect(ready.cardAttributes.pickupAddress == "Нарантуул, хойд хаалга")
    // A delivery's card never carries an address: a lock screen is public.
    #expect(try idesh("DISPATCHED", on: today, receive: "delivery").cardAttributes.pickupAddress == nil)
  }

  @Test func meatByTheKiloIsSaidInKilosNotTimes() throws {
    let order = try decode(LiveIdesh.self, """
      {
        "id": "8c1f2a2e-1d1e-4b4a-9f0e-2b1a3c4d5e70",
        "code": "7001",
        "state": "PREPARING",
        "supplier": { "id": "s3", "name": "Улаанбаатар махны төв" },
        "kind": "sheep",
        "unit": "kg",
        "title": "Хонины мах, кг-аар",
        "qty": 10,
        "total_mnt": 128000,
        "receive": "delivery",
        "receive_on": "2026-10-03",
        "paid_at": "2026-10-01T04:12:00.000Z"
      }
      """)
    let row = order.asLiveItem()
    // «Хонины мах, кг-аар ×10» read as a multiplication.
    #expect(row.detail == "Хонины мах · 10 кг · Бэлтгэж байна")
    #expect(row.timeLabel == "ИРЭХ")
    // Being prepared is on the fire — the second step of four, not on the way.
    #expect(row.status == .cooking)
    #expect(row.step == 2)
    #expect(row.word == "Бэлтгэж байна")
    #expect(row.headline == "Хонины мах · 10 кг")
    #expect(row.spoken.contains("10-р сарын 3-нд ирэх"))
  }

  @Test func anIdeshOrderWalksTheMeterAndEndsInAWord() throws {
    func idesh(_ state: String, kind: String? = "sheep") throws -> LiveItem {
      try decode(LiveIdesh.self, """
        {
          "id": "i", "code": "7001", "state": "\(state)",
          "supplier": { "id": "s", "name": "Улаанбаатар махны төв" },
          \(kind.map { "\"kind\": \"\($0)\"," } ?? "")
          "unit": "kg", "title": "Хонины мах, кг-аар", "qty": 10, "total_mnt": 128000,
          "receive": "pickup", "receive_on": "2026-10-07", "paid_at": null
        }
        """).asLiveItem()
    }
    // Төлсөн, Бэлтгэж байна, Бэлэн, then Замд or Хүлээлгэн өгсөн.
    #expect(try idesh("PAID").step == 1)
    #expect(try idesh("PREPARING").step == 2)
    #expect(try idesh("READY").step == 3)
    #expect(try idesh("DISPATCHED").step == 4)
    #expect(try idesh("HANDED").step == 4)
    // Over without happening: the word alone, crimson or gold, no meter.
    #expect(try idesh("CANCELLED").step == 0)
    #expect(try idesh("CANCELLED").tone == .stop)
    #expect(try idesh("REFUNDED").tone == .hold)
    #expect(try idesh("HANDED").finished)
    #expect(try !idesh("READY").finished)
    // The animal's own photograph, when the order says which; none otherwise.
    #expect(try idesh("PAID").photo?.path().hasSuffix("/idesh/sheep.jpg") == true)
    #expect(try idesh("PAID", kind: nil).photo == nil)
    #expect(try idesh("PAID", kind: "camel").photo == nil)
  }

  @Test func eachLunchStateSitsOnItsStepOfTheMeter() throws {
    func lunch(_ state: String) throws -> LiveItem {
      try decode(LiveOrder.self, """
        {
          "id": "o", "code": "0970", "state": "\(state)",
          "restaurant": { "id": "r", "name": "Бөмбөгөр Ресторан" }, "table": null,
          "total_mnt": 1, "slot_starts_at": "2026-09-01T04:00:00.000Z",
          "fire_at": null, "ready_at": null
        }
        """).asLiveItem(expanded: false)
    }
    #expect(try lunch("COOKING").status == .cooking)
    #expect(try lunch("FIRED").status == .cooking)
    #expect(try lunch("PLACED").status == .waiting)
    #expect(try lunch("READY").status == .ready)
    #expect(try lunch("PLACED").step == 1)
    #expect(try lunch("FIRED").step == 2)
    #expect(try lunch("READY").step == 3)
    #expect(try lunch("SERVED").step == 4)
    #expect(try lunch("CANCELLED").step == 0)
    #expect(try lunch("CANCELLED").tone == .stop)
    #expect(try lunch("SERVED").finished)
    #expect(try lunch("PLACED").headline == "Бөмбөгөр Ресторан")
    #expect(try lunch("PLACED").timeLabel == "ИРЭХ")
    #expect(try lunch("PLACED").spoken.hasPrefix("Хоол, Бөмбөгөр Ресторан, 12:00 цагт ирэх, захиалга 0970"))
  }

  @Test func theLiveRowSaysWhatTheWebLauncherSays() throws {
    func word(_ state: String) throws -> String {
      try decode(LiveOrder.self, """
        {
          "id": "o", "code": "0970", "state": "\(state)",
          "restaurant": { "id": "r", "name": "Ц" }, "table": null,
          "total_mnt": 1, "slot_starts_at": "2026-09-01T04:00:00.000Z",
          "fire_at": null, "ready_at": null
        }
        """).asLiveItem(expanded: false).detail
    }
    #expect(try word("PLACED") == "Хүлээгдэж байна")
    // The states the shared headline names by a time: the status sheet's
    // words, never «SCHEDULED» in English on the first screen.
    #expect(try word("SCHEDULED") == "Хүлээн авсан")
    #expect(try word("ARMED") == "Хөдлөх цаг")
    #expect(try word("COOKING") == "Гал дээр")
    #expect(try word("FIRED") == "Гал дээр")
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
