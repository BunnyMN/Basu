import SwiftUI

/**
 The shell's drawn marks.

 Every one is described in a 24×24 box and scaled into whatever it is given, so
 the same coordinates serve a 13pt magnifier and a 44pt icon sheet. Stroke 1.6,
 round caps, round joins, one colour — the rules in `design/handoff/README.md`,
 which is also where the instructions for drawing the tenth one live.

 No fills anywhere. A filled glyph next to eight stroked ones is the thing the
 eye finds first, which is never what you meant by adding it.
 */

/// Points in the 24-unit design box, mapped into the rect the shape is given.
private struct Box {
  let rect: CGRect
  let s: CGFloat

  init(_ rect: CGRect) {
    self.rect = rect
    s = min(rect.width, rect.height) / 24
  }

  func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    CGPoint(x: rect.minX + x * s, y: rect.minY + y * s)
  }

  func r(_ v: CGFloat) -> CGFloat { v * s }
}

// MARK: - the app glyphs

enum GlyphKind: String, CaseIterable, Sendable {
  case food, idesh, taxi, delivery, ticket, bill, shop, net, pharmacy, cafe
}

/// One app's mark. `food` is the only one with a moving part.
struct Glyph: View {
  let kind: GlyphKind
  var size: CGFloat = 34
  var colour: Color = .accent
  var lineWidth: CGFloat = 1.6

