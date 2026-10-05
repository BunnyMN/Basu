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
   Money, set the way the design asks: the display face, tabular, the ₮ in
   the same run — «15,000₮». Noto Sans Display has the sign, so nothing
   falls back to another face and nothing collides with the last digit.
   */
  static func mntText(_ value: Int, size: CGFloat, weight: Font.Weight = .heavy) -> Text {
    signedText(grouped(value), size: size, weight: weight)
  }

  /// The same, for an already-signed string such as `+50,000` or `−18,500`.
  static func signedText(_ digits: String, size: CGFloat, weight: Font.Weight = .heavy) -> Text {
    Text("\(digits)₮").font(.display(size, weight)).monospacedDigit()
  }

  /// «Мягмар»: the day of the week, in Ulaanbaatar.
  static func weekday(_ date: Date) -> String {
    let names = ["Ням", "Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба"]
    let index = calendar.component(.weekday, from: date) - 1
    return names[max(0, min(names.count - 1, index))]
  }

  /// The launcher's hello, by Ulaanbaatar's clock: «Өглөөний мэнд» until
  /// eleven, «Өдрийн мэнд» until five, «Оройн мэнд» after.
  static func greeting(at date: Date) -> String {
    switch calendar.component(.hour, from: date) {
    case 4..<11: "Өглөөний мэнд"
    case 11..<17: "Өдрийн мэнд"
    default: "Оройн мэнд"
    }
  }

  /// Signed money as a plain string: `+50 000₮` / `−18 500₮`.
  ///
  /// A real minus sign rather than a hyphen, because the two sit at different
  /// heights and a column of amounts is read down, not across.
  static func signedMnt(_ value: Int) -> String {
    value < 0 ? "−\(mnt(-value))" : "+\(mnt(value))"
  }

  /// Month, then day: the web's own `dayShort`, so a corner reads the same in
  /// the app and on its pages. A dot instead («10.03») reads as 10 March.
  private static let day: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "Asia/Ulaanbaatar")
    f.dateFormat = "M/d"
    return f
  }()

  private static var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Ulaanbaatar") ?? .current
    return calendar
  }

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

  /// `11/3` — a day, at the size a card corner allows.
  static func day(_ date: Date) -> String { day.string(from: date) }

  /// `2026 оны 10-р сарын 1` — the whole date, for a receipt and anything
  /// kept: the website's own way of writing one.
  static func date(_ date: Date) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return "\(parts.year ?? 0) оны \(parts.month ?? 0)-р сарын \(parts.day ?? 0)"
  }

  /// `10-р сарын 3` — a day in a sentence, the way a message says it (the
  /// web's `dayLabel`).
  static func dayWords(_ date: Date) -> String {
    let parts = calendar.dateComponents([.month, .day], from: date)
    return "\(parts.month ?? 0)-р сарын \(parts.day ?? 0)"
  }

  /// When a device was last seen, the way somebody would say it: «саяхан»,
  /// «өнөөдөр 11:40», «өчигдөр 18:05», or the day.
  static func seen(_ date: Date, now: Date = .now) -> String {
    if now.timeIntervalSince(date) < 5 * 60 { return "саяхан" }
    if calendar.isDate(date, inSameDayAs: now) { return "өнөөдөр \(hhmm(date))" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
       calendar.isDate(date, inSameDayAs: yesterday) { return "өчигдөр \(hhmm(date))" }
    return day.string(from: date)
  }

  /// The time if it happened today, the date if it did not. What a list of
  /// things that happened needs, and nothing more.
  static func when(_ date: Date, now: Date = .now) -> String {
    calendar.isDate(date, inSameDayAs: now) ? hhmm(date) : day.string(from: date)
  }

  /// The same, for VoiceOver: «10/1» is read out as a fraction, so a day is
  /// said in words.
  static func whenSpoken(_ date: Date, now: Date = .now) -> String {
    calendar.isDate(date, inSameDayAs: now) ? hhmm(date) : dayWords(date)
  }

  /// A line as VoiceOver should say it. The marks that separate words on the
  /// screen — «·», «×» — are pauses, not words, and «№7001» is «дугаар 7001».
  static func spoken(_ text: String) -> String {
    text
      .replacingOccurrences(of: "№", with: "дугаар ")
      .replacingOccurrences(of: " · ", with: ", ")
      .replacingOccurrences(of: "·", with: ",")
      .replacingOccurrences(of: " ×", with: " ")
      .replacingOccurrences(of: "×", with: " ")
  }

  /// Money as VoiceOver should say it: the digits and the word, not the sign.
  static func moneySpoken(_ value: Int) -> String {
    "\(grouped(abs(value))) төгрөг"
  }
}
