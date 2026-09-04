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
}