  var body: some View {
    ZStack {
      GlyphBody(kind: kind)
        .stroke(colour, style: .init(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
      if kind == .ticket {
        // The stub's perforation. Dashed rather than drawn as ticks so it
        // stays a perforation at 34 and does not become five dots.
        TicketPerforation()
          .stroke(
            colour,
            style: .init(lineWidth: lineWidth, lineCap: .round, dash: [1.2 * size / 24, 2.4 * size / 24]),
          )
      }
      if kind == .food {
        Steam()
          .stroke(colour, style: .init(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
          .modifier(SteamDrift())
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/**
 The steam, and the only ambient motion in the shell.

 It moves because a kitchen is hot — a state the app is actually in, not
 decoration. A parked taxi does not move, and nothing else here does either.
 */
private struct SteamDrift: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var lifted = false

  func body(content: Content) -> some View {
    content
      .offset(y: lifted ? -1.4 : 0)
      .opacity(lifted ? 1 : 0.55)
      .animation(
        reduceMotion ? nil : .easeInOut(duration: 1.5).repeatForever(autoreverses: true),
        value: lifted,
      )
      .onAppear { if !reduceMotion { lifted = true } }
  }
}

private struct Steam: Shape {
  func path(in rect: CGRect) -> Path {
    let b = Box(rect)
    var path = Path()
    for x in [CGFloat(9.6), 14.4] {
      path.move(to: b.p(x, 6.4))
      path.addCurve(to: b.p(x + 1.2, 3.2), control1: b.p(x + 1.2, 5.4), control2: b.p(x - 1.2, 4.4))
    }
    return path
  }
}

private struct TicketPerforation: Shape {
  func path(in rect: CGRect) -> Path {
    let b = Box(rect)
    var path = Path()
    path.move(to: b.p(14.4, 6.4))
    path.addLine(to: b.p(14.4, 17.6))
    return path
  }
}

private struct GlyphBody: Shape {
  let kind: GlyphKind

  func path(in rect: CGRect) -> Path {
    let b = Box(rect)
    var path = Path()

    func rounded(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) {
      path.addRoundedRect(
        in: CGRect(origin: b.p(x, y), size: CGSize(width: b.r(w), height: b.r(h))),
        cornerSize: CGSize(width: b.r(r), height: b.r(r)),
        style: .continuous,
      )
    }
    func circle(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) {
      path.addEllipse(in: CGRect(
        origin: b.p(x - r, y - r),
        size: CGSize(width: b.r(r * 2), height: b.r(r * 2)),
      ))
    }
    func run(_ points: [(CGFloat, CGFloat)]) {
      guard let first = points.first else { return }
      path.move(to: b.p(first.0, first.1))
      for point in points.dropFirst() { path.addLine(to: b.p(point.0, point.1)) }
    }

    switch kind {
    case .food:
      // A bowl read from above: the rim, and the well inside it. From above
      // rather than in section, because a three-quarter bowl at 34 points is
      // a smudge. The steam is drawn separately so it can move.
      circle(12, 14.6, 6.4)
      circle(12, 14.6, 2.6)

    case .idesh:
      // A cut of ribs: the spine, and three bones hanging from it. The object,
      // not the animal — a sheep at 34 points is a cloud, and a hook reads as
      // a fishmonger. Four elements, which is the rule's ceiling.
      path.move(to: b.p(5, 6))
      path.addCurve(to: b.p(19, 6), control1: b.p(8.6, 7.4), control2: b.p(15.4, 7.4))
      run([(8, 7.2), (8, 18.5)])
      run([(12, 7.6), (12, 19.2)])
      run([(16, 7.2), (16, 18.5)])

    case .taxi:
      rounded(3.2, 10.4, 17.6, 6.2, 1.6)
      run([(9.6, 10.4), (9.6, 7.2), (14.4, 7.2), (14.4, 10.4)])
      circle(7.6, 18.4, 1.4)
      circle(16.4, 18.4, 1.4)

    case .delivery:
      // A box, taped down the middle, with the two lines that mean it is
      // moving. Three elements: the box, the tape, the speed.
      rounded(5.4, 7.6, 13.4, 12, 1.4)
      run([(12.1, 7.6), (12.1, 19.6)])
      run([(1.8, 10.6), (4.0, 10.6)])
      run([(1.8, 14.6), (4.0, 14.6)])

    case .ticket:
      rounded(3.2, 6.4, 17.6, 11.2, 1.4)
      run([(7.2, 12), (10.6, 12)])

    case .bill:
      rounded(6, 3.6, 12, 16.8, 1.4)
      run([(9.2, 9.2), (14.8, 9.2)])
      run([(9.2, 12.8), (14.8, 12.8)])
      run([(9.2, 16.4), (12.4, 16.4)])

    case .shop:
      // Elevation, not plan: a shop is a front you walk up to.
      run([(4.4, 9.6), (19.6, 9.6), (19.6, 20.4), (4.4, 20.4), (4.4, 9.6)])
      run([(4.4, 9.6), (6.4, 5.2), (17.6, 5.2), (19.6, 9.6)])

    case .net:
      circle(12, 12, 8)
      run([(4, 12), (20, 12)])
      path.move(to: b.p(12, 4))
      path.addCurve(to: b.p(12, 20), control1: b.p(15, 7.6), control2: b.p(15, 16.4))
      path.addCurve(to: b.p(12, 4), control1: b.p(9, 16.4), control2: b.p(9, 7.6))

    case .pharmacy:
      rounded(4, 4, 16, 16, 3)
      run([(12, 8.4), (12, 15.6)])
      run([(8.4, 12), (15.6, 12)])

    case .cafe:
      // Cup and handle. The saucer line is what stops it reading as a bucket.
      path.move(to: b.p(5.6, 8.4))
      path.addLine(to: b.p(16.8, 8.4))
      path.addLine(to: b.p(16.8, 13.8))
      path.addArc(
        center: b.p(11.2, 13.8), radius: b.r(5.6),
        startAngle: .degrees(0), endAngle: .degrees(180), clockwise: false,
      )
      path.closeSubpath()
      path.move(to: b.p(16.8, 9.6))
      path.addLine(to: b.p(18.4, 9.6))
      path.addArc(
        center: b.p(18.4, 11.6), radius: b.r(2),
        startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: false,
      )
      path.addLine(to: b.p(16.8, 13.6))
      run([(5.2, 19.6), (17.2, 19.6)])
    }

    return path
  }
}

// MARK: - the shell's own marks

/// Home, wallet, profile — the three in the tab bar, at SF Symbols' metrics.
enum ShellMark: String, Sendable {
  case home, wallet, profile, bell, magnifier
}

struct ShellGlyph: View {
  let mark: ShellMark
  var size: CGFloat = 23
  var lineWidth: CGFloat = 1.6

  var body: some View {
    ShellShape(mark: mark)
      .stroke(style: .init(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

private struct ShellShape: Shape {
  let mark: ShellMark

  func path(in rect: CGRect) -> Path {
    let b = Box(rect)
    var path = Path()
    func run(_ points: [(CGFloat, CGFloat)]) {
      guard let first = points.first else { return }
      path.move(to: b.p(first.0, first.1))
      for point in points.dropFirst() { path.addLine(to: b.p(point.0, point.1)) }
    }

    switch mark {
    case .home:
      run([(4, 10.6), (12, 4.4), (20, 10.6)])
      run([(6.2, 12.2), (6.2, 19.6), (17.8, 19.6), (17.8, 12.2)])

    case .wallet:
      path.addRoundedRect(
        in: CGRect(origin: b.p(3.4, 6.6), size: CGSize(width: b.r(17.2), height: b.r(10.8))),
        cornerSize: CGSize(width: b.r(1.6), height: b.r(1.6)),
        style: .continuous,
      )
      run([(15.2, 12), (18.6, 12)])

    case .profile:
      path.addEllipse(in: CGRect(
        origin: b.p(12 - 3.4, 9 - 3.4),
        size: CGSize(width: b.r(6.8), height: b.r(6.8)),
      ))
      path.move(to: b.p(5.8, 19.4))
      path.addCurve(to: b.p(12, 14.6), control1: b.p(7, 16.2), control2: b.p(9.4, 14.6))
      path.addCurve(to: b.p(18.2, 19.4), control1: b.p(14.6, 14.6), control2: b.p(17, 16.2))

    case .bell:
      path.move(to: b.p(7, 16.4))
      path.addLine(to: b.p(7, 11))
      path.addArc(
        center: b.p(12, 11), radius: b.r(5),
        startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false,
      )
      path.addLine(to: b.p(17, 16.4))
      run([(5.4, 16.4), (18.6, 16.4)])
      path.move(to: b.p(10.2, 19))
      path.addArc(
        center: b.p(12, 19), radius: b.r(1.8),
        startAngle: .degrees(180), endAngle: .degrees(0), clockwise: true,
      )

    case .magnifier:
      path.addEllipse(in: CGRect(
        origin: b.p(10.5 - 6.5, 10.5 - 6.5),
        size: CGSize(width: b.r(13), height: b.r(13)),
      ))
      run([(15.4, 15.4), (20, 20)])
    }

    return path
  }
}

/// The chevron, pointing whichever way it is asked to.
struct Chevron: View {
  enum Direction { case back, forward }

  var direction: Direction = .forward
  var size: CGFloat = 13
  var lineWidth: CGFloat = 2

  var body: some View {
    ChevronShape(direction: direction)
      .stroke(style: .init(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

private struct ChevronShape: Shape {
  let direction: Chevron.Direction

  func path(in rect: CGRect) -> Path {
    let b = Box(rect)
    var path = Path()
    switch direction {
    case .back:
      path.move(to: b.p(15, 5))
      path.addLine(to: b.p(8, 12))
      path.addLine(to: b.p(15, 19))
    case .forward:
      path.move(to: b.p(9, 5))
      path.addLine(to: b.p(16, 12))
      path.addLine(to: b.p(9, 19))
    }
    return path
  }
}
