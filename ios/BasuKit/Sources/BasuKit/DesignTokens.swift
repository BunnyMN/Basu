//  DesignTokens.swift
//  BasuKit
//
//  Every colour, font and metric the design uses. Nothing outside this file
//  is a legal value. Two themes, authored independently — dark is not an
//  inversion of light.

import SwiftUI

// MARK: - Colour

public extension Color {
    init(light: UInt32, dark: UInt32, opacity: Double = 1) {
        self.init(UIColor { $0.userInterfaceStyle == .dark
            ? UIColor(rgb: dark, alpha: opacity)
            : UIColor(rgb: light, alpha: opacity) })
    }
}

private extension UIColor {
    convenience init(rgb: UInt32, alpha: CGFloat) {
        self.init(red:   CGFloat((rgb >> 16) & 0xFF) / 255,
                  green: CGFloat((rgb >>  8) & 0xFF) / 255,
                  blue:  CGFloat( rgb        & 0xFF) / 255,
                  alpha: alpha)
    }
}

public enum BasuColor {
    // Surfaces. Cards are translucent over an 8pt backdrop blur
    // (.ultraThinMaterial); the 1pt hairline sits on top of the blur and is
    // what keeps edges legible.
    public static let surface      = Color(light: 0xFFFFFF, dark: 0x161D20, opacity: 0.60)
    public static let surface2     = Color(light: 0xF3F5F6, dark: 0x1C2428, opacity: 0.52)

    // Ink
    public static let ink          = Color(light: 0x14181B, dark: 0xE7ECED)
    public static let ink2         = Color(light: 0x4A555C, dark: 0xA2B0B6)
    public static let ink3         = Color(light: 0x78868E, dark: 0x6E7E85)

    // Lines
    public static let line         = Color(light: 0xD2D8DA, dark: 0x283236)
    public static let line2        = Color(light: 0xC0C8CB, dark: 0x374348)

    // The one brand colour
    public static let accent       = Color(light: 0xC64E08, dark: 0xFF8A3D)
    public static let onAccent     = Color(light: 0xFFFFFF, dark: 0x160B03)

    // Semantic
    public static let ready        = Color(light: 0x136A4B, dark: 0x57C295)   // credits
    public static let hold         = Color(light: 0x7E6113, dark: 0xDAB65A)   // waiting
    public static let stop         = Color(light: 0x9B2226, dark: 0xF08A8D)   // sign out, delete
    public static let onStop       = Color(light: 0xFFFFFF, dark: 0x2A0B0C)
    public static let route        = Color(light: 0x1B5B8F, dark: 0x78B0E0)   // in transit

    // Unread wash — a muted blue, deliberately not the accent
    public static let unread       = Color(light: 0xE4EDF5, dark: 0x16232E)

    // Lock screen / Live Activity
    public static let onLock       = Color(white: 1)
    public static let onLock2      = Color(light: 0x9AA6AC, dark: 0x8E9AA0)
    public static let lockCard     = Color(white: 1, opacity: 0.12)
    public static let lockLine     = Color(white: 1, opacity: 0.14)
    public static let lockTrack    = Color(white: 1, opacity: 0.18)

    /// Screen background: a 176° wash, top to bottom. The gradient exists so
    /// translucent surfaces have something to be translucent against.
    public static var ground: LinearGradient {
        LinearGradient(
            stops: [
                .init(color: Color(light: 0xEFF1F2, dark: 0x141B1E), location: 0.00),
                .init(color: Color(light: 0xE9EBEC, dark: 0x0E1315), location: 0.46),
                .init(color: Color(light: 0xDFE3E4, dark: 0x0A0E10), location: 1.00)
            ],
            startPoint: .init(x: 0.03, y: 0), endPoint: .init(x: -0.03, y: 1))
    }
}

// MARK: - Type
//
// Golos Text for prose, JetBrains Mono for every number and every label.
// Numbers always use tabular figures. The ₮ sign is set in the SANS face —
// the mono face has no glyph for it and collides with the last digit.

