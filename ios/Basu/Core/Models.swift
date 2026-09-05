import SwiftUI

/**
 What the API says, in types — the shell's share of it.

 Only what the launcher, the inbox and the lock screen draw is decoded here:
 the guest's running orders. Menus, sittings, dishes and the status screen
 belong to the food service, which is a web page and decodes its own JSON.

 Keys are written out rather than converted from snake_case wholesale, so that
 a renamed field fails loudly in a test instead of silently as a blank row.
 */

// MARK: - orders

enum OrderState: String, Decodable, Sendable, Hashable {
  case draft = "DRAFT"
  case placed = "PLACED"
  case accepted = "ACCEPTED"
  case scheduled = "SCHEDULED"
  case armed = "ARMED"
  case held = "HELD"
  case reslotted = "RESLOTTED"
  case fired = "FIRED"
  case cooking = "COOKING"
  case ready = "READY"
  case served = "SERVED"
  case noShow = "NO_SHOW"
  case rejected = "REJECTED"
  case cancelled = "CANCELLED"
  case refunded = "REFUNDED"
  case closed = "CLOSED"

  /// Unknown states decode rather than throw: a server that learns a new one
  /// should not brick the phone in somebody's hand.
  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = OrderState(rawValue: raw) ?? .placed
  }

  /// The same words the web app uses. Shared copy, one product.
  var headline: (word: String, caption: String)? {
    switch self {
    case .placed: ("Хүлээгдэж байна", "Ресторан хараахан хараагүй")
    case .accepted: ("Баталгаажлаа", "Гал тавих цаг тооцоологдож байна")
    case .held: ("Хүлээж байна", "Гал тогоо ачаалалтай байна")
    case .fired: ("Гал дээр", "Хоол хийгдэж эхэллээ")
    case .ready: ("Бэлэн", "Ширээндээ хүрч ирлээ")
    case .served: ("Сайхан хооллоорой", "")
    case .closed: ("Дууслаа", "Баярлалаа")
    case .cancelled: ("Цуцлагдлаа", "Мөнгө буцаагдана")
    case .refunded: ("Буцаагдлаа", "Мөнгө таны данс руу очлоо")
    case .noShow: ("Ирээгүй", "Хоол хадгалагдаагүй")
    case .rejected: ("Татгалзсан", "Мөнгө бүтэн буцаагдана")
    default: nil
    }
  }

  var word: String { headline?.word ?? rawValue }
}

struct VenueRef: Decodable, Sendable, Hashable {
  let id: String
  let name: String
}

/// One row of `GET /v1/orders` — what the home screen puts in front of you.
struct LiveOrder: Decodable, Sendable, Identifiable, Hashable {
  let id: String
  let code: String
  let state: OrderState
  let restaurant: VenueRef
  let table: String?
  let totalMnt: Int
  let partySize: Int?
  let slotStartsAt: Date
  let fireAt: Date?
  let readyAt: Date?

  enum CodingKeys: String, CodingKey {
    case id, code, state, restaurant, table
    case totalMnt = "total_mnt"
    case partySize = "party_size"
    case slotStartsAt = "slot_starts_at"
    case fireAt = "fire_at"
    case readyAt = "ready_at"
  }

  /// The time worth putting in the corner of the card, and what it is called.
  var moment: (time: Date, label: String) {
    if let readyAt, state == .fired || state == .cooking { return (readyAt, "бэлэн") }
    if let fireAt, state != .ready, state != .served { return (fireAt, "гал") }
    return (slotStartsAt, "суух")
  }
}

// MARK: - өвлийн идэш

/// The life of a winter-meat order, as the server names it.
enum IdeshState: String, Decodable, Sendable, Hashable {
  case draft = "DRAFT"
  case paid = "PAID"
  case preparing = "PREPARING"
  case ready = "READY"
  case dispatched = "DISPATCHED"
  case handed = "HANDED"
  case closed = "CLOSED"
  case cancelled = "CANCELLED"
  case refunded = "REFUNDED"

  /// Unknown states decode rather than throw, for the same reason lunches do.
  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = IdeshState(rawValue: raw) ?? .paid
  }

  /// The same words the web page uses. One product.
  var word: String {
    switch self {
    case .draft: "Төлөгдөөгүй"
    case .paid: "Төлсөн"
    case .preparing: "Бэлтгэж байна"
    case .ready: "Бэлэн"
    case .dispatched: "Замд"
    case .handed: "Хүлээлгэн өгсөн"
    case .closed: "Дууслаа"
    case .cancelled: "Цуцлагдлаа"
    case .refunded: "Буцаагдлаа"
    }
  }
}

/// One row of `GET /v1/idesh` — the second thing the home screen puts in
/// front of you. Dates come as `YYYY-MM-DD` days, not instants: the meat is
/// ready on a day, and the row says so.
struct LiveIdesh: Decodable, Sendable, Identifiable, Hashable {
  let id: String
  let code: String
  let state: IdeshState
  let supplier: VenueRef
  let title: String
  let qty: Int
  let totalMnt: Int
  let receive: String
  let receiveOnDay: String

  enum CodingKeys: String, CodingKey {
    case id, code, state, supplier, title, qty, receive
    case totalMnt = "total_mnt"
    case receiveOnDay = "receive_on"
  }

  /// Noon on the day, in Ulaanbaatar — an instant to sort by, never to print.
  var receiveOn: Date {
    ISODate.parse("\(receiveOnDay)T12:00:00+08:00") ?? .distantFuture
  }
}
