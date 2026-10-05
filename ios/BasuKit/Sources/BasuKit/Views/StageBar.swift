import SwiftUI

/**
 Status, said the way every Basu screen says it: one word, and four segments
 under it — Төлсөн, Бэлтгэж байна, Бэлэн, then Замд or Хүлээлгэн өгсөн.

 Filled up to the step the order is on: the step being lived now in crimson,
 the ones behind it in the ink, the ones ahead empty. There is never a 37%:
 an order is on a step, not part of the way along one. A cancelled order has
 no meter at all — the word alone says it.
 */
public struct Meter: View {
  /// 1…total. Nought draws an empty meter.
  public let step: Int
  public var total: Int
  public var current: Color
  public var filled: Color
  public var track: Color
  public var height: CGFloat

  public init(
    step: Int,
    total: Int = 4,
    current: Color = BasuColor.accent,
    filled: Color = BasuColor.ink,
    track: Color = BasuColor.surface3,
    height: CGFloat = 4,
  ) {
    self.step = step
    self.total = total
    self.current = current
    self.filled = filled
    self.track = track
    self.height = height
  }

  public var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<total, id: \.self) { index in
        RoundedRectangle(cornerRadius: height / 2, style: .continuous)
          .fill(index < step - 1 ? filled : index == step - 1 ? current : track)
          .frame(height: height)
      }
    }
    .accessibilityHidden(true)
  }
}

/**
 A lunch's three stages on the meter of four: in (waiting on the kitchen),
 on the fire, ready — the fourth, served, is when the activity ends.
 */
public struct StageBar: View {
  public let stage: OrderStage
  public var track: Color

  public init(stage: OrderStage, track: Color = BasuColor.surface3) {
    self.stage = stage
    self.track = track
  }

  public var body: some View {
    Meter(step: stage.index + 1, track: track)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(stage.label)
  }
}

/// The Хоол tile: a supplied render, pre-rounded at 18/92. Full-bleed, no
/// inner margin, no plate border, at whatever size it is asked for.
public struct FoodTile: View {
  public let size: CGFloat
  public var radius: CGFloat

  public init(size: CGFloat, radius: CGFloat? = nil) {
    self.size = size
    self.radius = radius ?? size * 18 / 92
  }

  public var body: some View {
    RasterTile(name: "food-tile", size: size, radius: radius)
  }
}

/**
 A supplied render as an app tile, full-bleed at the tile's radius with no
 inner margin. The food tile was the first; the идэш tile is the second, the
 supplier's ger the third — and any app whose mark is a render rather than a
 drawn glyph is one of these. The pictures themselves are never redrawn.
 */
public struct RasterTile: View {
  public let name: String
  public let size: CGFloat
  public var radius: CGFloat

  public init(name: String, size: CGFloat, radius: CGFloat? = nil) {
    self.name = name
    self.size = size
    self.radius = radius ?? size * 18 / 92
  }

  public var body: some View {
    Image(name, bundle: .module)
      .resizable()
      .interpolation(.high)
      .aspectRatio(contentMode: .fill)
      .frame(width: size, height: size)
      .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
      .accessibilityHidden(true)
  }
}
