import BasuKit
import SwiftUI

/**
 The design's tokens, in the names the app has always used.

 Every value here comes from `BasuKit/DesignTokens.swift` — nothing is picked by
 eye and nothing is invented. The shell only uses what is there. The apps
 inside it are web pages and bring their own CSS; none of their colours are
 here.
 */
extension Color {
  static let bg = BasuColor.ground
  static let onAccent = BasuColor.onAccent
  static let surface = BasuColor.surface
  static let surface2 = BasuColor.surface2
  static let sunk = dynamic(light: 0xDFE3E4, dark: 0x0A0E10)
  /// The ground's first stop. A fixed title sits on this so the seam with the
  /// gradient underneath is invisible where they meet.
  static let groundTop = dynamic(light: 0xEFF1F2, dark: 0x141B1E)

  static let ink = BasuColor.ink
  static let ink2 = BasuColor.ink2
  static let ink3 = BasuColor.ink3

  static let line = BasuColor.line
  static let line2 = BasuColor.line2

  static let accent = BasuColor.accent
  static let accentInk = BasuColor.accent
  static let unread = BasuColor.unread
  /// `--ground2` in the prototype: the flat ground a read row takes while its
  /// Устгах is showing, so it has something to slide over.
  static let swipeGround = dynamic(light: 0xEAECED, dark: 0x0F1417)

  static let route = BasuColor.route
  static let ready = BasuColor.ready
  static let hold = BasuColor.hold
  static let stop = BasuColor.stop
  static let onStop = BasuColor.onStop

  // ── washes ─────────────────────────────────────────────────────────
  // Behind a banner or a destructive button. The food app's own state
  // colours are not here: that app is a web page and carries its own CSS.
  static let holdSoft = dynamic(light: 0xF1E9D2, dark: 0x2A2312)
  static let holdLine = dynamic(light: 0xD9C48A, dark: 0x4E4222)
  static let stopSoft = dynamic(light: 0xF7DEDE, dark: 0x2E1416)
  static let stopLine = dynamic(light: 0xE0A9A9, dark: 0x5A2A2C)

  /// The shadow under an icon tile. Barely there by design: one point down,
  /// two of blur, and it is the only shadow in the shell.
  static var tileShadow: Color {
    Color(uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(white: 0, alpha: 0.4)
        : UIColor(red: 20 / 255, green: 24 / 255, blue: 27 / 255, alpha: 0.05)
    })
  }

  static func dynamic(light: UInt32, dark: UInt32) -> Color {
    Color(uiColor: UIColor { traits in
      UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
    })
  }

  init(rgb: UInt32) { self.init(uiColor: UIColor(rgb: rgb)) }
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
 Golos Text for prose, JetBrains Mono for every number and every label.

 Two faces, three weights, and no `.system` anywhere in the shell. Numbers are
 always mono with tabular figures; the ₮ is set in the sans face because the
 mono one has no glyph for it and collides with the last digit.
 */
extension Font {
  static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    BasuFont.sans(size, weight)
  }

  /// Numbers, codes and labels — the parts that must line up in a column.
  static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    BasuFont.mono(size, weight)
  }
}

/**
 The ground, and the glass that sits on it.

 Surfaces in the shell are translucent — `.ultraThinMaterial` over a background
 that is not flat. The wash is 176°, three stops, and it exists for exactly one
 reason: translucency needs something to be translucent against. On a single
 flat colour the material has nothing to pick up and reads as dirty grey.
 */
extension ShapeStyle where Self == LinearGradient {
  static var ground: LinearGradient { BasuColor.ground }
}

extension View {
  /**
   A card: glass, a hairline, twelve points of radius.

   The hairline sits *on top* of the blur rather than under it. That is what
   keeps an edge legible when the thing behind the card is the same tone as the
   card — without it a translucent surface dissolves at exactly the moment it
   needs to be a surface.
   */
  func glassCard(radius: CGFloat = BasuMetric.card, stroke: Color = .line) -> some View {
    background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(stroke, lineWidth: BasuMetric.hairline),
      )
  }

  /// The sunken variant: the search field and the avatar plate.
  func glassWell(radius: CGFloat = BasuMetric.card) -> some View {
    background(.thinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(Color.line, lineWidth: BasuMetric.hairline),
      )
  }
}

/// The 1pt rule that separates rows inside a list. Always `line`, always 1px.
struct Hairline: View {
  var body: some View {
    Rectangle().fill(Color.line).frame(height: BasuMetric.hairline)
  }
}
