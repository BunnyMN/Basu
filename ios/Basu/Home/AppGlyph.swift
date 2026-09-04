import BasuKit
import SwiftUI

/**
 The bowl, seen from the side.

 Kept for the dine screens, which had it first. The launcher's food icon is
 now the supplied render — see `AppTile` — and this stays where the food app
 itself wants a mark.
 */
struct BowlGlyph: Shape {
  func path(in rect: CGRect) -> Path {
    // The glyph is described in a 24×24 box, then scaled into whatever it is
    // given — the same viewBox the SVG uses.
    let s = min(rect.width, rect.height) / 24
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + x * s, y: rect.minY + y * s)
    }

    var path = Path()

    // The bowl: a rim, and the round of it underneath.
    path.move(to: p(3.5, 11))
    path.addLine(to: p(20.5, 11))
    path.addCurve(to: p(12, 18.5), control1: p(20.5, 15.4), control2: p(16.7, 18.5))
    path.addCurve(to: p(3.5, 11), control1: p(7.3, 18.5), control2: p(3.5, 15.4))
    path.closeSubpath()

    // The line of the rim, wider than the bowl, the way a bowl looks.
    path.move(to: p(2.5, 11))
    path.addLine(to: p(21.5, 11))

    // Two curls of steam. Without them a bowl from above is a circle.
    path.move(to: p(9, 7.5))
    path.addCurve(to: p(10, 5.1), control1: p(9, 6.5), control2: p(10, 6.1))
    path.addCurve(to: p(9, 3.5), control1: p(10, 4.1), control2: p(9, 3.5))

    path.move(to: p(13.5, 8))
    path.addCurve(to: p(14.7, 5.1), control1: p(13.5, 6.8), control2: p(14.7, 6.3))
    path.addCurve(to: p(13.5, 3.5), control1: p(14.7, 3.9), control2: p(13.5, 3.5))

    return path
  }
}

/**
 One tile on the launcher: the mark, the name, and one word about it.

 The Хоол tile is the supplied render, full-bleed at radius 18 with no inner
 margin and no plate edge. The rest are drawn glyphs on glass, and the tag
 under the tile carries the specificity so the glyph does not have to. If a
 mark needs a second element to say «pre-order», the tag was already doing
 that job — which is rule six of the icon system.
 */
struct AppTile: View {
  let app: LauncherApp
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 6) {
        tile
          .frame(width: BasuMetric.tileMin, height: BasuMetric.tileMin)
          .shadow(color: .tileShadow, radius: 2, y: 1)

        VStack(alignment: .leading, spacing: 2) {
          Text(app.name)
            .font(.sans(13, .semibold))
            .foregroundStyle(Color.ink)
            // Wraps rather than truncates: at larger Dynamic Type a clipped
            // app name is an app somebody cannot find.
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
          Text(app.tag)
            .font(.mono(9.5))
            .foregroundStyle(Color.ink3)
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    // Not `.disabled`: the plain style dims a disabled button, and the design
    // draws every tile at full strength. A tile with nothing behind it simply
    // does nothing when tapped, and says so.
    .accessibilityIdentifier("app.\(app.name)")
    .accessibilityLabel("\(app.name), \(app.tag)")
    .accessibilityHint(app.isLive ? "" : "Удахгүй")
  }

  @ViewBuilder private var tile: some View {
    switch app.icon {
    case .raster:
      FoodTile(size: BasuMetric.tileMin, radius: BasuMetric.iconTile)
    case .glyph(let kind):
      Glyph(kind: kind, size: BasuMetric.glyph)
        .frame(width: BasuMetric.tileMin, height: BasuMetric.tileMin)
        .glassCard(radius: BasuMetric.iconTile)
    }
  }
}
