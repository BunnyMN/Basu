import SwiftUI

/**
 The bowl on the first icon: the whole product in one glyph.

 Drawn rather than shipped as an asset, and drawn from the same coordinates as
 the web launcher's SVG, so the two home screens carry the same mark. A bowl
 read from above is recognisable at the size an icon gets; a three-quarter view
 of the same bowl is a smudge.
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

/// One tile on the launcher: the glyph, the name, and one word about it.
struct AppTile: View {
  let name: String
  let tag: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 7) {
        BowlGlyph()
          .stroke(Color.accent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
          .padding(19)
          .frame(width: 92, height: 92)
          .background(Color.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.line, lineWidth: 1),
          )
          .shadow(color: .black.opacity(0.06), radius: 8, y: 3)

        Text(name)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Color.ink)
        Text(tag)
          .font(.mono(9.5))
          .foregroundStyle(Color.ink3)
      }
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("app.\(name)")
  }
}
