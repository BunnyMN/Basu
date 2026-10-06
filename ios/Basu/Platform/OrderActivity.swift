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

  /// How to hand a token to the server: which kind of order (`order` for a
  /// lunch, `idesh`), which one, and the token. Set by whoever owns the session.
  var register: ((_ subject: String, _ orderId: String, _ token: String) async -> Void)?

  private var watching: Set<String> = []

  /// The launcher's list, for the widget: the first thing that will happen.
  /// Nothing live clears the snapshot; a failed fetch leaves it alone, which
  /// is `AppModel`'s job to distinguish.
  func sync(live orders: [LiveOrder]) async {
    // The launcher keeps a served lunch in its list so it can be reviewed;
    // the lock screen does not. Seated is the end of the activity, and so is
    // a sitting the wall clock has already passed by a quarter of an hour —
    // whatever the kitchen's clock says, the phone's is the one the lock
    // screen is read against.
    let running = orders.filter { !$0.state.isOver && $0.slotStartsAt.addingTimeInterval(15 * 60) > .now }
    let keep = Set(running.map(\.id))
    // Awaited in this task rather than handed to a new one: `Activity` is not
    // Sendable, and Swift 6.3's region checker refuses to move one into a
    // `Task` closure in either direction. Ending a card takes no time, and
    // the caller is already off the main thread's critical path.
    for activity in Activity<BasuActivityAttributes>.activities
    where !keep.contains(activity.attributes.orderID) {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
    if let first = running.first {
      OrderSnapshotStore.write(first.snapshot)
      await show(first.snapshot)
    } else {
      OrderSnapshotStore.write(nil)
    }
    WidgetCenter.shared.reloadTimelines(ofKind: OrderSnapshotStore.widgetKind)
  }

  private func show(_ snap: OrderSnapshot) async {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    let state = BasuActivityAttributes.ContentState(
      stage: snap.stage, seatingTime: snap.seatingTime, fireTime: snap.fireTime, stageLabel: snap.stageLabel,
    )
    // Stale half an hour after seating: by then the lunch is a memory.
    let content = ActivityContent(state: state, staleDate: snap.seatingTime.addingTimeInterval(30 * 60))

    // A loop rather than `first(where:)`: a closure written here is main-actor
    // isolated, and the activity it picks out is dragged into that region —
    // after which `update`, which is nonisolated, cannot be called on it.
    let wanted = snap.orderID
    for running in Activity<BasuActivityAttributes>.activities where running.attributes.orderID == wanted {
      await running.update(content)
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
        await register?("order", id, token)
      }
      watching.remove(id)
    }
  }

  // MARK: - идэш

  /// Orders whose card the guest swiped away: not put back up again.
  private static let sweptKey = "idesh.activity.swept"

  /**
   The launcher's идэш list, on the lock screen: one card per order received
   today (or already on the road), moved as the order moves, and closed once
   the meat is in hand — left up half an hour on «Хүлээлгэн өгсөн», so the
   last thing the card says is that it is done.

   Only today's: an activity lives eight hours, and an идэш takes days.
   */
  func sync(idesh orders: [LiveIdesh]) async {
    // The Home Screen's: the next one still to come, whatever its day.
    IdeshSnapshotStore.write(LiveIdesh.next(in: orders)?.widgetSnapshot)
    WidgetCenter.shared.reloadTimelines(ofKind: OrderSnapshotStore.widgetKind)

    let today = BasuFormat.today()
    var byID: [String: LiveIdesh] = [:]
    for order in orders { byID[order.id] = order }
    var swept = Set(UserDefaults.standard.stringArray(forKey: Self.sweptKey) ?? [])
    // Forget the swept ones that are no longer anybody's business.
    swept.formIntersection(byID.keys)
    UserDefaults.standard.set(Array(swept), forKey: Self.sweptKey)

    var up: Set<String> = []
    for activity in Activity<IdeshActivityAttributes>.activities {
      let id = activity.attributes.orderID
      guard let order = byID[id] else {
        await activity.end(nil, dismissalPolicy: .immediate)
        continue
      }
      let content = ActivityContent(state: order.activityState, staleDate: order.cardStale)
      if order.cardOver {
        if activity.activityState == .active {
          await activity.end(content, dismissalPolicy: .after(.now.addingTimeInterval(30 * 60)))
        }
      } else if order.wantsCard(today: today) {
        if activity.content.state != order.activityState { await activity.update(content) }
        up.insert(id)
      } else {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }

    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    for order in orders where order.wantsCard(today: today) && !up.contains(order.id) && !swept.contains(order.id) {
      start(order.cardAttributes, content: ActivityContent(state: order.activityState, staleDate: order.cardStale))
    }
  }

  private func start(_ attributes: IdeshActivityAttributes, content: ActivityContent<IdeshActivityAttributes.ContentState>) {
    if let activity = try? Activity.request(attributes: attributes, content: content, pushType: .token) {
      watch(activity)
    } else if let activity = try? Activity.request(attributes: attributes, content: content, pushType: nil) {
      watch(activity)
    }
  }

  /// The token, for the server; and a swipe, so a card the guest put away
  /// stays away. The system's own end — eight hours on — is not a swipe: it
  /// goes by way of `ended`, and the card comes back when the app is opened.
  private func watch(_ activity: Activity<IdeshActivityAttributes>) {
    let id = activity.attributes.orderID
    guard !watching.contains(id) else { return }
    watching.insert(id)
    Task {
      for await data in activity.pushTokenUpdates {
        let token = data.map { String(format: "%02x", $0) }.joined()
        await register?("idesh", id, token)
      }
    }
    Task {
      var was = activity.activityState
      for await now in activity.activityStateUpdates {
        if now == .dismissed && was == .active {
          var swept = Set(UserDefaults.standard.stringArray(forKey: Self.sweptKey) ?? [])
          swept.insert(id)
          UserDefaults.standard.set(Array(swept), forKey: Self.sweptKey)
        }
        was = now
      }
      watching.remove(id)
    }
  }

  #if DEBUG
    /// `BASU_SCREEN=activity`: a lunch on the lock screen, in the island and
    /// on the widget without one being bought — so the pass can photograph
    /// them after the demo day's last sitting. Debug only. Against a server
    /// that is not answering, nothing syncs it away again.
    func showSample() async {
      let seating = Date.now.addingTimeInterval(40 * 60)
      let snap = OrderSnapshot(
        orderID: "sample", venueName: "Алтан Тавган", orderNumber: "№0971", partySize: 2,
        stage: .cooking, stageLabel: OrderStage.cooking.label,
        seatingTime: seating, fireTime: seating.addingTimeInterval(-15 * 60), takenAt: .now,
      )
      OrderSnapshotStore.write(snap)
      WidgetCenter.shared.reloadTimelines(ofKind: OrderSnapshotStore.widgetKind)
      await show(snap)
    }

    /// `BASU_SCREEN=idesh-activity`: a sheep ready for pickup today, on the
    /// lock screen and in the island, with nothing bought. `BASU_IDESH_STATE`
    /// picks the state to photograph. Debug only.
    func showIdeshSample() async {
      for activity in Activity<IdeshActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      let raw = ProcessInfo.processInfo.environment["BASU_IDESH_STATE"] ?? "READY"
      let state = IdeshState(rawValue: raw) ?? .ready
      let delivery = state == .dispatched
      let attributes = IdeshActivityAttributes(
        orderID: "sample-idesh", code: "7042", supplier: "Хангайн мах",
        what: "Хонины мах · 1 толгой", receive: delivery ? "delivery" : "pickup",
        pickupAddress: delivery ? nil : "БЗД, 26-р хороо, Шархад 3-р гудамж 14",
      )
      // `BASU_IDESH_IN_DAYS` moves the day, for the widget's «Маргааш».
      let days = Double(ProcessInfo.processInfo.environment["BASU_IDESH_IN_DAYS"] ?? "") ?? 0
      let content = IdeshActivityAttributes.ContentState(
        state: state.rawValue, word: state.word, step: state.step,
        receiveOn: BasuFormat.today(.now.addingTimeInterval(days * 86_400)),
      )
      _ = try? Activity.request(attributes: attributes, content: ActivityContent(state: content, staleDate: nil), pushType: nil)
      // And the Home Screen's widget, the same order.
      IdeshSnapshotStore.write(IdeshSnapshot(
        orderID: attributes.orderID, code: attributes.code, supplier: attributes.supplier,
        what: attributes.what, receive: attributes.receive, receiveOn: content.receiveOn,
        state: content.state, word: content.word, step: content.step, takenAt: .now,
      ))
      WidgetCenter.shared.reloadTimelines(ofKind: OrderSnapshotStore.widgetKind)
    }
  #endif

  /// Signed out: nothing of the last person's stays on the lock screen or
  /// the Home Screen.
  func clear() async {
    await endAll()
    for activity in Activity<IdeshActivityAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
    OrderSnapshotStore.write(nil)
    IdeshSnapshotStore.write(nil)
    WidgetCenter.shared.reloadTimelines(ofKind: OrderSnapshotStore.widgetKind)
  }

  private func end(_ orderId: String) async {
    for activity in Activity<BasuActivityAttributes>.activities where activity.attributes.orderID == orderId {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  private func endAll() async {
    for activity in Activity<BasuActivityAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
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

extension IdeshState {
  /// Along the meter: paid, being prepared, ready, on its way or handed over.
  /// Unpaid, cancelled or refunded, there is no meter — the word says it.
  var step: Int {
    switch self {
    case .paid: 1
    case .preparing: 2
    case .ready: 3
    case .dispatched, .handed, .closed: 4
    case .draft, .cancelled, .refunded: 0
    }
  }
}

extension LiveIdesh {
  /// Wanted on the lock screen: still going, and either received today (or
  /// late) or already on the road.
  func wantsCard(today: String) -> Bool {
    switch state {
    case .dispatched: true
    case .paid, .preparing, .ready: receiveOnDay <= today
    default: false
    }
  }

  /// Nothing more will happen: the card shows the last word and goes.
  var cardOver: Bool {
    [.handed, .closed, .cancelled, .refunded].contains(state)
  }

  var activityState: IdeshActivityAttributes.ContentState {
    .init(state: state.rawValue, word: state.word, step: state.step, receiveOn: receiveOnDay)
  }

  var cardAttributes: IdeshActivityAttributes {
    IdeshActivityAttributes(
      orderID: id, code: code, supplier: supplier.name, what: "\(meat) · \(amount)",
      receive: receive, pickupAddress: receive == "pickup" ? pickupAddress : nil,
    )
  }

  /// Out of date at the end of the day it was for.
  var cardStale: Date? {
    ISODate.parse("\(receiveOnDay)T23:59:59+08:00")
  }

  /// The one the Home Screen shows: the soonest still to come. Finished,
  /// cancelled or unpaid ones are not news.
  static func next(in orders: [LiveIdesh]) -> LiveIdesh? {
    orders
      .filter { [.paid, .preparing, .ready, .dispatched].contains($0.state) }
      .min { ($0.receiveOnDay, $0.code) < ($1.receiveOnDay, $1.code) }
  }

  var widgetSnapshot: IdeshSnapshot {
    IdeshSnapshot(
      orderID: id, code: code, supplier: supplier.name, what: "\(meat) · \(amount)",
      receive: receive, receiveOn: receiveOnDay, state: state.rawValue, word: state.word,
      step: state.step, takenAt: .now,
    )
  }
}
