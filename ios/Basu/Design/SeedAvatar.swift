import SwiftUI

/**
 A profile picture nobody had to upload.

 Sixteen cells on a 4×4 grid, filled from the eight hex characters identity
 issues with the account. Two characters per row, and the right half mirrors the
 left — the symmetry is what stops it reading as noise at 30 points, and the
 empty cells are what make two accounts tellable apart.

 The rules, in full:

 - a value divisible by three leaves its cell empty
 - odd values are circles, even values are squares with a 1pt radius
 - eight and over take `ink`, below eight takes `ink2`
 - the *first* value of thirteen or more takes the accent — at most one per mark

 No storage, no moderation queue, no CDN, and the same eight characters draw the
 same mark on every device forever.
 */
struct SeedAvatar: View {
  let seed: String
  var size: CGFloat = 30

  var body: some View {
    let cells = Self.cells(for: seed)
    let inset = size * 0.12
    let gap = size * 0.09
    // Worked out rather than left to a grid: at 30 points a flexible column
    // rounds itself out of the plate, and the mark spills over its own edge.
    let cell = max(1, (size - inset * 2 - gap * 3) / 4)

    VStack(spacing: gap) {
      ForEach(0..<4, id: \.self) { row in
        HStack(spacing: gap) {
          ForEach(0..<4, id: \.self) { column in
            let item = cells[row * 4 + column]
            Group {
              if let colour = item.colour {
                if item.round {
                  Circle().fill(colour)
                } else {
                  RoundedRectangle(cornerRadius: 1, style: .continuous).fill(colour)
                }
              } else {
                Color.clear
              }
            }
            .frame(width: cell, height: cell)
          }
        }
      }
    }
    .padding(inset)
    .frame(width: size, height: size)
    .glassWell(radius: size * 0.28)
    .accessibilityHidden(true)
  }

  struct Cell {
    let colour: Color?
    let round: Bool
  }

  /// Pure, and separately testable: the mark has to be identical on every
  /// device and every release, so the rule is worth a test rather than a look.
  static func cells(for seed: String) -> [Cell] {
    let characters = Array(seed.prefix(8))
    var accentUsed = false

    func cell(_ index: Int) -> Cell {
      guard index < characters.count,
            let value = Int(String(characters[index]), radix: 16),
            value % 3 != 0
      else { return Cell(colour: nil, round: false) }

      var colour: Color = value >= 8 ? .ink : .ink2
      if value >= 13, !accentUsed {
        colour = .accent
        accentUsed = true
      }
      return Cell(colour: colour, round: value % 2 == 1)
    }

    var out: [Cell] = []
    for row in 0..<4 {
      // Order matters: the accent goes to the first qualifying value in
      // reading order, so the left pair is resolved before it is mirrored.
      let a = cell(row * 2)
      let b = cell(row * 2 + 1)
      out.append(contentsOf: [a, b, b, a])
    }
    return out
  }
}
