import ActivityKit
import BasuKit
import SwiftUI
import WidgetKit

/**
 An идэш on the lock screen and in the Dynamic Island, on the day it changes
 hands.

 The order code is the largest thing on the card, because it is the one thing
 the guest does anything with: it is read out at the handover. Under it, the
 same meter of four every Basu screen draws — the step being lived in
 crimson, and gold once the meat is in hand — then the word, what to do now,
 and, for a pickup, where to go. Same charcoal card as the lunch.
 */
struct IdeshLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: IdeshActivityAttributes.self) { context in
      IdeshLockCard(attributes: context.attributes, state: context.state)
        .activityBackgroundTint(BasuColor.lockCard)
        .activitySystemActionForegroundColor(BasuColor.onLock)
        .widgetURL(Self.link(context.attributes))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.bottom) {
          IdeshExpandedIsland(attributes: context.attributes, state: context.state)
        }
      } compactLeading: {
        RasterTile(name: "idesh-tile", size: 22, radius: 6)
          .padding(.leading, 2)
      } compactTrailing: {
        Text(context.state.short)
          .font(BasuFont.display(16, .bold))
          .foregroundStyle(context.state.calling || context.state.finished ? BasuColor.gold : BasuColor.onLock)
          .lineLimit(1)
          .padding(.trailing, 2)
      } minimal: {
        RasterTile(name: "idesh-tile", size: 22, radius: 6)
      }
      .widgetURL(Self.link(context.attributes))
      .keylineTint(BasuColor.gold)
    }
  }

  static func link(_ attributes: IdeshActivityAttributes) -> URL? {
    URL(string: "basu://idesh/\(attributes.orderID)")
  }
}

/// Padding 16 × 18. The system draws the card's radius; this sits on the
/// app's charcoal (`lockCard`), and stays inside the lock screen's 160.
struct IdeshLockCard: View {
  let attributes: IdeshActivityAttributes
  let state: IdeshActivityAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      IdeshHeader(attributes: attributes, tile: 40, code: 34)

      if state.step > 0 {
        IdeshMeter(state: state)
      }

      VStack(alignment: .leading, spacing: 5) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(state.word)
            .font(BasuFont.sans(14, .bold))
            .foregroundStyle(state.cancelled ? BasuColor.accentInk : BasuColor.onLock)
            .lineLimit(1)
          Spacer(minLength: 8)
          IdeshDay(attributes: attributes, state: state)
        }
        detail
      }
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 16)
    .accessibilityElement(children: .combine)
  }

  /// Where to go, for a pickup that is not over; otherwise what to do now.
  @ViewBuilder private var detail: some View {
    if !attributes.delivery, let place = attributes.pickupAddress, !place.isEmpty,
       !state.finished, !state.cancelled {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "mappin")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(BasuColor.gold)
        Text(place)
          .font(BasuFont.sans(12, .medium))
          .foregroundStyle(BasuColor.onLock2)
          .lineLimit(1)
      }
    } else {
      Text(state.hint(delivery: attributes.delivery))
        .font(BasuFont.sans(12, .medium))
        .foregroundStyle(BasuColor.onLock2)
        .lineLimit(1)
    }
  }
}

/// The expanded island: the card in two rows. The island is short, so the
/// word moves up beside the meat, and the address stays on the lock screen.
struct IdeshExpandedIsland: View {
  let attributes: IdeshActivityAttributes
  let state: IdeshActivityAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      IdeshHeader(
        attributes: attributes, tile: 36, code: 32,
        line: Text(state.word)
          .font(BasuFont.sans(12, .bold))
          .foregroundStyle(state.cancelled ? BasuColor.accentInk : state.calling ? BasuColor.gold : BasuColor.onLock)
          + Text(" · \(attributes.what)")
          .font(BasuFont.sans(12, .semibold))
          .foregroundStyle(BasuColor.onLock2),
      )
      if state.step > 0 {
        IdeshMeter(state: state)
      }
    }
    .padding(.top, 6)
    .padding(.horizontal, 4)
    .padding(.bottom, 4)
    .accessibilityElement(children: .combine)
  }
}

/// The tile, the supplier over the meat, and the code over КОД.
private struct IdeshHeader: View {
  let attributes: IdeshActivityAttributes
  let tile: CGFloat
  let code: CGFloat
  /// Under the supplier: the meat and the amount, unless told otherwise.
  var line: Text?

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      RasterTile(name: "idesh-tile", size: tile, radius: tile * 0.26)
      VStack(alignment: .leading, spacing: 3) {
        Text(attributes.supplier)
          .font(BasuFont.sans(15, .bold))
          .foregroundStyle(BasuColor.onLock)
          .lineLimit(1)
        (line ?? Text(attributes.what).font(BasuFont.sans(12, .semibold)).foregroundStyle(BasuColor.onLock2))
          .lineLimit(1)
      }
      .layoutPriority(1)
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 2) {
        Text("№\(attributes.code)")
          .font(BasuFont.display(code))
          .monospacedDigit()
          .foregroundStyle(BasuColor.onLock)
        UnitLabel("Код", colour: BasuColor.gold)
      }
      .fixedSize()
    }
  }
}

/// Four segments, the step being lived in crimson; all gold once handed over.
private struct IdeshMeter: View {
  let state: IdeshActivityAttributes.ContentState

  var body: some View {
    Meter(
      step: state.step,
      current: state.finished ? BasuColor.gold : BasuColor.accent,
      filled: state.finished ? BasuColor.gold : BasuColor.ink,
      track: BasuColor.lockTrack,
      height: 5,
    )
  }
}

/// «АВАХ · ӨНӨӨДӨР» — or ИРЭХ for a delivery — in gold, right of the word.
private struct IdeshDay: View {
  let attributes: IdeshActivityAttributes
  let state: IdeshActivityAttributes.ContentState

  var body: some View {
    if !state.finished && !state.cancelled {
      HStack(spacing: 6) {
        UnitLabel(attributes.delivery ? "Ирэх" : "Авах", colour: BasuColor.onLock2)
        Text(BasuFormat.dayWord(state.receiveOn))
          .font(BasuFont.display(17, .bold))
          .foregroundStyle(BasuColor.gold)
      }
      .fixedSize()
    }
  }
}
