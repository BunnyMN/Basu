import SwiftUI

/**
 The colours from `src/web/app.css`, in the language the phone speaks.

 The same product in two places has to be the same colour in both, so these
 values are copied from the stylesheet rather than re-picked by eye. They are
 written as dynamic colours instead of a light set and a dark set the code has
 to choose between: the system already knows which one the phone is in, and a
 view that has to ask is a view that will forget.
 */
extension Color {
  static let bg = dynamic(light: 0xE9EBEC, dark: 0x0E1315)

  /// White on an accent fill — the badge count, and nothing else yet.
  static let onAccent = dynamic(light: 0xFFFFFF, dark: 0x160B03)
  static let surface = dynamic(light: 0xFFFFFF, dark: 0x161D20)
  static let surface2 = dynamic(light: 0xF3F5F6, dark: 0x1C2428)
  static let sunk = dynamic(light: 0xDFE3E4, dark: 0x0A0E10)

  static let ink = dynamic(light: 0x14181B, dark: 0xE7ECED)
  static let ink2 = dynamic(light: 0x4A555C, dark: 0xA2B0B6)
  static let ink3 = dynamic(light: 0x78868E, dark: 0x6E7E85)

  static let line = dynamic(light: 0xD2D8DA, dark: 0x283236)
  static let line2 = dynamic(light: 0xC0C8CB, dark: 0x374348)

  static let accent = dynamic(light: 0xC64E08, dark: 0xFF8A3D)
  static let accentInk = dynamic(light: 0xC64E08, dark: 0xFF9B57)
  static let accentSoft = dynamic(light: 0xFAE7DA, dark: 0x33200F)
  static let accentLine = dynamic(light: 0xE9B893, dark: 0x5E3A1B)

  static let route = dynamic(light: 0x1B5B8F, dark: 0x78B0E0)
  static let routeSoft = dynamic(light: 0xDFEAF3, dark: 0x16242F)
  static let routeLine = dynamic(light: 0xA8C6DE, dark: 0x2E4A61)

  static let ready = dynamic(light: 0x136A4B, dark: 0x57C295)
  static let readySoft = dynamic(light: 0xDCEDE6, dark: 0x0F2620)
  static let readyLine = dynamic(light: 0x9CCBB7, dark: 0x1F4A3A)

  static let hold = dynamic(light: 0x7E6113, dark: 0xDAB65A)
  static let holdSoft = dynamic(light: 0xF1E9D2, dark: 0x2A2312)
  static let holdLine = dynamic(light: 0xD9C48A, dark: 0x4E4222)

  static let stop = dynamic(light: 0x9B2226, dark: 0xF08A8D)
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

extension Font {
  /// Numbers, codes and labels — the parts that must line up in a column.
  static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .monospaced)
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
  static var ground: LinearGradient {
    LinearGradient(
      stops: [
        .init(color: .dynamic(light: 0xEFF1F2, dark: 0x141B1E), location: 0),
        .init(color: .dynamic(light: 0xE9EBEC, dark: 0x0E1315), location: 0.46),
        .init(color: .dynamic(light: 0xDFE3E4, dark: 0x0A0E10), location: 1),
      ],
      // 176° in CSS is very nearly straight down, leaning a touch left.
      startPoint: UnitPoint(x: 0.535, y: 0),
      endPoint: UnitPoint(x: 0.465, y: 1),
    )
  }
}

extension View {
  /**
   A card: glass, a hairline, four points of radius.

   The hairline sits *on top* of the blur rather than under it. That is what
   keeps an edge legible when the thing behind the card is the same tone as the
   card — without it a translucent surface dissolves at exactly the moment it
   needs to be a surface.
   */
  func glassCard(radius: CGFloat = 4, stroke: Color = .line) -> some View {
    background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(stroke, lineWidth: 1),
      )
  }

  /// The sunken variant: the search field and the avatar plate.
  func glassWell(radius: CGFloat = 4) -> some View {
    background(.thinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(Color.line, lineWidth: 1),
      )
  }
}

/// The 1pt rule that separates rows inside a list. Always `line`, always 1px.
struct Hairline: View {
  var body: some View {
    Rectangle().fill(Color.line).frame(height: 1)
  }
}
