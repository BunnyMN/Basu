import Foundation
import Testing

@testable import Basu

/// The words and marks «Нэвтэрсэн төхөөрөмж» shows, which are the whole of
/// whether a person can tell one session from another.
@MainActor
struct DevicesTests {
  private func device(_ label: String?, current: Bool = false) -> DeviceSession {
    DeviceSession(id: UUID().uuidString, label: label, current: current, createdAt: .now, lastSeenAt: nil)
  }

  @Test func theMarkFollowsTheName() {
    #expect(device("Батын iPhone").symbol == "iphone")
    #expect(device("iPad Pro").symbol == "ipad")
    #expect(device("Батын MacBook").symbol == "laptopcomputer")
    #expect(device("Вэб").symbol == "globe")
    #expect(device("Нийлүүлэгчийн дэлгэц").symbol == "display")
    #expect(device(nil).symbol == "questionmark")
  }

  @Test func thisPhoneAlwaysHasAName() {
    #expect(device(nil).shownName == "Тодорхойгүй төхөөрөмж")
    #expect(device(nil, current: true).shownName == Session.deviceName)
  }

  @Test func lastSeenIsSaidTheWayPeopleSayIt() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try #require(TimeZone(identifier: "Asia/Ulaanbaatar"))
    let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 9, day: 28, hour: 15)))
    #expect(Format.seen(now.addingTimeInterval(-120), now: now) == "саяхан")
    #expect(Format.seen(now.addingTimeInterval(-3 * 3600), now: now) == "өнөөдөр 12:00")
    #expect(Format.seen(now.addingTimeInterval(-24 * 3600), now: now) == "өчигдөр 15:00")
    #expect(Format.seen(now.addingTimeInterval(-5 * 24 * 3600), now: now) == "9/23")
  }
}
