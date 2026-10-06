import Foundation

/**
 What the Home Screen widget knows about the guest's next идэш.

 The lunch's snapshot beside it (`OrderSnapshot`), on the same terms: the app
 writes it whenever it hears from the server, the widget reads it and never
 talks to the network. The widget shows the lunch while one is running and
 this the rest of the time — a lunch is today and to the minute, an идэш is
 a day.
 */
public struct IdeshSnapshot: Codable, Hashable, Sendable {
  public var orderID: String
  /// «7042», printed with its №.
  public var code: String
  public var supplier: String
  /// «Хонины мах · 1 толгой»
  public var what: String
  /// `pickup` or `delivery`.
  public var receive: String
  /// `YYYY-MM-DD`, Ulaanbaatar's.
  public var receiveOn: String
  /// `PAID`, `PREPARING`, `READY` or `DISPATCHED` — nothing finished is kept.
  public var state: String
  /// «Бэлэн»
  public var word: String
  /// Along the meter of four.
  public var step: Int
  public var takenAt: Date

  public init(
    orderID: String, code: String, supplier: String, what: String, receive: String,
    receiveOn: String, state: String, word: String, step: Int, takenAt: Date,
  ) {
    self.orderID = orderID
    self.code = code
    self.supplier = supplier
    self.what = what
    self.receive = receive
    self.receiveOn = receiveOn
    self.state = state
    self.word = word
    self.step = step
    self.takenAt = takenAt
  }

  public var delivery: Bool { receive == "delivery" }
  /// Ready or on the road: the moment the guest has to do something.
  public var calling: Bool { state == "READY" || state == "DISPATCHED" }

  /// `basu://idesh/{id}` — the order, on the page.
  public var url: URL { URL(string: "basu://idesh/\(orderID)")! }
}

public enum IdeshSnapshotStore {
  static let key = "idesh.snapshot"

  private static var defaults: UserDefaults? { UserDefaults(suiteName: OrderSnapshotStore.appGroup) }

  public static func read() -> IdeshSnapshot? {
    guard let data = defaults?.data(forKey: key) else { return nil }
    return try? JSONDecoder.basu.decode(IdeshSnapshot.self, from: data)
  }

  public static func write(_ snapshot: IdeshSnapshot?) {
    guard let snapshot else {
      defaults?.removeObject(forKey: key)
      return
    }
    defaults?.set(try? JSONEncoder.basu.encode(snapshot), forKey: key)
  }
}