public enum BasuFont {
    // The bundled faces are the static 400 / 500 / 600 cuts, so a weight is a
    // PostScript name rather than an axis. `.weight()` on a custom font only
    // works with a variable font and otherwise falls back to the system face
    // without saying so — which is exactly the failure nobody notices.
    private static func face(_ weight: Font.Weight) -> String {
        switch weight {
        case .medium: "Medium"
        case .semibold, .bold, .heavy, .black: "SemiBold"
        default: "Regular"
        }
    }
    // Relative to the body style, so every size grows with Dynamic Type and
    // the design's 15 is still 15 at the default setting.
    public static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("GolosText-\(face(weight))", size: size, relativeTo: .body)
    }
    public static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("JetBrainsMono-\(face(weight))", size: size, relativeTo: .body)
    }
    /// The file names `UIAppFonts` has to list, in every target that draws text.
    public static let files = [
        "GolosText-Regular.ttf", "GolosText-Medium.ttf", "GolosText-SemiBold.ttf",
        "JetBrainsMono-Regular.ttf", "JetBrainsMono-Medium.ttf", "JetBrainsMono-SemiBold.ttf",
    ]

    // Titles
    public static let navTitleLarge  = sans(28, .semibold)   // Түрийвч, Профайл, tracking -0.02em
    public static let navTitle       = sans(17, .semibold)   // centred Мэдэгдэл
    public static let splashMark     = sans(44, .semibold)   // Basu, tracking -0.03em
    public static let brand          = sans(27, .semibold)   // launcher Basu, -0.025em
    public static let profileName    = sans(24, .semibold)

    // Numbers
    public static let balance        = mono(48, .semibold)   // -0.02em
    public static let liveTime       = mono(23, .semibold)
    public static let widgetTimeS    = mono(34, .semibold)
    public static let widgetTimeM    = mono(30, .semibold)
    public static let activityTime   = mono(26, .semibold)
    public static let clock          = mono(15, .semibold)
    public static let amount         = mono(15, .semibold)
    public static let badge          = mono(9.5, .semibold)

    // Text
    public static let rowTitle       = sans(15.5, .semibold) // live row, unread notification
    public static let rowTitleRead   = sans(15.5, .regular)
    public static let row            = sans(15, .regular)
    public static let rowValue       = sans(15, .medium)
    public static let navLink        = sans(15, .medium)
    public static let appName        = sans(13, .semibold)
    public static let body           = sans(13, .regular)
    public static let bodyLarge      = sans(14, .regular)
    public static let inlineAction   = sans(13, .medium)
    public static let stage          = sans(12.5, .medium)
    public static let caption        = sans(12, .regular)

    // Mono labels
    public static let meta           = mono(11.5, .regular)
    public static let timestamp      = mono(11, .regular)
    public static let sectionLabel   = mono(10, .medium)     // ТҮРИЙВЧ — tracking 0.16em, uppercase
    public static let sourceLabel    = mono(9.5, .medium)    // ХООЛ — tracking 0.14em
    public static let appTag         = mono(9.5, .regular)
    public static let unitLabel      = mono(9, .medium)      // СУУХ — tracking 0.14em
    public static let channelChip    = mono(9, .medium)      // SMS — tracking 0.12em
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
    // Radii
    public static let card: CGFloat        = 12
    public static let iconTile: CGFloat    = 18
    public static let widget: CGFloat      = 24
    public static let activityCard: CGFloat = 22
    public static let islandCompact: CGFloat = 19
    public static let islandExpanded: CGFloat = 40
    public static let badge: CGFloat       = 8
    public static let switchTrack: CGFloat = 16
    public static let chip: CGFloat        = 2
    public static let avatarPlate: CGFloat = 0.28   // 28% of the plate's side

    // Layout
    public static let screenPadding: CGFloat = 20
    public static let statusBar: CGFloat     = 54
    public static let tabBar: CGFloat        = 66
    public static let tabBarInset: CGFloat   = 74   // bottom content inset
    public static let tabGlyph: CGFloat      = 25
    public static let hairline: CGFloat      = 1
    public static let minTarget: CGFloat     = 44

    // Grid
    public static let tileMin: CGFloat       = 92
    public static let gridGapX: CGFloat      = 14
    public static let gridGapY: CGFloat      = 10
    public static let glyph: CGFloat         = 34

    // Components
    public static let bell: CGFloat          = 26
    public static let badgeHeight: CGFloat   = 15
    public static let avatarLauncher: CGFloat = 30
    public static let avatarProfile: CGFloat  = 54
    public static let switchSize            = CGSize(width: 51, height: 31)
    public static let swipeAction: CGFloat   = 88
    public static let searchThreshold        = 7   // services before the filter field appears

    // Material
    public static let blur: CGFloat          = 8
    public static let lockBlur: CGFloat      = 18
    public static let shadow                 = (y: CGFloat(1), radius: CGFloat(2))
}
