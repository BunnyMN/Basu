import Foundation
import Testing

@testable import BasuKit

struct BasuKitTests {
  @Test func theBadgeStopsAtNinetyNine() {
    #expect(BasuFormat.badge(1) == "1")
    #expect(BasuFormat.badge(99) == "99")
    #expect(BasuFormat.badge(100) == "99+")
    #expect(BasuFormat.badge(2_000) == "99+")
  }

  @Test func theStagesAreTheBarsThreeSegments() {
    #expect(OrderStage.waiting.index == 0)
    #expect(OrderStage.cooking.index == 1)
    #expect(OrderStage.ready.index == 2)
  }

  @Test func aSnapshotSurvivesTheRoundTrip() throws {
    let snap = OrderSnapshot(
      orderID: "o1", venueName: "Алтан Тавган", orderNumber: "№0971", partySize: 2,
      stage: .cooking, stageLabel: "Гал дээр гарлаа",
      seatingTime: Date(timeIntervalSince1970: 1_788_500_000), fireTime: nil,
      takenAt: Date(timeIntervalSince1970: 1_788_499_000),
    )
    let data = try JSONEncoder.basu.encode(snap)
    let back = try JSONDecoder.basu.decode(OrderSnapshot.self, from: data)
    #expect(back == snap)
    #expect(back.url.absoluteString == "basu://order/o1")
  }

  @Test func theServersIdeshPushDecodesAsTheCardsState() throws {
    // What the relay sends for an идэш (src/services/activities.ts).
    let pushed = try JSONDecoder().decode(
      IdeshActivityAttributes.ContentState.self,
      from: Data("""
        {"state":"READY","word":"Бэлэн","step":3,"receiveOn":"2026-09-12"}
        """.utf8),
    )
    #expect(pushed == .init(state: "READY", word: "Бэлэн", step: 3, receiveOn: "2026-09-12"))
    #expect(pushed.calling)
    #expect(!pushed.finished)
    #expect(pushed.short == "Бэлэн")
    #expect(pushed.hint(delivery: false) == "Кодоо үзүүлээд аваарай")
    #expect(pushed.hint(delivery: true) == "Удахгүй замд гарна")
  }

  @Test func aDayIsSaidTheWayAPersonSaysIt() {
    // 2026-09-12 10:00 in Ulaanbaatar.
    let now = Date(timeIntervalSince1970: 1_789_178_400)
    #expect(BasuFormat.today(now) == "2026-09-12")
    #expect(BasuFormat.dayWord("2026-09-12", now: now) == "Өнөөдөр")
    #expect(BasuFormat.dayWord("2026-09-13", now: now) == "Маргааш")
    #expect(BasuFormat.dayWord("2026-09-11", now: now) == "Өчигдөр")
    #expect(BasuFormat.dayWord("2026-10-07", now: now) == "10-р сарын 7")
  }

  @Test func aWidgetSaysTheDayInANumbersPlaceAndRedrawsAtMidnight() {
    // 2026-09-12 10:00 in Ulaanbaatar.
    let now = Date(timeIntervalSince1970: 1_789_178_400)
    #expect(BasuFormat.dayShort("2026-09-12", now: now) == "Өнөөдөр")
    #expect(BasuFormat.dayShort("2026-09-13", now: now) == "Маргааш")
    #expect(BasuFormat.dayShort("2026-10-07", now: now) == "10/7")
    // Midnights on the 13th and 14th (the day after the 13th): Маргааш,
    // then Өнөөдөр, then Өчигдөр — each drawn when it becomes true.
    let marks = BasuFormat.midnights(after: now, through: "2026-09-13")
    #expect(marks.map { BasuFormat.today($0) } == ["2026-09-13", "2026-09-14"])
    #expect(BasuFormat.midnights(after: now, through: "2026-09-10").isEmpty)
  }

  @Test func theServersPushAndTheAppsOwnEncodingBothDecodeAsContentState() throws {
    // What the relay sends (src/services/activities.ts): ISO 8601 text.
    let pushed = try JSONDecoder().decode(
      BasuActivityAttributes.ContentState.self,
      from: Data("""
        {"stage":"cooking","stageLabel":"Гал дээр гарлаа","seatingTime":"2026-09-05T04:30:00.000Z","fireTime":null}
        """.utf8),
    )
    #expect(pushed.stage == .cooking)
    #expect(pushed.stageLabel == "Гал дээр гарлаа")
    #expect(pushed.seatingTime == Date(timeIntervalSince1970: 1_788_582_600))
    #expect(pushed.fireTime == nil)

    // What the app itself writes: Swift's default, seconds since 2001.
    let own = BasuActivityAttributes.ContentState(
      stage: .ready, seatingTime: Date(timeIntervalSince1970: 1_788_582_600),
      fireTime: Date(timeIntervalSince1970: 1_788_580_000), stageLabel: "Ширээ бэлэн",
    )
    let back = try JSONDecoder().decode(BasuActivityAttributes.ContentState.self, from: JSONEncoder().encode(own))
    #expect(back == own)

    // A stage the phone has never heard of does not take the card down.
    let future = try JSONDecoder().decode(
      BasuActivityAttributes.ContentState.self,
      from: Data(#"{"stage":"plated","stageLabel":"Тавагласан","seatingTime":"2026-09-05T04:30:00Z"}"#.utf8),
    )
    #expect(future.stage == .waiting)
    #expect(future.fireTime == nil)
  }
}
