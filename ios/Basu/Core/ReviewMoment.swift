import Foundation

/**
 When to ask for a rating: after something went right — a lunch served, a
 sheep handed over — and then the next time the guest is back on the
 launcher. Not in the middle of ordering, not on a first launch, and not twice
 for one version.

 Ratings are a large part of where a small app lands when somebody types its
 name into the App Store, and the honest way to earn them is to ask the
 people Basu has actually fed. The system still decides whether the prompt
 appears at all, and caps it at three a year; this only picks the moment.
 */
enum ReviewMoment {
  private static let finishedKey = "review.finishedOrder"
  private static let askedKey = "review.askedForVersion"

  /// A lunch served or a sheep handed over, seen on the live list.
  static func noteFinished() {
    UserDefaults.standard.set(true, forKey: finishedKey)
  }

  /// Something went right since the last ask, and this version has not asked.
  static var due: Bool {
    UserDefaults.standard.bool(forKey: finishedKey)
      && UserDefaults.standard.string(forKey: askedKey) != version
  }

  /// The next ask waits for the next version and the next good meal.
  static func markAsked() {
    UserDefaults.standard.set(version, forKey: askedKey)
    UserDefaults.standard.set(false, forKey: finishedKey)
  }

  private static var version: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
  }
}
