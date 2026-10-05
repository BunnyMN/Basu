import Foundation

/// The clock the widgets and the activity share with the app: `HH:mm`,
/// Ulaanbaatar's, whatever zone the phone is on. A fire time is a fact about
/// a kitchen.
public enum BasuFormat {
  private static let clock: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_GB")
    f.timeZone = TimeZone(identifier: "Asia/Ulaanbaatar")
    f.dateFormat = "HH:mm"
    return f
  }()

  public static func hhmm(_ date: Date?) -> String {
    guard let date else { return "—" }
    return clock.string(from: date)
  }

  /// Today, in Ulaanbaatar, as the server writes a day: `YYYY-MM-DD`.
  public static func today(_ now: Date = Date()) -> String {
    day.string(from: now)
  }

  /// A `YYYY-MM-DD` day the way it is said: «Өнөөдөр», «Маргааш»,
  /// «Өчигдөр», or «10-р сарын 7».
  public static func dayWord(_ value: String, now: Date = Date()) -> String {
    guard let date = day.date(from: value) else { return value }
    let calendar = ulaanbaatar
    let today = calendar.startOfDay(for: now)
    let days = calendar.dateComponents([.day], from: today, to: calendar.startOfDay(for: date)).day ?? 0
    switch days {
    case 0: return "Өнөөдөр"
    case 1: return "Маргааш"
    case -1: return "Өчигдөр"
    default:
      let parts = calendar.dateComponents([.month, .day], from: date)
      return "\(parts.month ?? 0)-р сарын \(parts.day ?? 0)"
    }
  }

  private static let ulaanbaatar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Ulaanbaatar")!
    return calendar
  }()

  private static let day: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "Asia/Ulaanbaatar")
    f.calendar = Calendar(identifier: .gregorian)
    f.dateFormat = "yyyy-MM-dd"
    return f
  }()

  /// The badge: the exact count to 99, then `99+`.
  public static func badge(_ count: Int) -> String {
    count > 99 ? "99+" : "\(count)"
  }

  /// Grouped by thousands with a comma: «15,000». The ₮ follows in the same
  /// run — both faces have the glyph.
  public static func grouped(_ value: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.groupingSeparator = ","
    f.maximumFractionDigits = 0
    return f.string(from: NSNumber(value: value)) ?? "\(value)"
  }
}
