import SwiftUI

/**
 Something of the guest's that is running right now, whichever app it belongs to.

 The launcher's «Идэвхтэй захиалга» is deliberately not one app's orders:
 rows are ordered by the moment that matters, not by which app produced them,
 so a sheep due Tuesday sits under today's lunch. The food app maps into this;
 the second app maps into it too, and the section does not know the difference.

 On the screen an order is a card: what it is, the state in one word, a meter
 of four under the word, and the day or the time in the corner with what it
 is the time of — «АВАХ», «ИРЭХ» — in gold.
 */
struct LiveItem: Identifiable, Hashable {
  /// What the order is waiting on — kept for VoiceOver and the tests; the
  /// screen says it with `word` and the meter, never with a coloured dot.
  enum Status: Hashable {
    /// Waiting on something — the kitchen, the restaurant, the supplier.
    case waiting
    /// On the fire, or being prepared.
    case cooking
    /// On its way. The one status that means *do not go anywhere*.
    case moving
    /// Ready, or handed over.
    case ready
    /// Over without happening — cancelled, refunded. Not an alarm.
    case over
  }

  /// How the state's word is set: as it is, or — for an order that ended
  /// without happening — in crimson (cancelled) or gold (money on its way
  /// back, a payment still owed), with no meter under it.
  enum Tone: Hashable { case plain, stop, hold }

  let id: String
  /// The app it came from, as a tracked label.
  let source: String
  let title: String
  /// The order's number, without its №.
  let code: String
  /// What is happening, in words — the web launcher's: «Хүлээгдэж байна»,
  /// «Хонины мах · 10 кг · Төлсөн».
  let detail: String
  let time: Date
  /// The time as the corner shows it: `12:21` for a lunch, `11/3` for a
  /// sheep. A day is not an instant, and printing one as 00:00 would be a lie.
  let when: String
  /// What the time *is* — `ИРЭХ`, `ГАЛ`, `БЭЛЭН`, `АВАХ`.
  let timeLabel: String
  let status: Status
  let destination: Destination?
  /// The row as VoiceOver says it: the words, not the «№», the «·» and the
  /// corner's abbreviations read out one by one.
  let spoken: String

  /// A second line, and only when this row is alone on the screen. One live
  /// thing can afford to say more; three cannot, and a list where some rows
  /// are taller than others is a list you have to read rather than scan.
  let extra: (label: String, time: Date)?

  // ── the card: a title, one word, a meter of four ───────────────────────

  /// The card's title: the restaurant, or the meat and how much of it.
  let headline: String
  /// The state in one word — the web's own: «Бэлтгэж байна».
  let word: String
  /// 1…4 along Төлсөн → Бэлтгэж байна → Бэлэн → Замд / Хүлээлгэн өгсөн;
  /// nought for an order that ended without happening, which has no meter.
  let step: Int
  let tone: Tone
  /// The tile's picture, for the thumbnail when there is no photograph.
  let art: String
  /// A photograph of what was bought, when the order says what animal.
  let photo: URL?
  /// Over: handed over, served, or ended without happening. The Захиалга
  /// tab keeps these apart from what is still on its way.
  let finished: Bool

  static func == (a: LiveItem, b: LiveItem) -> Bool { a.id == b.id }
  func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

extension LiveOrder {
  /// The food app's order, as the launcher sees it.
  func asLiveItem(expanded: Bool) -> LiveItem {
    let moment = moment
    // The web launcher's words for the same order, so the two never disagree.
    let detail = state.word
    let at = Format.hhmm(moment.time)
    let said = ["гал": "гал тавина", "бэлэн": "бэлэн болно"][moment.label] ?? moment.label
    return LiveItem(
      id: id,
      source: "ХООЛ",
      title: restaurant.name,
      code: code,
      detail: detail,
      time: moment.time,
      when: at,
      timeLabel: moment.label.uppercased(),
      status: liveStatus,
      destination: AppCatalogue.food.destination(order: id),
      spoken: "Хоол, \(restaurant.name), \(at) цагт \(said), захиалга \(code), \(detail.lowercased())",
      // The fire time is the product. When this is the only thing running it
      // belongs on the launcher, not one tap inside the app.
      extra: expanded && fireAt != nil && state != .fired && state != .cooking
        ? ("Гал тавих цаг", fireAt!)
        : nil,
      headline: restaurant.name,
      word: detail,
      step: step,
      tone: [.cancelled, .rejected, .noShow].contains(state) ? .stop : state == .refunded ? .hold : .plain,
      art: "food-tile",
      photo: nil,
      finished: [.served, .closed, .cancelled, .refunded, .rejected, .noShow].contains(state),
    )
  }

