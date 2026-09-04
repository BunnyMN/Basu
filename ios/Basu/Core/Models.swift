import CoreLocation
import SwiftUI

/**
 What the API says, in types.

 Keys are written out rather than converted from snake_case wholesale: the
 order payloads are snake_case and the review payloads are camelCase, and a
 blanket strategy would silently drop half of one of them.
 */

// MARK: - restaurants and menus

struct Rating: Decodable, Sendable, Hashable {
  let stars: Double
  let count: Int
  let onTimeShare: Double?
}

struct Restaurant: Decodable, Sendable, Identifiable, Hashable {
  let id: String
  let name: String
  let walkMinutes: Int
  let lat: Double?
  let lon: Double?
  let rating: Rating?
  let acceptingOrders: Bool

  enum CodingKeys: String, CodingKey {
    case id, name, lat, lon, rating
    case walkMinutes = "walk_minutes"
    case acceptingOrders = "accepting_orders"
  }

  var coordinate: CLLocationCoordinate2D? {
    guard let lat, let lon else { return nil }
    return CLLocationCoordinate2D(latitude: lat, longitude: lon)
  }
}

struct MenuItem: Decodable, Sendable, Identifiable, Hashable {
  let id: String
  let name: String
  let priceMnt: Int
  let prepMinutes: Int
  let imageUrl: String?
  let description: String?
  let station: String
  let soldOut: Bool
  let rating: Rating?

  enum CodingKeys: String, CodingKey {
    case id, name, description, station, rating
    case priceMnt = "price_mnt"
    case prepMinutes = "prep_minutes"
    case imageUrl = "image_url"
    case soldOut = "sold_out"
  }

  /// `/dishes/khuushuur.svg` → `khuushuur`. A real photograph, when one
  /// arrives, is an absolute URL and has no slug — the row loads it instead.
  var drawingSlug: String? {
    guard let imageUrl, imageUrl.hasPrefix("/dishes/") else { return nil }
    return String(imageUrl.dropFirst("/dishes/".count).replacingOccurrences(of: ".svg", with: ""))
  }

  var photoURL: URL? {
    guard let imageUrl, imageUrl.hasPrefix("http") else { return nil }
    return URL(string: imageUrl)
  }
}

struct Slot: Decodable, Sendable, Identifiable, Hashable {
  let startsAt: Date
  let label: String
  let available: Bool
  let remaining: Int

  var id: Date { startsAt }

  enum CodingKeys: String, CodingKey {
    case label, available, remaining
    case startsAt = "starts_at"
  }
}

struct PublicComment: Decodable, Sendable, Identifiable, Hashable {
  let stars: Int
  let comment: String
  let onTime: Bool?
  let at: String
  let by: String

  var id: String { "\(by)-\(at)" }
}

struct VenueReviews: Decodable, Sendable {
  let rating: Rating?
  let comments: [PublicComment]
}

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

  /// The line under the headline for the states whose news is a time.
  var subtitle: String? {
    switch self {
    case .scheduled: "Энэ цагт гал дээр гарна"
    case .armed: "Та замд гарсан уу?"
    case .cooking: "Хоол хийгдэж байна"
    default: headline?.caption
    }
  }

  var word: String { headline?.word ?? rawValue }

  /// Is the guest still walking towards this one?
  var isWalking: Bool {
    [.accepted, .scheduled, .armed, .held, .fired, .cooking, .ready].contains(self)
  }

  var tint: Color {
    switch self {
    case .placed, .accepted, .scheduled, .reslotted: .route
    case .armed: .hold
    case .held: .stop
    case .fired, .cooking: .accentInk
    case .ready, .served, .closed: .ready
    default: .ink3
    }
  }

  var soft: Color {
    switch self {
    case .placed, .accepted, .scheduled, .reslotted: .routeSoft
    case .armed: .holdSoft
    case .held: .stopSoft
    case .fired, .cooking: .accentSoft
    case .ready, .served, .closed: .readySoft
    default: .surface2
    }
  }

  var line: Color {
    switch self {
    case .placed, .accepted, .scheduled, .reslotted: .routeLine
    case .armed: .holdLine
    case .held: .stop
    case .fired, .cooking: .accent
    case .ready, .served, .closed: .readyLine
    default: .line2
    }
  }
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

struct OrderLine: Decodable, Sendable, Identifiable, Hashable {
  let menuItemId: String
  let name: String
  let qty: Int
  let imageUrl: String?

  var id: String { menuItemId }

  enum CodingKeys: String, CodingKey {
    case name, qty
    case menuItemId = "menu_item_id"
    case imageUrl = "image_url"
  }
}

struct DishRating: Decodable, Sendable, Hashable {
  let menuItemId: String
  let stars: Int
}

struct Review: Decodable, Sendable, Hashable {
  let stars: Int
  let onTime: Bool?
  let comment: String?
  let dishes: [DishRating]
}

struct Receipt: Decodable, Sendable, Hashable {
  let qr: String
  let lottery: String?
}

/// `GET /v1/orders/:id` — everything the status screen draws.
struct OrderDetail: Decodable, Sendable, Hashable {
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
  let freeCancelUntil: Date?
  let canCancel: Bool
  let canReview: Bool
  let lines: [OrderLine]
  let review: Review?
  let receipt: Receipt?

  enum CodingKeys: String, CodingKey {
    case id, code, state, restaurant, table, lines, review, receipt
    case totalMnt = "total_mnt"
    case partySize = "party_size"
    case slotStartsAt = "slot_starts_at"
    case fireAt = "fire_at"
    case readyAt = "ready_at"
    case freeCancelUntil = "free_cancel_until"
    case canCancel = "can_cancel"
    case canReview = "can_review"
  }
}

struct CreatedOrder: Decodable, Sendable {
  let id: String
  let code: String
  let totalMnt: Int

  enum CodingKeys: String, CodingKey {
    case id, code
    case totalMnt = "total_mnt"
  }
}

// MARK: - the walk

struct Walk: Decodable, Sendable, Hashable {
  /// `road` came from the router; `direct` is a straight line and is drawn
  /// dashed, so a guess never looks like a surveyed route.
  let kind: String
  let metres: Double
  let minutes: Int
  /// `[lon, lat]` pairs, as GeoJSON has them.
  let line: [[Double]]

  var coordinates: [CLLocationCoordinate2D] {
    line.compactMap { pair in
      guard pair.count == 2 else { return nil }
      return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
    }
  }

  var isGuess: Bool { kind != "road" }
}

// MARK: - what a dish looks like

struct DishSpec: Decodable, Sendable, Hashable {
  enum Form: String, Decodable, Sendable {
    case soup, dumpling, fried, noodle, grill, salad, drink, rice, skewer
  }

  let form: Form
  let fill: String
  let detail: String
  let ground: String
}

struct DishTable: Decodable, Sendable {
  let fallback: DishSpec
  let dishes: [String: DishSpec]

  subscript(slug: String?) -> DishSpec {
    guard let slug, let dish = dishes[slug] else { return fallback }
    return dish
  }
}
