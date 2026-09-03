import SwiftUI

/**
 Something of the guest's that is running right now, whichever app it belongs to.

 The launcher's ИДЭВХТЭЙ section is deliberately not "your orders": rows are
 ordered by the moment that matters, not by which app produced them, so a taxi
 four minutes away sits above a lunch that fires at half past. Dine maps into
 this; the second vertical will map into it too, and the section will not know
 the difference.
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
  /// What the time *is* — `СУУХ`, `ИРЭХ`, `ГАЛ`.
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
  /// The dine-in order, as the launcher sees it.
  func asLiveItem(expanded: Bool) -> LiveItem {
    let moment = moment
    return LiveItem(
      id: id,
      source: "ХООЛ",
      title: restaurant.name,
      meta: "№\(code) · \(state.word)",
      time: moment.time,
      timeLabel: moment.label.uppercased(),
      status: state == .fired || state == .cooking ? .moving : .waiting,
      destination: .dine(orderId: id),
      // The fire time is the product. When this is the only thing running it
      // belongs on the launcher, not one tap inside the app.
      extra: expanded && fireAt != nil && state != .fired && state != .cooking
        ? ("Гал тавих цаг", fireAt!)
        : nil,
    )
  }
}
