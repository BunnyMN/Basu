import ActivityKit
import Foundation

/// The three stages an order passes through on a lock screen. They are the
/// bar's three segments, so no percentage is ever computed or shown.
public enum OrderStage: String, Codable, Hashable, Sendable {
  case waiting, cooking, ready

  public var index: Int {
    switch self {
    case .waiting: 0
    case .cooking: 1
    case .ready: 2
    }
  }

  /// The words the card carries. Server copy wins when it is present; these
  /// are what the widget says when it has nothing newer.
  public var label: String {
    switch self {
    case .waiting: "Хүлээгдэж байна"
    case .cooking: "Гал дээр гарлаа"
    case .ready: "Ширээ бэлэн"
    }
  }
}

/**
 One activity per order: started when the order is confirmed, ended when the
 party is seated or the order is cancelled. Not a notification.
 */
public struct BasuActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable, Sendable {
    public var stage: OrderStage
    public var seatingTime: Date
    public var fireTime: Date?
    /// "Гал дээр гарлаа" — server-supplied and localised.
    public var stageLabel: String

    public init(stage: OrderStage, seatingTime: Date, fireTime: Date?, stageLabel: String) {
      self.stage = stage
      self.seatingTime = seatingTime
      self.fireTime = fireTime
      self.stageLabel = stageLabel
    }

    /**
     Two sources write this state and they write dates differently.

     The app encodes it itself, and Swift's default for a `Date` is a number:
     seconds since 2001. The server's push writes the ISO 8601 text every
     other payload uses (`2026-09-05T04:30:00.000Z`), because a payload the
     eye can check beats one it cannot, and the relay's tests compare the
     text. So a date here is read by type: a string is ISO 8601, a number is
     Swift's own. An unknown stage — a server that learned a new one — is
     read as waiting rather than taking the card down.
     */
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      stage = (try? c.decode(OrderStage.self, forKey: .stage)) ?? .waiting
      stageLabel = try c.decode(String.self, forKey: .stageLabel)
      seatingTime = try Self.date(c, .seatingTime) ?? { throw DecodingError.keyNotFound(CodingKeys.seatingTime, .init(codingPath: c.codingPath, debugDescription: "seatingTime")) }()
      fireTime = try Self.date(c, .fireTime)
    }

    private enum CodingKeys: String, CodingKey { case stage, seatingTime, fireTime, stageLabel }

    private static func date(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) throws -> Date? {
      // Absent and null both mean "no such time" — the server writes null,
      // a hand-written payload may leave the key out.
      if !c.contains(key) { return nil }
      if try c.decodeNil(forKey: key) { return nil }
      if let text = try? c.decode(String.self, forKey: key) {
        // Formatters are not Sendable, and a push is decoded once; two
        // throwaway ones cost less than a lock.
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = withFraction.date(from: text) ?? ISO8601DateFormatter().date(from: text) else {
          throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "not an ISO 8601 date: \(text)")
        }
        return date
      }
      return try c.decode(Date.self, forKey: key)
    }
  }

  public var orderID: String
  public var venueName: String
  public var partySize: Int
  /// "№0971"
  public var orderNumber: String
  public var serviceID: String

  public init(orderID: String, venueName: String, partySize: Int, orderNumber: String, serviceID: String) {
    self.orderID = orderID
    self.venueName = venueName
    self.partySize = partySize
    self.orderNumber = orderNumber
    self.serviceID = serviceID
  }
}
