import SwiftUI

/**
 Three equal 3pt bars, gap 4, radius 2 — filled up to the current stage.

 Three segments because the order has three states, and no more. The bar can
 never show 37% because there is no such thing as 37% of a lunch.
 */
public struct StageBar: View {
  public let stage: OrderStage
  public var track: Color

  public init(stage: OrderStage, track: Color) {
    self.stage = stage
    self.track = track
  }

  public var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<3, id: \.self) { i in
        RoundedRectangle(cornerRadius: 2, style: .continuous)
          .fill(i <= stage.index ? BasuColor.accent : track)
          .frame(height: 3)
      }
    }
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
 inner margin. The food tile was the first; the идэш tile is the second, and
 any app whose mark is a render rather than a drawn glyph is one of these.
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
