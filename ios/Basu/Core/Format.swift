import SwiftUI

/**
 Money and time, said the way Ulaanbaatar says them.

 The clock is pinned to Asia/Ulaanbaatar rather than to the phone's zone: a
 fire time is a fact about a kitchen, and a guest whose phone is still on last
 week's holiday timezone must not be shown a different one.
 */
enum Format {
  private static let tugrik: NumberFormatter = {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.locale = Locale(identifier: "mn_MN")
    f.maximumFractionDigits = 0
    return f
  }()

  private static let clock: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_GB")
    f.timeZone = TimeZone(identifier: "Asia/Ulaanbaatar")
    f.dateFormat = "HH:mm"
    return f
  }()

  static func mnt(_ value: Int) -> String {
    "\(grouped(value))₮"
  }

  /// Just the digits, grouped. The ₮ is set separately — see `mntText`.
  static func grouped(_ value: Int) -> String {
    tugrik.string(from: NSNumber(value: value)) ?? "\(value)"
  }

  static func hhmm(_ date: Date?) -> String {
    guard let date else { return "—" }
    return clock.string(from: date)
  }

  /**
   Money, set the way the design asks: mono digits, sans tugrik.

   SF Mono has no ₮, so a monospaced amount falls back mid-string and the sign
   collides with the last digit. Setting it in the sans face fixes both, and the
   hair spaces put back the sliver of air the fallback used to provide.
   */
  static func mntText(_ value: Int, size: CGFloat, weight: Font.Weight = .semibold) -> Text {
    signedText(grouped(value), size: size, weight: weight)
  }

  /// The same, for an already-signed string such as `+50,000` or `−18,500`.
  static func signedText(_ digits: String, size: CGFloat, weight: Font.Weight = .semibold) -> Text {
    Text(digits).font(.mono(size, weight)).monospacedDigit()
      + Text("\u{200A}\u{200A}₮").font(.sans(size, weight))
  }

  /// Signed money as a plain string: `+50 000₮` / `−18 500₮`.
  ///
  /// A real minus sign rather than a hyphen, because the two sit at different
  /// heights and a column of amounts is read down, not across.
  static func signedMnt(_ value: Int) -> String {
    value < 0 ? "−\(mnt(-value))" : "+\(mnt(value))"
  }

  private static let day: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "mn_MN")
    f.timeZone = TimeZone(identifier: "Asia/Ulaanbaatar")
    f.dateFormat = "M/d"
    return f
  }()

  private static let month: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "mn_MN")
    f.timeZone = TimeZone(identifier: "Asia/Ulaanbaatar")
    f.dateFormat = "yyyy 'оны' M'-р сараас'"
    return f
  }()

  /// When something started, at the precision that kind of fact has. Nobody
  /// joined Basu at 11:47 — they joined in a month. Carries its own case
  /// ending, because «9-р сар-аас» is not Mongolian.
  static func since(_ date: Date) -> String { month.string(from: date) }

  /// `11/03` — a day, at the size a card corner allows.
  static func day(_ date: Date) -> String { day.string(from: date) }

  /// The time if it happened today, the date if it did not. What a list of
  /// things that happened needs, and nothing more.
  static func when(_ date: Date) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Ulaanbaatar") ?? .current
    return calendar.isDateInToday(date) ? hhmm(date) : day.string(from: date)
  }
}
