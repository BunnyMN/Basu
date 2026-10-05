import ActivityKit
import BasuKit
import SwiftUI
import WidgetKit

/**
 The order on the lock screen and in the Dynamic Island.

 The seating time is the largest thing on the card because it is the only
 number the user acts on: the display face, with «ИРЭХ» under it in gold. The
 card is the app's own charcoal, and the stage is the meter of four — no
 green. The expanded island shows nothing the card does not.
 */
struct OrderLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: BasuActivityAttributes.self) { context in
      LockScreenCard(attributes: context.attributes, state: context.state)
        .activityBackgroundTint(BasuColor.lockCard)
        .activitySystemActionForegroundColor(BasuColor.onLock)
    } dynamicIsland: { context in
      DynamicIsland {
        // Everything in the bottom region: leading and trailing are each
        // given a third of the width, which truncates any venue name worth
        // having. The bottom spans the island, so the card is laid out as
        // drawn — padding 18 × 20 × 20, gap 15.
        DynamicIslandExpandedRegion(.bottom) {
          ExpandedIsland(attributes: context.attributes, state: context.state)
        }
      } compactLeading: {
        FoodTile(size: 22, radius: 6)
          .padding(.leading, 2)
      } compactTrailing: {
        Text(BasuFormat.hhmm(context.state.seatingTime))
          .font(BasuFont.display(18))
          .monospacedDigit()
          .foregroundStyle(BasuColor.onLock)
          .padding(.trailing, 2)
      } minimal: {
        FoodTile(size: 22, radius: 6)
      }
      .widgetURL(URL(string: "basu://order/\(context.attributes.orderID)"))
      .keylineTint(BasuColor.gold)
    }
  }
}

/// The expanded island: the tile, venue over the stage, the seating time
/// over ИРЭХ, and the meter. Nothing the lock screen card does not show.
struct ExpandedIsland: View {
  let attributes: BasuActivityAttributes
  let state: BasuActivityAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 15) {
      HStack(alignment: .top, spacing: 12) {
        FoodTile(size: 34, radius: 9)
        VStack(alignment: .leading, spacing: 4) {
          Text(attributes.venueName)
            .font(BasuFont.sans(15, .bold))
            .foregroundStyle(BasuColor.onLock)
            .lineLimit(1)
          // Words, so the sans, as on the lock screen card.
          Text(state.stageLabel)
            .font(BasuFont.sans(12, .semibold))
            .foregroundStyle(BasuColor.onLock2)
            .lineLimit(1)
        }
        .layoutPriority(1)
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 4) {
          Text(BasuFormat.hhmm(state.seatingTime))
            .font(BasuFont.display(36))
            .monospacedDigit()
            .foregroundStyle(BasuColor.onLock)
          UnitLabel("ИРЭХ", colour: BasuColor.gold)
        }
        .fixedSize()
      }
      StageBar(stage: state.stage, track: BasuColor.lockTrack)
    }
    .padding(.top, 6)
    .padding(.horizontal, 4)
    .padding(.bottom, 4)
    .accessibilityElement(children: .combine)
  }
}

/// Padding 16 × 18, gap 14. The system draws the card's radius; this is what
/// sits on it, over the app's charcoal (`lockCard`).
struct LockScreenCard: View {
  let attributes: BasuActivityAttributes
  let state: BasuActivityAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        FoodTile(size: 32, radius: 9)
        VStack(alignment: .leading, spacing: 4) {
          Text(attributes.venueName)
            .font(BasuFont.sans(15, .bold))
            .foregroundStyle(BasuColor.onLock)
            .lineLimit(1)
          Text("\(attributes.orderNumber) · \(attributes.partySize) хүн")
            .font(BasuFont.sans(12, .semibold))
            .monospacedDigit()
            .foregroundStyle(BasuColor.onLock2)
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 4) {
          Text(BasuFormat.hhmm(state.seatingTime))
            .font(BasuFont.display(36))
            .monospacedDigit()
            .foregroundStyle(BasuColor.onLock)
          UnitLabel("ИРЭХ", colour: BasuColor.gold)
        }
      }

      VStack(alignment: .leading, spacing: 8) {
        StageBar(stage: state.stage, track: BasuColor.lockTrack)
        HStack(alignment: .firstTextBaseline) {
          Text(state.stageLabel)
            .font(BasuFont.sans(13, .bold))
            .foregroundStyle(BasuColor.onLock)
          Spacer(minLength: 8)
          if let fire = state.fireTime {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              UnitLabel("ГАЛ", colour: BasuColor.onLock2)
              Text(BasuFormat.hhmm(fire))
                .font(BasuFont.display(18))
                .monospacedDigit()
                .foregroundStyle(BasuColor.ink2)
            }
          }
        }
      }
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 16)
    .accessibilityElement(children: .combine)
  }
}

/// The time label — what the time over it is the time of (`ИРЭХ`): 11, the
/// heaviest Manrope, uppercase, tracked wide — the web's «АВАХ» under a day.
struct UnitLabel: View {
  let text: String
  let colour: Color

  init(_ text: String, colour: Color) {
    self.text = text
    self.colour = colour
  }

  var body: some View {
    Text(text.uppercased())
      .font(BasuFont.sans(11, .heavy))
      .tracking(11 * 0.16)
      .foregroundStyle(colour)
  }
}
