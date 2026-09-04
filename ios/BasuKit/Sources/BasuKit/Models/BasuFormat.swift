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

  /// The badge: the exact count to 99, then `99+`.
  public static func badge(_ count: Int) -> String {
    count > 99 ? "99+" : "\(count)"
  }

  /// Grouped by thousands with a comma. The ₮ is set separately, in the sans
  /// face — the mono face has no glyph for it.
  public static func grouped(_ value: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.groupingSeparator = ","
    f.maximumFractionDigits = 0
    return f.string(from: NSNumber(value: value)) ?? "\(value)"
  }
}
