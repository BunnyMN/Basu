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
