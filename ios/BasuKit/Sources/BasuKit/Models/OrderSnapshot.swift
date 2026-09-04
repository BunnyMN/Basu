import Foundation

/**
 What the widgets know about the current order.

 The app writes it on every order change; the widget extension reads it and
 never talks to the network. It travels through the App Group and nothing else
 does — one struct, one key, one direction.
 */
public struct OrderSnapshot: Codable, Hashable, Sendable {
  public var orderID: String
  public var venueName: String
  public var orderNumber: String
  public var partySize: Int
  public var stage: OrderStage
  public var stageLabel: String
  public var seatingTime: Date
  public var fireTime: Date?
  /// When the app last heard from the server about it. A failed fetch does
  /// not hide a live order; the last snapshot stands, with its own timestamp.
  public var takenAt: Date

  public init(
    orderID: String, venueName: String, orderNumber: String, partySize: Int,
    stage: OrderStage, stageLabel: String, seatingTime: Date, fireTime: Date?, takenAt: Date,
  ) {
    self.orderID = orderID
    self.venueName = venueName
    self.orderNumber = orderNumber
    self.partySize = partySize
    self.stage = stage
    self.stageLabel = stageLabel
    self.seatingTime = seatingTime
    self.fireTime = fireTime
    self.takenAt = takenAt
  }

  /// `basu://order/{id}` — what the activity and both widgets open.
  public var url: URL { URL(string: "basu://order/\(orderID)")! }
}

public enum OrderSnapshotStore {
  public static let appGroup = "group.mn.basu.shared"
  static let key = "order.snapshot"
  /// The widget's timeline needs a kick when the snapshot changes.
  public static let widgetKind = "mn.basu.order"

  private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

  public static func read() -> OrderSnapshot? {
    guard let data = defaults?.data(forKey: key) else { return nil }
    return try? JSONDecoder.basu.decode(OrderSnapshot.self, from: data)
  }

  public static func write(_ snapshot: OrderSnapshot?) {
    guard let snapshot else {
      defaults?.removeObject(forKey: key)
      return
    }
    defaults?.set(try? JSONEncoder.basu.encode(snapshot), forKey: key)
  }
}

extension JSONDecoder {
  static var basu: JSONDecoder {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .iso8601
    return d
  }
}

extension JSONEncoder {
  static var basu: JSONEncoder {
    let e = JSONEncoder()
    e.dateEncodingStrategy = .iso8601
    return e
  }
}
