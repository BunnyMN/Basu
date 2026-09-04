import ActivityKit
import BasuKit
import SwiftUI
import WidgetKit

/**
 The order on the lock screen and in the Dynamic Island.

 The seating time is the largest thing on the card because it is the only
 number the user acts on. The expanded island shows nothing the card does not.
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
          .font(BasuFont.mono(15, .semibold))
          .monospacedDigit()
          .foregroundStyle(BasuColor.onLock)
          .padding(.trailing, 2)
      } minimal: {
        FoodTile(size: 22, radius: 6)
      }
      .widgetURL(URL(string: "basu://order/\(context.attributes.orderID)"))
      .keylineTint(BasuColor.accent)
    }
  }
}

/// The expanded island: 34pt icon, venue over the stage, the seating time
/// over СУУХ, and the bar. Nothing the lock screen card does not show.
struct ExpandedIsland: View {
  let attributes: BasuActivityAttributes
  let state: BasuActivityAttributes.ContentState

  private let dim = Color(red: 0x8E / 255, green: 0x9A / 255, blue: 0xA0 / 255)

  var body: some View {
    VStack(alignment: .leading, spacing: 15) {
      HStack(alignment: .top, spacing: 12) {
        FoodTile(size: 34, radius: 9)
        VStack(alignment: .leading, spacing: 4) {
          Text(attributes.venueName)
            .font(BasuFont.sans(15, .semibold))
            .foregroundStyle(BasuColor.onLock)
            .lineLimit(1)
          Text(state.stageLabel)
            .font(BasuFont.mono(11.5))
            .foregroundStyle(dim)
            .lineLimit(1)
        }
        .layoutPriority(1)
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 3) {
          Text(BasuFormat.hhmm(state.seatingTime))
            .font(BasuFont.mono(28, .semibold))
            .monospacedDigit()
            .foregroundStyle(BasuColor.onLock)
          UnitLabel("СУУХ", colour: dim)
        }
        .fixedSize()
      }
      StageBar(stage: state.stage, track: Color(red: 0x2B / 255, green: 0x32 / 255, blue: 0x36 / 255))
    }
    .padding(.top, 6)
    .padding(.horizontal, 4)
    .padding(.bottom, 4)
    .accessibilityElement(children: .combine)
  }
}

/// Padding 16 × 18, gap 14. The system draws the card's material and radius;
/// this is what sits on it.
struct LockScreenCard: View {
  let attributes: BasuActivityAttributes
  let state: BasuActivityAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        FoodTile(size: 30, radius: 8)
        VStack(alignment: .leading, spacing: 4) {
          Text(attributes.venueName)
            .font(BasuFont.sans(15, .semibold))
            .foregroundStyle(BasuColor.onLock)
            .lineLimit(1)
          Text("\(attributes.orderNumber) · \(attributes.partySize) хүн")
            .font(BasuFont.mono(11.5))
            .monospacedDigit()
            .foregroundStyle(BasuColor.onLock2)
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 3) {
          Text(BasuFormat.hhmm(state.seatingTime))
            .font(BasuFont.mono(26, .semibold))
            .monospacedDigit()
            .foregroundStyle(BasuColor.onLock)
          UnitLabel("СУУХ", colour: BasuColor.onLock2)
        }
      }

      VStack(alignment: .leading, spacing: 7) {
        StageBar(stage: state.stage, track: BasuColor.lockTrack)
        HStack(alignment: .firstTextBaseline) {
          Text(state.stageLabel)
            .font(BasuFont.sans(12.5, .medium))
            .foregroundStyle(BasuColor.onLock)
          Spacer(minLength: 8)
          if let fire = state.fireTime {
            Text(BasuFormat.hhmm(fire))
              .font(BasuFont.mono(12.5, .semibold))
              .monospacedDigit()
              .foregroundStyle(BasuColor.accent)
          }
        }
      }
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 16)
    .accessibilityElement(children: .combine)
  }
}

/// `СУУХ` — mono 9/500, tracked 0.14em.
struct UnitLabel: View {
  let text: String
  let colour: Color

  init(_ text: String, colour: Color) {
    self.text = text
    self.colour = colour
  }

  var body: some View {
    Text(text)
      .font(BasuFont.mono(9, .medium))
      .tracking(9 * 0.14)
      .foregroundStyle(colour)
  }
}
