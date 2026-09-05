import BasuKit
import SwiftUI

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
