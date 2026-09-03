import SwiftUI
import Testing

@testable import Basu

/**
 The two rules in the shell that are not obvious by looking.

 The avatar is generated art: it has to draw the same mark from the same eight
 characters on every device and every release, and a mark that quietly changes
 is worse than no mark — somebody's account stops being recognisable and nothing
 crashes to say so. The launcher's bands decide what a person sees at one, four
 and nine icons, and nine icons is a state nobody will have on their phone for
 two years.

 Both are pure functions, which is the point: they are checked here rather than
 squinted at in a simulator.
 */
struct ShellTests {
  // MARK: - the avatar

  /// `e1d2f3a4` → 14, 1, 13, 2, 15, 3, 10, 4. Chosen because it exercises every
  /// branch: an accent, a *second* value that qualifies for accent and must not
  /// get it, two multiples of three that empty their cells, and both shapes.
  private let seed = "e1d2f3a4"

  @Test func theMarkIsSixteenCellsMirroredDownTheMiddle() {
    let cells = SeedAvatar.cells(for: seed)
    #expect(cells.count == 16)

    for row in 0..<4 {
      let (a, b, c, d) = (cells[row * 4], cells[row * 4 + 1], cells[row * 4 + 2], cells[row * 4 + 3])
      // The symmetry is what stops sixteen scattered cells reading as noise at
      // thirty points.
      #expect(a.colour == d.colour)
      #expect(a.round == d.round)
      #expect(b.colour == c.colour)
      #expect(b.round == c.round)
    }
  }

  @Test func aValueDivisibleByThreeLeavesItsCellEmpty() {
    let cells = SeedAvatar.cells(for: seed)
    // f = 15 and 3 are the multiples of three, and they are the third row's
    // pair — so the whole row empties.
    #expect(cells[8...11].allSatisfy { $0.colour == nil })
    // The empties are what make two accounts tellable apart; a full grid is
    // sixteen dots and every account looks the same.
    #expect(cells.contains { $0.colour != nil })
  }

  @Test func oddValuesAreCirclesAndEvenValuesAreSquares() {
    let cells = SeedAvatar.cells(for: seed)
    #expect(cells[0].round == false) // e = 14
    #expect(cells[1].round == true) // 1
    #expect(cells[4].round == true) // d = 13
    #expect(cells[5].round == false) // 2
  }

  @Test func onlyTheFirstQualifyingValueTakesTheAccent() {
    let cells = SeedAvatar.cells(for: seed)
    let accents = cells.filter { $0.colour == Color.accent }

    // e = 14 and d = 13 both qualify. Mirroring doubles whichever one wins, so
    // one accent means two cells — and never four.
    #expect(accents.count == 2)
    #expect(cells[0].colour == Color.accent)
    #expect(cells[4].colour != Color.accent)
  }

  @Test func eightAndOverIsInkAndBelowEightIsInk2() {
    let cells = SeedAvatar.cells(for: seed)
    // Rows are [a, b, b, a], so the fourth row's pair lands at 12 and 13.
    #expect(cells[4].colour == Color.ink) // d = 13, accent already spent
    #expect(cells[1].colour == Color.ink2) // 1
    #expect(cells[12].colour == Color.ink) // a = 10
    #expect(cells[13].colour == Color.ink2) // 4
  }

  @Test func theSameSeedAlwaysDrawsTheSameMark() {
    let first = SeedAvatar.cells(for: seed)
    let again = SeedAvatar.cells(for: seed)
    #expect(zip(first, again).allSatisfy { $0.colour == $1.colour && $0.round == $1.round })

    // A different account is a different mark — the whole point of the thing.
    let other = SeedAvatar.cells(for: "3f8c1a92")
    #expect(!zip(first, other).allSatisfy { $0.colour == $1.colour && $0.round == $1.round })
  }

  @Test func agarbledSeedDrawsAPlateRatherThanCrashing() {
    // Identity is meant to issue eight hex characters. If it ever does not, a
    // profile screen with an empty plate on it beats a profile screen that is
    // not there.
    for bad in ["", "zz", "not-hex-at-all", "0000000000000000"] {
      let cells = SeedAvatar.cells(for: bad)
      #expect(cells.count == 16)
    }
  }

  // MARK: - the launcher, as it grows

  @Test func oneIconIsOneBandAndTheOnlyLiveApp() {
    let bands = AppCatalogue.bands(count: 1)
    #expect(bands.count == 1)
    #expect(bands[0].label == "АППУУД")
    #expect(bands[0].apps.map(\.name) == ["Хоол"])
    #expect(bands[0].apps[0].isLive)
  }

  @Test func fourIconsStayInOneBand() {
    let bands = AppCatalogue.bands(count: 4)
    #expect(bands.count == 1)
    #expect(bands[0].apps.count == 4)
    // Drawn and named, but nothing behind them yet. A tile that opens nothing
    // has to look like it opens nothing.
    #expect(bands[0].apps.filter(\.isLive).count == 1)
  }

  @Test func nineIconsSplitIntoTheTwoEditorialBands() {
    let bands = AppCatalogue.bands(count: 9)
    #expect(bands.map(\.label) == ["ӨДӨР ТУТАМ", "БУСАД"])
    #expect(bands[0].apps.count == 3)
    #expect(bands[1].apps.count == 6)
    // Bands are product configuration. If this ever starts depending on what
    // somebody opened yesterday, the grid has begun rearranging itself.
    #expect(AppCatalogue.bands(count: 9).map(\.label) == bands.map(\.label))
  }

  @Test func everyAppHasItsOwnGlyphAndAOneWordTag() {
    let apps = AppCatalogue.bands(count: 9).flatMap(\.apps)
    #expect(Set(apps.map(\.glyph)).count == apps.count)
    for app in apps {
      #expect(!app.name.isEmpty)
      #expect(!app.tag.isEmpty)
      // The tag carries the specificity so the glyph does not have to.
      #expect(app.tag == app.tag.lowercased())
    }
  }

  @Test func theFilterOnlyEarnsItsPlaceAtSeven() {
    // Under seven, a filter is slower than looking.
    #expect(AppCatalogue.searchThreshold == 7)
    #expect(AppCatalogue.bands(count: 4).flatMap(\.apps).count < AppCatalogue.searchThreshold)
    #expect(AppCatalogue.bands(count: 9).flatMap(\.apps).count >= AppCatalogue.searchThreshold)
  }

  // MARK: - money, as it is set

  @Test func amountsAreGroupedAndCarryTheTugrikLast() {
    #expect(Format.mnt(70_000) == "70,000₮")
    #expect(Format.mnt(0) == "0₮")
    #expect(Format.grouped(1_234_567) == "1,234,567")
  }

  @Test func aStatementUsesARealMinusSignRatherThanAHyphen() {
    // They sit at different heights, and a column of amounts is read downward.
    #expect(Format.signedMnt(-18_500).hasPrefix("\u{2212}"))
    #expect(!Format.signedMnt(-18_500).hasPrefix("-"))
    #expect(Format.signedMnt(50_000).hasPrefix("+"))
  }
}
