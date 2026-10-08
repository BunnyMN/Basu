import Foundation
import Testing
import UserNotifications

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
        slotStartsAt: slot, fireAt: fireAt, readyAt: readyAt, unseen: nil,
      )
    }

    // Before the kitchen has a time, the sitting is the appointment.
    #expect(order(.placed, fireAt: nil, readyAt: nil).moment.label == "ирэх")
    // Once it does, the fire is the thing to walk towards.
    #expect(order(.scheduled, fireAt: fire, readyAt: nil).moment.time == fire)
    // And once it is cooking, what matters is when it lands on the table.
    #expect(order(.cooking, fireAt: fire, readyAt: ready).moment.time == ready)
  }

  // MARK: - asking for notifications

  @Test func notificationsAreAskedForOnlyWhileIOSHasNeverAsked() {
    #expect(PushRegistrar.offerDue(status: .notDetermined))
    // A no in iOS is an answer; a yes needs no question.
    #expect(!PushRegistrar.offerDue(status: .denied))
    #expect(!PushRegistrar.offerDue(status: .authorized))
    #expect(!PushRegistrar.offerDue(status: .provisional))
  }

  @MainActor
  @Test func theShellsScreenOnceARunDoesNotStopTheProfilesAsk() async {
    let registrar = PushRegistrar()
    registrar.markOffered()
    // The screen went up; its one button, or the profile's, still asks iOS.
    #expect(registrar.offered)
    #expect(!registrar.asked)
    #expect(await registrar.shouldOffer() == false)
  }

  @Test func aLineIsSaidInWordsNotMarks() {
    #expect(Format.spoken("Хонины мах, кг-аар · №7001.") == "Хонины мах, кг-аар, дугаар 7001.")
    #expect(Format.spoken("Үхрийн мах ×15") == "Үхрийн мах 15")
    #expect(Format.moneySpoken(-128_000) == "128,000 төгрөг")
  }

  // MARK: - which pages an app may show

  @Test func anAppShowsItsOwnPagesAndTheTwoEveryPageLinksTo() {
    #expect(ServicePage.belongs("/idesh", to: "/idesh"))
    #expect(ServicePage.belongs("/idesh/anything", to: "/idesh"))
    #expect(ServicePage.belongs("/terms", to: "/idesh"))
    #expect(ServicePage.belongs("/privacy", to: "/dine"))
    // The lunch page with no restaurant points to the winter-meat one, and back.
    #expect(ServicePage.belongs("/idesh", to: "/dine"))
    #expect(ServicePage.belongs("/dine", to: "/idesh"))
    // The dashboard, the website's sign-in: Safari's.
    #expect(!ServicePage.belongs("/dashboard", to: "/supplier"))
    #expect(!ServicePage.belongs("/login", to: "/idesh"))
    #expect(!ServicePage.belongs("/idesh", to: "/supplier"))
    // A neighbour whose name starts the same is not the app's.
    #expect(!ServicePage.belongs("/dineout", to: "/dine"))
  }

  @Test func theKitchensScreenIsNoGuestsPage() {
    #expect(ServicePage.staffOnly("/kds"))
    #expect(ServicePage.staffOnly("/kds/anything"))
    #expect(!ServicePage.staffOnly("/kdsx"))
    #expect(!ServicePage.belongs("/kds", to: "/dine"))
  }

  // MARK: - dates

  @Test func aCornerDayIsTheWebsAndAKeptDateIsWrittenOut() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try #require(TimeZone(identifier: "Asia/Ulaanbaatar"))
    let day = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 3, hour: 21)))
    // The web's own `dayShort`; «10.03» would read as 10 March.
    #expect(Format.day(day) == "10/3")
    #expect(Format.date(day) == "2026 оны 10-р сарын 3")
    #expect(Format.dayWords(day) == "10-р сарын 3")
    // Today, a time; any other day, the day.
    #expect(Format.when(day, now: day.addingTimeInterval(60)) == "21:00")
    #expect(Format.when(day, now: day.addingTimeInterval(2 * 24 * 3600)) == "10/3")
  }
}