  private var liveStatus: LiveItem.Status {
    switch state {
    case .fired, .cooking: .cooking
    case .ready, .served, .closed: .ready
    case .cancelled, .refunded, .rejected, .noShow: .over
    default: .waiting
    }
  }

  /// Along the meter: in and waiting on the kitchen, on the fire, ready,
  /// served. An order that ended without a meal has none.
  var step: Int {
    switch state {
    case .fired, .cooking: 2
    case .ready: 3
    case .served, .closed: 4
    case .cancelled, .refunded, .rejected, .noShow: 0
    default: 1
    }
  }
}

extension LiveIdesh {
  /// The winter-meat order, as the launcher sees it. The second vertical
  /// mapping into the same row — which is what the row was drawn for.
  func asLiveItem() -> LiveItem {
    let cancelled = state == .cancelled
    let label = cancelled ? "буцаалт" : receive == "delivery" ? "ирэх" : "авах"
    let what = "\(meat) · \(amount)"
    return LiveItem(
      id: id,
      source: "ИДЭШ",
      title: supplier.name,
      code: code,
      detail: "\(what) · \(state.word)",
      time: receiveOn,
      // A cancelled order is still here for its refund, not for a day.
      when: cancelled ? "—" : Format.day(receiveOn),
      timeLabel: label.uppercased(),
      status: liveStatus,
      destination: AppCatalogue.idesh.destination(order: id),
      spoken: cancelled
        ? "Идэш, \(supplier.name), \(meat), \(amount), захиалга \(code), \(state.word.lowercased())"
        : "Идэш, \(supplier.name), \(Format.dayWords(receiveOn))-нд \(label), \(meat), \(amount), захиалга \(code), \(state.word.lowercased())",
      extra: nil,
      headline: what,
      word: state.word,
      step: step,
      tone: state == .cancelled ? .stop : state == .refunded || state == .draft ? .hold : .plain,
      art: "idesh-tile",
      photo: photo,
      finished: [.handed, .closed, .cancelled, .refunded].contains(state),
    )
  }

  /// The listing's name without what the amount already says: «Хонины мах,
  /// кг-аар» × 10 reads «Хонины мах · 10 кг».
  var meat: String {
    guard unit == "kg" else { return title }
    for tail in [", кг-аар", " кг-аар", ", кгаар"] where title.hasSuffix(tail) {
      return String(title.dropLast(tail.count))
    }
    return title
  }

  /// «10 кг», or «1 толгой» for a whole animal — the web's own words for the unit.
  var amount: String {
    unit == "kg" ? "\(qty) кг" : unit == "whole" ? "\(qty) толгой" : "×\(qty)"
  }

  private var liveStatus: LiveItem.Status {
    switch state {
    case .preparing: .cooking
    case .dispatched: .moving
    case .ready, .handed, .closed: .ready
    case .cancelled, .refunded: .over
    default: .waiting
    }
  }

  /// Along the meter — the state's own step, the lock screen's too.
  var step: Int { state.step }

  /// The animal's photograph, from the server — the one its stall shows.
  var photo: URL? {
    guard let kind, ["sheep", "beef", "goat", "horse"].contains(kind) else { return nil }
    return Endpoint.base.appending(path: "idesh/\(kind).jpg")
  }
}
