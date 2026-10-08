import BasuKit
import SwiftUI

/**
 One order, as a card: a picture of what it is, what it is, the state in one
 word with a meter of four under it, and — behind a hairline on the right —
 the day or the time in the display face over what it is the time of, in gold.

 The same card on the launcher and under «Захиалга», for a lunch and for a
 sheep alike. A cancelled order keeps its word, in crimson, and loses the
 meter; there is nothing left to measure.
 */
struct OrderCard: View {
  let item: LiveItem
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 14) {
        Thumbnail(item: item)
        words
        if !typeSize.isAccessibilitySize { corner }
      }
      .fixedSize(horizontal: false, vertical: true)

      if typeSize.isAccessibilitySize {
        corner.frame(maxWidth: .infinity, alignment: .leading)
      }

      // The fire time, when a lunch is the only thing running: the product
      // is that the kitchen starts as the guest sets off.
      if let extra = item.extra {
        Hairline()
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Text(extra.label)
            .font(.sans(13, .semibold))
            .foregroundStyle(Color.ink3)
          Spacer(minLength: 0)
          Text(Format.hhmm(extra.time))
            .font(.display(20))
            .monospacedDigit()
            .foregroundStyle(Color.ink)
        }
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .card(radius: BasuMetric.card)
    .contentShape(RoundedRectangle(cornerRadius: BasuMetric.card, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(item.spoken)
    .accessibilityIdentifier("live.\(item.id)")
  }

  private var words: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        if item.news { NewsDot() }
        Text(item.headline)
          .font(.sans(17, .bold))
          .foregroundStyle(Color.ink)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
          .multilineTextAlignment(.leading)
      }
      Text(item.word)
        .font(.sans(14, .semibold))
        .foregroundStyle(tone)
        .padding(.top, 6)
        .fixedSize(horizontal: false, vertical: true)
      if item.step > 0 {
        Meter(step: item.step)
          .padding(.top, 10)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var tone: Color {
    switch item.tone {
    case .plain: .ink2
    case .stop: .accentInk
    case .hold: .gold
    }
  }

  /// `10/14 · АВАХ` behind a hairline, at the card's full height.
  private var corner: some View {
    VStack(spacing: 6) {
      Text(item.when)
        .font(.display(32))
        .monospacedDigit()
        .foregroundStyle(Color.ink)
        .lineLimit(1)
        .minimumScaleFactor(0.6)
      Text(item.timeLabel)
        .font(.sans(11, .heavy))
        .tracking(11 * 0.16)
        .foregroundStyle(Color.gold)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    .frame(minWidth: 70)
    .frame(maxHeight: .infinity)
    .padding(.leading, typeSize.isAccessibilitySize ? 0 : 12)
    .overlay(alignment: .leading) {
      if !typeSize.isAccessibilitySize {
        Rectangle().fill(Color.line).frame(width: BasuMetric.hairline)
      }
    }
  }
}

/// Something said about the order that the guest has not opened it to see:
/// the web's own `.new-dot`, crimson in a faint crimson ring, sitting on the
/// title's first line. VoiceOver hears it in the card's words instead.
private struct NewsDot: View {
  var body: some View {
    Circle()
      .fill(Color.accent)
      .frame(width: 9, height: 9)
      .background(Circle().fill(Color.accent.opacity(0.2)).padding(-3))
      .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
      .accessibilityHidden(true)
  }
}

/// The order's picture: the animal's photograph when the order names one,
/// otherwise the app's own tile, at 64 and fourteen of radius.
private struct Thumbnail: View {
  let item: LiveItem
  private let size: CGFloat = 64

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
    Group {
      if let photo = item.photo {
        AsyncImage(url: photo, transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
          if let image = phase.image {
            image.resizable().scaledToFill()
          } else {
            RasterTile(name: item.art, size: size, radius: 0)
          }
        }
      } else {
        RasterTile(name: item.art, size: size, radius: 0)
      }
    }
    .frame(width: size, height: size)
    .clipShape(shape)
    .overlay(shape.strokeBorder(Color.white.opacity(0.06), lineWidth: BasuMetric.hairline))
    .accessibilityHidden(true)
  }
}
