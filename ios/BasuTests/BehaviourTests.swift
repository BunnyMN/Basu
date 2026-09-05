import Foundation
import Testing

@testable import Basu

/// The decisions the app makes on its own, away from the server.
struct BehaviourTests {
  @Test func theClockIsUlaanbaatarsNotThePhones() {
    // 03:30 UTC is 11:30 in Ulaanbaatar. A guest whose phone is still on last
    // week's holiday timezone must not be shown a different fire time.
    let noon = ISODate.parse("2026-09-01T03:30:00.000Z")!
    #expect(Format.hhmm(noon) == "11:30")
    #expect(Format.hhmm(nil) == "—")
  }

  @Test func moneyReadsAsMoney() {
    #expect(Format.mnt(32000).hasSuffix("₮"))
    #expect(Format.mnt(32000).contains("32"))
  }

  @Test func theMomentOnACardIsTheOneThatMattersNext() {
    let slot = ISODate.parse("2026-09-01T04:45:00.000Z")!
    let fire = ISODate.parse("2026-09-01T04:21:00.000Z")!
    let ready = ISODate.parse("2026-09-01T04:33:00.000Z")!

    func order(_ state: OrderState, fireAt: Date?, readyAt: Date?) -> LiveOrder {
      LiveOrder(
        id: "o", code: "0001", state: state,
        restaurant: VenueRef(id: "r", name: "Ц"), table: nil, totalMnt: 1, partySize: 2,
        slotStartsAt: slot, fireAt: fireAt, readyAt: readyAt,
      )
    }

    // Before the kitchen has a time, the sitting is the appointment.
    #expect(order(.placed, fireAt: nil, readyAt: nil).moment.label == "суух")
    // Once it does, the fire is the thing to walk towards.
    #expect(order(.scheduled, fireAt: fire, readyAt: nil).moment.time == fire)
    // And once it is cooking, what matters is when it lands on the table.
    #expect(order(.cooking, fireAt: fire, readyAt: ready).moment.time == ready)
  }
}
