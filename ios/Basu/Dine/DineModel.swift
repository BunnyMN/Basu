import CoreLocation
import Observation
import SwiftUI

/**
 The dine-in flow, as one object.

 The screens above it are thin: a map, a menu, a status. Every decision about
 what happens next — which venue is open, what is in the cart, whether the
 order can still be cancelled — is made here and, past the network boundary, by
 the server. That is deliberate: the same order can be walked through from the
 simulator, the web app or a test, and it behaves the same in all three.
 */
@MainActor
@Observable
final class DineModel {
  enum Sheet: Identifiable, Hashable {
    case venue
    case status

    var id: Self { self }
  }

  private let app: AppModel
  private var api: API { app.api }
  private var token: String? { app.session.token }

  init(app: AppModel) { self.app = app }

  // what the map shows
  private(set) var venues: [Restaurant] = []
  var venue: Restaurant?
  private(set) var menu: [MenuItem] = []
  private(set) var slots: [Slot] = []
  private(set) var venueReviews: VenueReviews?

  // what is being ordered
  var cart: [String: Int] = [:]
  var slot: Date?

  // what has been ordered
  private(set) var orderId: String?
  private(set) var order: OrderDetail?
  private(set) var walk: Walk?

  var sheet: Sheet?
  private(set) var busy = false
  var trouble: String?
  var note: String?

  /// Bands already reported for this order. A band is news once.
  private var sent: Set<String> = []

  /// The idempotency key for the attempt currently in flight.
  ///
  /// It exists so that a retry of *this* tap cannot buy lunch twice, and it is
  /// thrown away as soon as the attempt resolves. A key derived from the cart
  /// would still be the same key tomorrow: a guest who cancels and orders the
  /// same хуушуур again would be handed back the cancelled order.
  private var attemptKey: String?

  var total: Int {
    cart.reduce(0) { sum, entry in
      sum + (menu.first { $0.id == entry.key }?.priceMnt ?? 0) * entry.value
    }
  }

  var openVenueCount: Int { venues.filter(\.acceptingOrders).count }

  // MARK: loading

  func loadVenues() async {
    do {
      let fresh = try await api.restaurants()
      app.noted(nil)
      venues = fresh
      // A kitchen can go dark while its sheet is open; keep the copy current.
      if let mine = venue, let updated = fresh.first(where: { $0.id == mine.id }) {
        venue = updated
      }
    } catch {
      app.noted(error)
      trouble = (error as? APIError)?.message
    }
  }

  var offline: Bool { app.offline }

  func open(_ chosen: Restaurant) async {
    venue = chosen
    cart = [:]
    slot = nil
    menu = []
    slots = []
    venueReviews = nil
    sheet = .venue

    async let items = try? api.menu(of: chosen.id)
    async let times = try? api.slots(of: chosen.id)
    async let said = try? api.reviews(of: chosen.id)
    menu = await items ?? []
    slots = await times ?? []
    venueReviews = await said

    await drawWalk()
  }

  // MARK: ordering

  /// Place and pay in one gesture, because from the guest's side it is one:
  /// the table is only held for ten minutes and an unpaid order is not a
  /// booking. Anything that fails leaves the sheet where it was, with a line
  /// saying why in the language the server said it.
  func placeOrder() async {
    guard let venue, let slot, let token else { return }
    busy = true
    defer { busy = false }

    let key = attemptKey ?? UUID().uuidString
    attemptKey = key

    do {
      let items = cart.map { (id: $0.key, qty: $0.value) }
      let created = try await api.place(
        venue: venue.id,
        slot: slot,
        partySize: 2,
        items: items,
        idempotencyKey: key,
        token: token,
      )
      try await api.pay(created.id, token: token)
      attemptKey = nil
      trouble = nil
      orderId = created.id
      sent = []
      sheet = .status
      await refreshStatus()
      await app.refreshLive()
    } catch let error as APIError {
      // A refusal is an answer: this attempt is over, and the next tap is a new
      // intention. Only a connection that never landed keeps the key, because
      // that request may yet be sitting in a queue somewhere.
      if error.code != "OFFLINE" { attemptKey = nil }
      trouble = error.message
    } catch {
      attemptKey = nil
      trouble = "Захиалга үүсгэж чадсангүй."
    }
  }

