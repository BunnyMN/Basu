import BasuKit
import SwiftUI

/**
 The design's tokens, in the names the app uses.

 Every value here comes from `BasuKit/DesignTokens.swift` — nothing is picked by
 eye and nothing is invented. The shell only uses what is there. The apps
 inside it are web pages and bring their own CSS; none of their colours are
 here.

 «Тансаг хар»: the app is dark whatever the phone says, so a token is one
 colour. Crimson is the customer's one primary action on a screen; gold is a
 hairline, a step number or a tiny label; there is no green, no yellow and no
 orange anywhere.
 */
extension Color {
  // ── the ground and what stands on it ─────────────────────────────────
  static let bg = BasuColor.bg
  static let surface = BasuColor.surface
  static let surface2 = BasuColor.surface2
  static let surface3 = BasuColor.surface3
  /// The deepest band: a well inside a card, the plate under an avatar.
  static let sunk = BasuColor.deep

  // ── lines ─────────────────────────────────────────────────────────────
  static let line = BasuColor.line
  static let line2 = BasuColor.line2

  // ── ink ───────────────────────────────────────────────────────────────
  static let ink = BasuColor.ink
  static let ink2 = BasuColor.ink2
  static let ink3 = BasuColor.ink3
  static let onLight = BasuColor.onLight

  // ── crimson and gold ─────────────────────────────────────────────────
  /// The fill of the one primary action, a dot that something is unread.
  static let accent = BasuColor.accent
  static let accentPress = BasuColor.accentPress
  /// Crimson as text: errors, late, cancel and delete.
  static let accentInk = BasuColor.accentInk
  static let onAccent = BasuColor.onAccent
  static let gold = BasuColor.gold
  static let goldLine = BasuColor.goldLine
  /// The 2pt ring around whatever is being typed in.
  static let focus = BasuColor.focus

  // ── what a state means (DARK.md: no green, no orange, no yellow) ──────
  /// Done or good: the ink, with a check beside it.
  static let ready = BasuColor.ink
  /// Waiting on the person: gold.
  static let hold = BasuColor.gold
  /// Stop, error, delete: crimson text.
  static let stop = BasuColor.accentInk
  /// Words on a crimson fill.
  static let onStop = BasuColor.onAccent

  // ── washes, behind a banner or a refusal ─────────────────────────────
  static let holdSoft = BasuColor.surface
  static let holdLine = BasuColor.line2
  static let stopSoft = BasuColor.surface
  static let stopLine = BasuColor.accentInk.opacity(0.45)

  /// The shadow under a card or a tile: deep, low and soft.
  static let tileShadow = Color.black.opacity(0.55)
  /// Under the floating tab bar.
  static let barShadow = Color.black.opacity(0.8)
}

extension UIColor {
  convenience init(rgb: UInt32) {
    self.init(
      red: CGFloat((rgb >> 16) & 0xFF) / 255,
      green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255,
      alpha: 1,
    )
  }

  /// The `#RRGGBB` strings the dish table is served in. An unreadable colour
  /// falls back to grey rather than to a crash: a menu with one odd-coloured
  /// bowl still sells lunch.
  convenience init(hex: String) {
    var value: UInt64 = 0
    Scanner(string: hex.hasPrefix("#") ? String(hex.dropFirst()) : hex).scanHexInt64(&value)
    self.init(rgb: value == 0 ? 0x9AA3A8 : UInt32(truncatingIfNeeded: value))
  }
}

/**
 Manrope for words, Noto Sans Display Condensed for what is big or counted.

 Two families and no `.system` anywhere in the shell. Money, times, days and
 order codes are the display face with tabular figures — it has the ₮ and the
 №, so an amount is one run of type rather than two faces stitched together.
 */
extension Font {
  static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    BasuFont.sans(size, weight)
  }

  /// Headings, money, times, days and codes: 800 by default, 700 for the
  /// smaller headings.
  static func display(_ size: CGFloat, _ weight: Font.Weight = .heavy) -> Font {
    BasuFont.display(size, weight)
  }
}

extension ShapeStyle where Self == LinearGradient {
  /// The ground, where a shape style is wanted.
  static var ground: LinearGradient { BasuColor.ground }
}

extension View {
  /**
   A card: the surface, a hairline, twenty-two points of radius, and the
   shadow that lifts it off the ground — with a breath of light along its top
   edge, the way a lacquered thing catches the room.
   */
  func card<Fill: ShapeStyle>(
    radius: CGFloat = BasuMetric.card,
    fill: Fill = Color.surface,
    stroke: Color = .line,
  ) -> some View {
    let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
    return background {
      shape
        .fill(fill)
        .shadow(color: .tileShadow, radius: 20, y: 16)
    }
    .overlay(shape.strokeBorder(stroke, lineWidth: BasuMetric.hairline))
    .overlay(alignment: .top) {
      // `inset 0 1px 0 rgba(255,244,236,.05)`
      shape
        .strokeBorder(Color(hex: 0xFFF4EC, opacity: 0.05), lineWidth: BasuMetric.hairline)
        .mask(LinearGradient(colors: [.white, .clear], startPoint: .top, endPoint: .init(x: 0.5, y: 0.12)))
        .allowsHitTesting(false)
    }
  }

  /// The sunken variant: a well inside a card.
  func well(radius: CGFloat = BasuMetric.inner) -> some View {
    background(Color.sunk, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(Color.line, lineWidth: BasuMetric.hairline),
      )
  }

  /**
   Glass: a chip on a photograph, the way back over a page. Charcoal over a
   blur, with a white hairline at twelve per cent so the edge holds on
   anything.
   */
  func glass<S: InsettableShape>(in shape: S) -> some View {
    background {
      ZStack {
        shape.fill(.ultraThinMaterial)
        shape.fill(BasuColor.glass)
      }
    }
    .overlay(shape.strokeBorder(BasuColor.glassEdge, lineWidth: BasuMetric.hairline))
  }

  /// `--glow`: the crimson button's own light, and nothing else's.
  func glow(_ on: Bool = true) -> some View {
    shadow(color: Color.accent.opacity(on ? 0.55 : 0), radius: 16, y: 12)
  }
}

/// The 1pt rule that separates rows inside a list. Always `line`, always 1px.
struct Hairline: View {
  var body: some View {
    Rectangle().fill(Color.line).frame(height: BasuMetric.hairline)
  }
}
