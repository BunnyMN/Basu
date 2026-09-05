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