  func refreshStatus() async {
    guard let orderId, let token else { return }
    do {
      let detail = try await api.order(orderId, token: token)
      order = detail
      // The venue the order names, not the one that happens to be selected:
      // an order opened from the home screen never had a pin tapped.
      if venue?.id != detail.restaurant.id {
        venue = venues.first { $0.id == detail.restaurant.id } ?? venue
      }
      if detail.state.isWalking {
        await drawWalk()
      } else {
        walk = nil
      }
    } catch let error as APIError where error.isUnauthorised {
      app.session.forget()
    } catch {
      // A poll that fails changes nothing. The next one is four seconds away.
    }
  }

  func cancel() async {
    guard let orderId, let token else { return }
    busy = true
    defer { busy = false }
    do {
      try await api.cancel(orderId, token: token)
      await refreshStatus()
      await app.refreshLive()
      note = "Захиалга цуцлагдаж, мөнгө буцаагдлаа."
    } catch let error as APIError {
      trouble = error.message
    } catch {
      trouble = "Цуцалж чадсангүй."
    }
  }

  func review(stars: Int, onTime: Bool?, comment: String, dishes: [String: Int]) async {
    guard let orderId, let token else { return }
    busy = true
    defer { busy = false }
    do {
      try await api.review(
        orderId,
        stars: stars,
        onTime: onTime,
        comment: comment,
        dishes: dishes.map { (id: $0.key, stars: $0.value) },
        token: token,
      )
      await refreshStatus()
      note = "Баярлалаа. Үнэлгээ хадгалагдлаа."
    } catch let error as APIError {
      trouble = error.message
    } catch {
      trouble = "Үнэлгээ хадгалагдсангүй."
    }
  }

  // MARK: picking an order up again

  /// Two ways in: the home screen deep-links one, or the app was reopened
  /// mid-lunch. Which order that is comes from the server — an id kept on the
  /// phone would go on pointing at a lunch that finished yesterday.
  func resume(_ wanted: String?) async {
    guard let token else { return }
    let orders = (try? await api.liveOrders(token: token)) ?? []
    guard let found = wanted.flatMap({ id in orders.first { $0.id == id } }) ?? orders.first else {
      return
    }
    orderId = found.id
    venue = venues.first { $0.id == found.restaurant.id } ?? venue
    sent = []
    sheet = .status
    await refreshStatus()
  }

  // MARK: the walk, and saying you are on it

  private(set) var here: CLLocationCoordinate2D?

  func located(at coordinate: CLLocationCoordinate2D?) async {
    here = coordinate
    await drawWalk()
    await reportProximity()
  }

  func drawWalk() async {
    guard let venue, let to = venue.coordinate, let from = here else { return }
    walk = try? await api.walk(from: from, to: to)
  }

  /// The one signal a phone can give without being asked. Reported once per
  /// band: a guest who paces outside the door is not news twice.
  func reportProximity() async {
    guard let orderId, let token, let order, order.state.isWalking,
          let here, let there = venue?.coordinate
    else { return }

    let metres = here.metres(to: there)
    guard let band = Geofence.band(metres: metres), !sent.contains(band) else { return }

    sent.insert(band)
    do {
      try await api.signal(orderId, type: band, token: token)
      note = "\(Int(metres))м зайд ирлээ — гал тавих цаг шинэчлэгдэнэ."
      await refreshStatus()
    } catch {
      sent.remove(band) // let the next fix try again
    }
  }

  /// The arm question, answered by hand: "are you on your way?"
  func sayOnMyWay() async {
    guard let orderId, let token else { return }
    do {
      try await api.signal(orderId, type: "on_my_way", token: token)
      note = "Мэдэгдлээ. Гал тогоо цагаа тохирууллаа."
      await refreshStatus()
    } catch let error as APIError {
      trouble = error.message
    } catch {}
  }

  func delayTen() async {
    guard let orderId, let token else { return }
    do {
      try await api.signal(orderId, type: "delay_10", token: token)
      note = "10 минут хойшлууллаа."
      await refreshStatus()
    } catch let error as APIError {
      trouble = error.message
    } catch {}
  }
}
