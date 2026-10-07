import ActivityKit
import Foundation

/**
 An идэш on the lock screen and in the Dynamic Island: at each step, and on
 the day it is received.

 A Live Activity lives eight hours and lingers four more, and an идэш takes
 days — so the card does not follow the whole order in one. The server puts it
 up at each step the supplier takes (a push to the phone's push-to-start
 token), for the hours after it; the phone puts it up on the morning the meat
 is picked up or delivered (or the moment it goes out on the road); and it goes
 once the meat is in the guest's hands.

 The content state is four plain values, nothing to parse: the server's push
 (`src/services/activities.ts`) writes exactly these keys, and the app writes
 them the same way.
 */
public struct IdeshActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable, Sendable {
    /// The order's state as the server names it: `PAID`, `PREPARING`,
    /// `READY`, `DISPATCHED`, `HANDED`, `CANCELLED`…
    public var state: String
    /// «Бэлэн» — the word every Basu screen uses for that state.
    public var word: String
    /// Along the meter of four: paid, preparing, ready, then on the road or
    /// handed over. Nought for an order with no meter (cancelled).
    public var step: Int
    /// `YYYY-MM-DD`, Ulaanbaatar's: the day the meat changes hands.
    public var receiveOn: String

    public init(state: String, word: String, step: Int, receiveOn: String) {
      self.state = state
      self.word = word
      self.step = step
      self.receiveOn = receiveOn
    }

    /// Handed over: the meter is full and the card is about to go.
    public var finished: Bool { state == "HANDED" || state == "CLOSED" }
    public var cancelled: Bool { state == "CANCELLED" || state == "REFUNDED" }
    /// Ready or on the road: the moment the guest has to do something.
    public var calling: Bool { state == "READY" || state == "DISPATCHED" }

    /// The one word the compact island has room for.
    public var short: String {
      switch state {
      case "PAID": "Төлсөн"
      case "PREPARING": "Бэлтгэж"
      case "READY": "Бэлэн"
      case "DISPATCHED": "Замд"
      case "HANDED", "CLOSED": "Авсан"
      case "CANCELLED", "REFUNDED": "Цуцалсан"
      default: word
      }
    }
  }

  public var orderID: String
  /// «7042» — what the guest shows at the handover. Printed with its №.
  public var code: String
  public var supplier: String
  /// «Хонины мах · 1 толгой»: the meat and the amount, as the launcher says it.
  public var what: String
  /// `pickup` or `delivery`.
  public var receive: String
  /// Where to go, for a pickup: the supplier's own address. Never the guest's
  /// — a lock screen is read by whoever is holding the phone.
  public var pickupAddress: String?

  public init(orderID: String, code: String, supplier: String, what: String, receive: String, pickupAddress: String?) {
    self.orderID = orderID
    self.code = code
    self.supplier = supplier
    self.what = what
    self.receive = receive
    self.pickupAddress = pickupAddress
  }

  public var delivery: Bool { receive == "delivery" }
}

public extension IdeshActivityAttributes.ContentState {
  /// What to do now, under the word: the line a glance at the lock screen is for.
  func hint(delivery: Bool) -> String {
    switch state {
    case "PAID": "Нийлүүлэгч бэлтгэлээ эхлүүлнэ"
    case "PREPARING": "Мал бэлтгэгдэж байна"
    case "READY": delivery ? "Удахгүй замд гарна" : "Кодоо үзүүлээд аваарай"
    case "DISPATCHED": "Хүргэгч тантай холбогдоно"
    case "HANDED", "CLOSED": "Сайхан өвөлжөөрэй"
    case "CANCELLED", "REFUNDED": "Мөнгө тань буцаагдана"
    default: word
    }
  }
}
