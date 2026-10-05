//  DesignTokens.swift
//  BasuKit
//
//  Every colour, font and metric the design uses. Nothing outside this file
//  is a legal value.
//
//  «Тансаг хар» (2026-10-05): one theme, and it is dark. Basu is dark on
//  every surface whatever the phone's own setting, so each token is one
//  value rather than a light and a dark — the same tokens as the web's
//  app.css (`--bg`, `--surface`, `--ink`, `--accent`, `--gold`…), with the
//  same hex.

import SwiftUI

// MARK: - Colour

public extension Color {
  /// `0xRRGGBB` in sRGB, at an opacity.
  init(hex: UInt32, opacity: Double = 1) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: opacity,
    )
  }
}

public enum BasuColor {
  // ── the ground and what stands on it: warm charcoal, never #000 ──────
  /// `--bg`: the ground of every screen.
  public static let bg = Color(hex: 0x100D0C)
  /// `--surface`: cards, rows, inputs.
  public static let surface = Color(hex: 0x1C1716)
  /// `--surface-2`: sheets, the chosen row, raised panels.
  public static let surface2 = Color(hex: 0x251F1D)
  /// `--surface-3`: stepper buttons, the meter's empty segment, a pressed row.
  public static let surface3 = Color(hex: 0x2F2826)
  /// `--deep`: the deepest band — under a well, behind the lock.
  public static let deep = Color(hex: 0x0C0A09)

  // ── lines ─────────────────────────────────────────────────────────────
  /// `--line`: row and card lines.
  public static let line = Color(hex: 0x2E2725)
  /// `--line-2`: outlined buttons and inputs.
  public static let line2 = Color(hex: 0x3E3532)

  // ── ink ───────────────────────────────────────────────────────────────
  public static let ink = Color(hex: 0xF6F0E8)
  public static let ink2 = Color(hex: 0xC4BAB0)
  /// Labels and dates: 6.0:1 on the ground, 5.5:1 on a card.
  public static let ink3 = Color(hex: 0x998E85)
  /// Text on an off-white button or pill.
  public static let onLight = Color(hex: 0x140F0E)

  // ── crimson: the customer's one primary action per screen ────────────
  public static let accent = Color(hex: 0xD21F3C)
  public static let accentPress = Color(hex: 0xB5172F)
  /// Crimson as text on the dark: an error, something late, a cancel or a
  /// delete. Never a link that only goes somewhere.
  public static let accentInk = Color(hex: 0xF2566B)
  /// White on crimson, 5.3:1.
  public static let onAccent = Color(hex: 0xFFFFFF)

  // ── gold: hairlines, step numbers, tiny labels like «АВАХ» ───────────
  /// Also what is waiting on the person.
  public static let gold = Color(hex: 0xC9A96E)
  public static let goldLine = Color(hex: 0xC9A96E, opacity: 0.5)

  /// The 2pt focus ring.
  public static let focus = ink

  // ── glass: the tab bar, a chip on a photo, the way back ─────────────
  /// Over a blur; a 1pt `glassEdge` keeps its edge.
  public static let glass = Color(hex: 0x100D0C, opacity: 0.62)
  public static let glassEdge = Color(white: 1, opacity: 0.12)
  /// The tab bar's own glass: nearly solid, so the pill on it reads.
  public static let bar = Color(hex: 0x201A19, opacity: 0.92)
  public static let barEdge = Color(hex: 0xFFF4EC, opacity: 0.08)

  // ── the lock screen, the island and the widgets ──────────────────────
  public static let onLock = ink
  public static let onLock2 = ink3
  /// The Live Activity's ground on the lock screen: the app's own charcoal.
  public static let lockCard = Color(hex: 0x100D0C, opacity: 0.9)
  public static let lockLine = line
  /// The meter's empty segment, on the lock screen and in the island.
  public static let lockTrack = surface3

  /// The app's ground as a gradient, for the places that take a shape
  /// style. Flat: the old wash existed for translucent cards, and the cards
  /// are solid now.
  public static var ground: LinearGradient {
    LinearGradient(colors: [bg, bg], startPoint: .top, endPoint: .bottom)
  }
}

// MARK: - Type
//
// Manrope for every word; Noto Sans Display Condensed for what is big or
// counted — headings, money, times, days, order codes. Both carry Ө ө Ү ү,
// ₮ and №, so nothing falls back mid-word, and both have tabular figures.

