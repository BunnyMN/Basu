import ActivityKit
import BasuKit
import Foundation
import WidgetKit

/**
 The order's presence outside the app: one Live Activity per order, and the
 snapshot the Home Screen widgets read.

 Started when the order is confirmed, ended when the party is seated or the
 order is cancelled. The phone updates its own activity on every poll; the
 push token is registered so the server can move it when the app is not
 running, once the relay has APNs credentials.
 */
@MainActor
final class OrderActivity {
  static let shared = OrderActivity()

  /// How to hand a token to the server. Set by whoever owns the session.
  var register: ((_ orderId: String, _ token: String) async -> Void)?

  private var watching: Set<String> = []

  /// The launcher's list, for the widget: the first thing that will happen.
  /// Nothing live clears the snapshot; a failed fetch leaves it alone, which
  /// is `AppModel`'s job to distinguish.
  func sync(live orders: [LiveOrder]) {
    // The launcher keeps a served lunch in its list so it can be reviewed;
    // the lock screen does not. Seated is the end of the activity, and so is
    // a sitting the wall clock has already passed by a quarter of an hour —
    // whatever the kitchen's clock says, the phone's is the one the lock
    // screen is read against.
    let running = orders.filter { !$0.state.isOver && $0.slotStartsAt.addingTimeInterval(15 * 60) > .now }
    let keep = Set(running.map(\.id))
    for activity in Activity<BasuActivityAttributes>.activities
    where !keep.contains(activity.attributes.orderID) {
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
    if let first = running.first {
      OrderSnapshotStore.write(first.snapshot)
      show(first.snapshot)
    } else {
      OrderSnapshotStore.write(nil)
    }
    WidgetCenter.shared.reloadTimelines(ofKind: OrderSnapshotStore.widgetKind)
  }

  private func show(_ snap: OrderSnapshot) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    let state = BasuActivityAttributes.ContentState(
      stage: snap.stage, seatingTime: snap.seatingTime, fireTime: snap.fireTime, stageLabel: snap.stageLabel,
    )
    // Stale half an hour after seating: by then the lunch is a memory.
    let content = ActivityContent(state: state, staleDate: snap.seatingTime.addingTimeInterval(30 * 60))

    if let running = Activity<BasuActivityAttributes>.activities.first(where: { $0.attributes.orderID == snap.orderID }) {
      Task { await running.update(content) }
      return
    }
    let attributes = BasuActivityAttributes(
      orderID: snap.orderID, venueName: snap.venueName, partySize: snap.partySize,
      orderNumber: snap.orderNumber, serviceID: "food",
    )
    // With push, so the server can move the card; without it if the build
    // has no APS entitlement, because a card that only the app updates still
    // beats no card.
    if let activity = try? Activity.request(attributes: attributes, content: content, pushType: .token) {
      watchToken(of: activity)
    } else {
      _ = try? Activity.request(attributes: attributes, content: content, pushType: nil)
    }
  }

  private func watchToken(of activity: Activity<BasuActivityAttributes>) {
    let id = activity.attributes.orderID
    guard !watching.contains(id) else { return }
    watching.insert(id)
    Task {
      for await data in activity.pushTokenUpdates {
        let token = data.map { String(format: "%02x", $0) }.joined()
        await register?(id, token)
      }
      watching.remove(id)
    }
  }

  private func end(_ orderId: String) {
    for activity in Activity<BasuActivityAttributes>.activities where activity.attributes.orderID == orderId {
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
  }

  private func endAll() {
    for activity in Activity<BasuActivityAttributes>.activities {
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
  }
}

extension OrderState {
  /// The three the bar has. Everything before the fire is waiting.
  var stage: OrderStage {
    switch self {
    case .fired, .cooking: .cooking
    case .ready, .served: .ready
    default: .waiting
    }
  }

  /// Nothing more will happen to it. The activity ends and the widget empties.
  var isOver: Bool {
    [.served, .closed, .cancelled, .refunded, .noShow, .rejected].contains(self)
  }
}

extension LiveOrder {
  var snapshot: OrderSnapshot {
    OrderSnapshot(
      orderID: id, venueName: restaurant.name, orderNumber: "№\(code)", partySize: partySize ?? 1,
      stage: state.stage, stageLabel: state.stage.label,
      seatingTime: slotStartsAt, fireTime: fireAt, takenAt: .now,
    )
  }
}
