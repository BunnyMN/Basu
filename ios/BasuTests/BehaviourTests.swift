import CoreLocation
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

  @Test func theWalkIsQuotedAtThePrecisionItIsWorth() {
    #expect(Format.metres(480) == "480 м")
    #expect(Format.metres(1240) == "1.2 км")
  }

  @Test func geofenceBandsAreTheTwoTheServerKnows() {
    #expect(Geofence.band(metres: 120) == "geofence_300")
    #expect(Geofence.band(metres: 300) == "geofence_300")
    #expect(Geofence.band(metres: 301) == "geofence_800")
    #expect(Geofence.band(metres: 800) == "geofence_800")
    // Further out than that is not news: it is where everybody starts.
    #expect(Geofence.band(metres: 1200) == nil)
  }

  @Test func aDrawnDishIsRecognisedByItsUrlAndAPhotographIsNot() {
    let drawn = MenuItem(
      id: "1", name: "Хуушуур", priceMnt: 8000, prepMinutes: 9,
      imageUrl: "/dishes/khuushuur.svg", description: nil, station: "Хайруулга",
      soldOut: false, rating: nil,
    )
    #expect(drawn.drawingSlug == "khuushuur")
    #expect(drawn.photoURL == nil)

    let photographed = MenuItem(
      id: "2", name: "Цуйван", priceMnt: 12000, prepMinutes: 12,
      imageUrl: "https://example.mn/tsuivan.jpg", description: nil, station: "Вок",
      soldOut: false, rating: nil,
    )
    #expect(photographed.drawingSlug == nil)
    #expect(photographed.photoURL != nil)
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

  @Test func onlyTheStatesWithAWalkInFrontOfThemCarryARoute() {
    #expect(OrderState.armed.isWalking)
    #expect(OrderState.cooking.isWalking)
    #expect(!OrderState.served.isWalking)
    #expect(!OrderState.cancelled.isWalking)
  }
}