public enum BasuFont {
  // The bundled faces are static cuts, so a weight is a PostScript name
  // rather than an axis. `.weight()` on a custom font only works with a
  // variable font and otherwise falls back to the system face without
  // saying so — which is exactly the failure nobody notices.
  private static func sansFace(_ weight: Font.Weight) -> String {
    switch weight {
    case .medium: "Manrope-Medium"
    case .semibold: "Manrope-SemiBold"
    case .bold, .heavy, .black: "Manrope-Bold"
    default: "Manrope-Regular"
    }
  }

  private static func displayFace(_ weight: Font.Weight) -> String {
    switch weight {
    case .heavy, .black: "NotoSansDisplay-CondensedExtraBold"
    default: "NotoSansDisplay-CondensedBold"
    }
  }

  /// Words. Relative to the body style, so every size grows with Dynamic
  /// Type and the design's 15 is still 15 at the default setting.
  public static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .custom(sansFace(weight), size: size, relativeTo: .body)
  }

  /// The condensed display face: 800 (`.heavy`, the default) for headings,
  /// money, times and codes; 700 (`.bold`) for the smaller headings.
  public static func display(_ size: CGFloat, _ weight: Font.Weight = .heavy) -> Font {
    .custom(displayFace(weight), size: size, relativeTo: .body)
  }

  /// The file names `UIAppFonts` has to list, in every target that draws text.
  public static let files = [
    "Manrope-Regular.ttf", "Manrope-Medium.ttf", "Manrope-SemiBold.ttf", "Manrope-Bold.ttf",
    "NotoSansDisplay-CondensedBold.ttf", "NotoSansDisplay-CondensedExtraBold.ttf",
  ]
}

public extension Text {
  /// Numbers never jitter as they change.
  func tabular() -> Text { self.monospacedDigit() }
}

public extension View {
  /// Tracking in ems, the way the design specifies it.
  func tracking(em: CGFloat, size: CGFloat) -> some View { self.tracking(em * size) }
}

// MARK: - Metrics

public enum BasuMetric {
  // Radii: 8 · 12 menu rows · 16 chips and inner boxes · 22 cards and
  // photos · 28 tiles and sheets · a capsule for buttons, filters and the bar.
  public static let small: CGFloat       = 8
  public static let row: CGFloat         = 12
  public static let inner: CGFloat       = 16
  public static let card: CGFloat        = 22
  public static let tile: CGFloat        = 28
  /// A small tile's art in its porcelain square.
  public static let iconTile: CGFloat    = 18
  /// The big tile's art.
  public static let iconTileLarge: CGFloat = 30
  public static let widget: CGFloat      = 24
  public static let activityCard: CGFloat = 22
  public static let islandCompact: CGFloat = 19
  public static let islandExpanded: CGFloat = 40
  public static let badge: CGFloat       = 8
  public static let switchTrack: CGFloat = 16
  /// A banner or a box of money: the card's corner.
  public static let button: CGFloat      = 22
  public static let chip: CGFloat        = 8
  public static let avatarPlate: CGFloat = 0.28   // 28% of the plate's side

  // Layout
  public static let screenPadding: CGFloat = 20
  public static let statusBar: CGFloat     = 54
  /// Bottom content inset, clear of the floating bar (68 tall, 30 up).
  public static let tabBarInset: CGFloat   = 124
  public static let hairline: CGFloat      = 1
  public static let minTarget: CGFloat     = 44

  // Grid
  public static let tileMin: CGFloat       = 92
  public static let gridGapX: CGFloat      = 12
  public static let gridGapY: CGFloat      = 12
  public static let glyph: CGFloat         = 34

  // Components
  public static let bell: CGFloat          = 22
  public static let badgeHeight: CGFloat   = 15
  public static let avatarLauncher: CGFloat = 30
  public static let avatarProfile: CGFloat  = 56
  public static let switchSize            = CGSize(width: 51, height: 31)
  /// A field: one height and one corner everywhere a thing is typed.
  public static let control: CGFloat       = 16
  public static let controlHeight: CGFloat = 52
  /// The one primary button of a screen: a crimson capsule this tall.
  public static let buttonHeight: CGFloat  = 56
  public static let authCard: CGFloat      = 28
  public static let authPhoto: CGFloat     = 240
  public static let swipeAction: CGFloat   = 88
  public static let searchThreshold        = 7   // services before the filter field appears

  // Material
  public static let blur: CGFloat          = 16
  public static let lockBlur: CGFloat      = 18
  public static let shadow                 = (y: CGFloat(18), radius: CGFloat(20))
}
