import BasuKit
import SwiftUI
import WidgetKit

/**
 The order on the Home Screen, small and medium, on the activity's timeline.

 Reads the snapshot the app wrote into the App Group and nothing else. Entries
 at now, the fire time, the seating time, and seating + 15 minutes — the reset
 to empty. The empty state is a sentence, never a zeroed layout.

 Dark whatever the Home Screen is («Тансаг хар»): the charcoal ground, the time
 in the display face, «ИРЭХ» in gold, and the meter of four — no green.
 */
struct OrderWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: OrderSnapshotStore.widgetKind, provider: OrderProvider()) { entry in
      OrderWidgetView(entry: entry)
        .containerBackground(for: .widget) { WidgetGround() }
    }
    .configurationDisplayName("Захиалга")
    .description("Гал тавих цаг ба ирэх цаг.")
    .supportedFamilies([.systemSmall, .systemMedium])
    .contentMarginsDisabled()
  }
}

/// The widget's ground: the tile's charcoal, lit from the upper left.
struct WidgetGround: View {
  var body: some View {
    LinearGradient(
      colors: [Color(hex: 0x241E1C), BasuColor.bg],
      startPoint: UnitPoint(x: 0.15, y: 0),
      endPoint: UnitPoint(x: 0.8, y: 1),
    )
  }
}

struct OrderEntry: TimelineEntry {
  let date: Date
  let snapshot: OrderSnapshot?
}

struct OrderProvider: TimelineProvider {
  func placeholder(in context: Context) -> OrderEntry {
    OrderEntry(date: .now, snapshot: .sample)
  }

  func getSnapshot(in context: Context, completion: @escaping (OrderEntry) -> Void) {
    completion(OrderEntry(date: .now, snapshot: context.isPreview ? .sample : OrderSnapshotStore.read()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<OrderEntry>) -> Void) {
    let now = Date()
    guard let snap = OrderSnapshotStore.read(), snap.seatingTime.addingTimeInterval(15 * 60) > now else {
      completion(Timeline(entries: [OrderEntry(date: now, snapshot: nil)], policy: .never))
      return
    }

    var entries = [OrderEntry(date: now, snapshot: snap)]
    if let fire = snap.fireTime, fire > now {
      var fired = snap
      fired.stage = max(snap.stage, .cooking)
      fired.stageLabel = fired.stage == snap.stage ? snap.stageLabel : OrderStage.cooking.label
      entries.append(OrderEntry(date: fire, snapshot: fired))
    }
    if snap.seatingTime > now {
      var seated = snap
      seated.stage = .ready
      seated.stageLabel = OrderStage.ready.label
      entries.append(OrderEntry(date: snap.seatingTime, snapshot: seated))
    }
    entries.append(OrderEntry(date: snap.seatingTime.addingTimeInterval(15 * 60), snapshot: nil))
    completion(Timeline(entries: entries, policy: .atEnd))
  }
}

extension OrderStage: Comparable {
  public static func < (a: OrderStage, b: OrderStage) -> Bool { a.index < b.index }
}

extension OrderSnapshot {
  /// What the gallery shows before anybody has ordered.
  static let sample = OrderSnapshot(
    orderID: "sample", venueName: "Алтан Тавган", orderNumber: "№0971", partySize: 2,
    stage: .cooking, stageLabel: "Гал дээр гарлаа",
    seatingTime: Calendar.current.date(bySettingHour: 11, minute: 30, second: 0, of: .now) ?? .now,
    fireTime: Calendar.current.date(bySettingHour: 11, minute: 15, second: 0, of: .now),
    takenAt: .now,
  )
}

struct OrderWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: OrderEntry

  var body: some View {
    Group {
      if let snap = entry.snapshot {
        Group {
          if family == .systemSmall {
            SmallOrder(snap: snap)
          } else {
            MediumOrder(snap: snap)
          }
        }
        .widgetURL(snap.url)
      } else {
        EmptyOrder()
          .widgetURL(URL(string: "basu://dine"))
      }
    }
    .padding(16)
  }
}

/// The tile at the top, then the seating time over `ИРЭХ · №0971`: the word
/// in gold, the number in `ink3`. Nothing else.
struct SmallOrder: View {
  let snap: OrderSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      FoodTile(size: 30, radius: 8)
      Spacer(minLength: 0)
      Text(BasuFormat.hhmm(snap.seatingTime))
        .font(BasuFont.display(44))
        .monospacedDigit()
        .foregroundStyle(BasuColor.ink)
      HStack(spacing: 6) {
        UnitLabel("ИРЭХ", colour: BasuColor.gold)
        Text(snap.orderNumber)
          .font(BasuFont.sans(12, .semibold))
          .monospacedDigit()
          .foregroundStyle(BasuColor.ink3)
          .lineLimit(1)
      }
      .padding(.top, 2)
      StageBar(stage: snap.stage)
        .padding(.top, 10)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}

/// The activity card's structure, on the ground: header row, meter, stage line.
struct MediumOrder: View {
  let snap: OrderSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top, spacing: 12) {
        FoodTile(size: 32, radius: 9)
        VStack(alignment: .leading, spacing: 4) {
          Text(snap.venueName)
            .font(BasuFont.sans(15, .bold))
            .foregroundStyle(BasuColor.ink)
            .lineLimit(1)
          Text("\(snap.orderNumber) · \(snap.partySize) хүн")
            .font(BasuFont.sans(12, .semibold))
            .monospacedDigit()
            .foregroundStyle(BasuColor.ink3)
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 4) {
          Text(BasuFormat.hhmm(snap.seatingTime))
            .font(BasuFont.display(40))
            .monospacedDigit()
            .foregroundStyle(BasuColor.ink)
          UnitLabel("ИРЭХ", colour: BasuColor.gold)
        }
      }
      Spacer(minLength: 8)
      VStack(alignment: .leading, spacing: 8) {
        StageBar(stage: snap.stage)
        HStack(alignment: .firstTextBaseline) {
          Text(snap.stageLabel)
            .font(BasuFont.sans(13, .bold))
            .foregroundStyle(BasuColor.ink)
          Spacer(minLength: 8)
          if let fire = snap.fireTime {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              UnitLabel("ГАЛ", colour: BasuColor.ink3)
              Text(BasuFormat.hhmm(fire))
                .font(BasuFont.display(18))
                .monospacedDigit()
                .foregroundStyle(BasuColor.ink2)
            }
          }
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}

/// The tile and one sentence. Never a zeroed layout.
struct EmptyOrder: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      FoodTile(size: 30, radius: 8)
      Text("Захиалга алга. Товшиж хоол сонгоно.")
        .font(BasuFont.sans(13, .semibold))
        .foregroundStyle(BasuColor.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}
