import Foundation

/**
 What is inside Basu, and which band it sits in.

 Band membership is product configuration, not user state. That is the whole
 rule: **no folders and no most-recently-used reordering**. A grid that
 rearranges itself under the thumb cannot be learned, and recency already has a
 home one section higher, in ИДЭВХТЭЙ.

 An app is a web page. The shell is native — launcher, wallet, inbox, profile,
 the lock screen — and every icon opens a page from the same server the shell
 talks to, inside `ServiceView`, signed in as the shell's guest. Adding the
 second app is one entry here with its path. Nothing in the launcher, the
 wallet, the inbox or the profile changes, and nothing native is written.
 */
struct LauncherApp: Identifiable, Hashable, Sendable {
  let id: String
  let name: String
  /// One lower-case word. It carries the specificity the glyph must not.
  let tag: String
  let icon: ServiceIcon
  /// Where the page lives on the server — `/dine`. `nil` is an icon that is
  /// drawn but not built, so the grid can be seen at the size it will be.
  let path: String?

  /// The page, as the shell opens it.
  var destination: Destination? {
    path.map { .app(id: id, path: $0) }
  }

  /// The page, opened on one thing the guest already has — `/dine?order=…`.
  /// The launcher's ИДЭВХТЭЙ row, the inbox and the lock screen all land here.
  func destination(order id: String) -> Destination? {
    path.map { .app(id: self.id, path: "\($0)?order=\(id)") }
  }

  /// The glyph, for the tiles that are drawn. The food tile is a render and
  /// has none.
  var glyph: GlyphKind? {
    if case .glyph(let kind) = icon { return kind }
    return nil
  }

  var isLive: Bool { destination != nil }
}

/// A supplied render, or a mark drawn to the icon system's rules.
enum ServiceIcon: Hashable, Sendable {
  case raster(String)
  case glyph(GlyphKind)
}

struct AppBand: Identifiable, Hashable, Sendable {
  let id: String
  let label: String
  let apps: [LauncherApp]
}

enum AppCatalogue {
  static let food = LauncherApp(
    id: "food", name: "Хоол", tag: "урьдчилсан", icon: .raster("food-tile"), path: "/dine",
  )

  /// Drawn, named, and not built. They exist here so the grid can be seen at
  /// the sizes it will really be — see `bands(count:)`.
  static let planned: [LauncherApp] = [
    .init(id: "taxi", name: "Такси", tag: "дуудлага", icon: .glyph(.taxi), path: nil),
    .init(id: "delivery", name: "Хүргэлт", tag: "30 минут", icon: .glyph(.delivery), path: nil),
    .init(id: "ticket", name: "Тасалбар", tag: "театр, кино", icon: .glyph(.ticket), path: nil),
    .init(id: "bill", name: "Төлбөр", tag: "нэхэмжлэх", icon: .glyph(.bill), path: nil),
    .init(id: "shop", name: "Дэлгүүр", tag: "ойрхон", icon: .glyph(.shop), path: nil),
    .init(id: "net", name: "Интернэт", tag: "дата", icon: .glyph(.net), path: nil),
    .init(id: "pharmacy", name: "Эмийн сан", tag: "24 цаг", icon: .glyph(.pharmacy), path: nil),
    .init(id: "cafe", name: "Кофе", tag: "авч явах", icon: .glyph(.cafe), path: nil),
  ]

  /// The line under the grid while there is one icon. A hairline and a
  /// sentence — never an empty placeholder tile, which promises a tap that
  /// does nothing.
  static let comingSoon = "Такси, хүргэлт, тасалбар — 2026 оны төгсгөлд"

  /// A filter appears at seven icons and is hidden below that. Under seven it
  /// is slower than looking.
  static let searchThreshold = 7

  /**
   The bands, for a given number of icons.

   One and four share a single `АППУУД` band; nine splits into the two
   editorial bands the design fixes. The counts other than one exist for the
   launch argument below — shipping today is one icon.
   */
  static func bands(count: Int) -> [AppBand] {
    let all = [food] + planned
    let apps = Array(all.prefix(max(1, count)))

    if apps.count < 9 {
      return [AppBand(id: "all", label: "АППУУД", apps: apps)]
    }
    return [
      AppBand(id: "daily", label: "ӨДӨР ТУТАМ", apps: Array(apps.prefix(3))),
      AppBand(id: "rest", label: "БУСАД", apps: Array(apps.dropFirst(3))),
    ]
  }

  /**
   How many icons to draw.

   One in anything shipped. A debug build reads `BASU_APPS` so the four- and
   nine-icon states the design specifies can be looked at on a real device
   rather than only in the artboards — a grid that was never seen full is a
   grid nobody has checked.
   */
  static var installedCount: Int {
    #if DEBUG
      if let raw = ProcessInfo.processInfo.environment["BASU_APPS"], let n = Int(raw) {
        return min(max(n, 1), 9)
      }
    #endif
    return 1
  }
}
