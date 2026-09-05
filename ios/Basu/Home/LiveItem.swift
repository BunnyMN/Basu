import SwiftUI

/**
 Something of the guest's that is running right now, whichever app it belongs to.

 The launcher's ИДЭВХТЭЙ section is deliberately not "your orders": rows are
 ordered by the moment that matters, not by which app produced them, so a taxi
 four minutes away sits above a lunch that fires at half past. The food app
 maps into this; the second app will map into it too, and the section will
 not know the difference.
 */
struct LiveItem: Identifiable, Hashable {
  enum Status: Hashable {
    /// Waiting on something — the kitchen, the restaurant, the driver.
    case waiting
    /// On its way. The one status that means *do not go anywhere*.
    case moving

    var tint: Color {
      switch self {
      case .waiting: .hold
      case .moving: .route
      }
    }
  }

  let id: String
  /// The app it came from, set in the row as a tracked mono label.
  let source: String
  let title: String
  let meta: String
  let time: Date
  /// The time as the corner shows it: `12:21` for a lunch, `11/03` for a
  /// sheep. A day is not an instant, and printing one as 00:00 would be a lie.
  let when: String
  /// What the time *is* — `СУУХ`, `ИРЭХ`, `ГАЛ`, `АВАХ`.
  let timeLabel: String
  let status: Status
  let destination: Destination?

  /// A second line, and only when this row is alone on the screen. One live
  /// thing can afford to say more; three cannot, and a list where some rows
  /// are taller than others is a list you have to read rather than scan.
  let extra: (label: String, time: Date)?

  static func == (a: LiveItem, b: LiveItem) -> Bool { a.id == b.id }
  func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

extension LiveOrder {
  /// The food app's order, as the launcher sees it.
  func asLiveItem(expanded: Bool) -> LiveItem {
    let moment = moment
    return LiveItem(
      id: id,
      source: "ХООЛ",
      title: restaurant.name,
      meta: "№\(code) · \(state.headline?.word ?? state.stage.label)",
      time: moment.time,
      when: Format.hhmm(moment.time),
      timeLabel: moment.label.uppercased(),
      status: state == .fired || state == .cooking ? .moving : .waiting,
      destination: AppCatalogue.food.destination(order: id),
      // The fire time is the product. When this is the only thing running it
      // belongs on the launcher, not one tap inside the app.
      extra: expanded && fireAt != nil && state != .fired && state != .cooking
        ? ("Гал тавих цаг", fireAt!)
        : nil,
    )
  }
}

extension LiveIdesh {
  /// The winter-meat order, as the launcher sees it. The second vertical
  /// mapping into the same row — which is what the row was drawn for.
  func asLiveItem() -> LiveItem {
    LiveItem(
      id: id,
      source: "ИДЭШ",
      title: supplier.name,
      meta: "№\(code) · \(title) ×\(qty) · \(state.word)",
      time: receiveOn,
      when: Format.day(receiveOn),
      timeLabel: receive == "delivery" ? "ИРЭХ" : "АВАХ",
      status: state == .dispatched ? .moving : .waiting,
      destination: AppCatalogue.idesh.destination(order: id),
      extra: nil,
    )
  }
}
