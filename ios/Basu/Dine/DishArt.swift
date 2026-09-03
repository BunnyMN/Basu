import SwiftUI

/**
 A picture for every dish, drawn rather than photographed.

 The nine forms are the same nine `src/api/dishes.ts` draws, from the same
 table of colours — the server sends the numbers, each platform draws them. A
 photograph would mean licensing somebody else's lunch and pretending it is
 theirs; these weigh nothing, they never fail to load, and they cannot show
 food a kitchen does not serve.

 Read top-down on purpose: a bowl from above is recognisable at the 56 points a
 menu row gives it, where a three-quarter view of the same bowl is a smudge.
 */
struct DishArt: View {
  let spec: DishSpec

  var body: some View {
    Canvas { context, size in
      let scale = min(size.width, size.height) / 160
      var draw = Brush(context: context, scale: scale, spec: spec)
      draw.ground(size: size)
      draw.form()
    }
    .accessibilityHidden(true)
  }
}

/// Everything the drawing needs, so the nine forms read as nine short methods
/// rather than as nine walls of coordinate arithmetic.
private struct Brush {
  var context: GraphicsContext
  let scale: CGFloat
  let spec: DishSpec

  var fill: Color { Color(uiColor: UIColor(hex: spec.fill)) }
  var detail: Color { Color(uiColor: UIColor(hex: spec.detail)) }
  var groundColour: Color { Color(uiColor: UIColor(hex: spec.ground)) }

  // MARK: the 160×160 world

  func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * scale, y: y * scale) }
  func by(_ value: CGFloat) -> CGFloat { value * scale }

  func ellipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat, rotate: CGFloat = 0) -> Path {
    let rect = CGRect(x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2)
    var path = Path(ellipseIn: rect)
    if rotate != 0 { path = path.applying(spin(rotate, about: CGPoint(x: cx, y: cy))) }
    return path.applying(CGAffineTransform(scaleX: scale, y: scale))
  }

  func rounded(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat, rotate: CGFloat = 0, about: CGPoint? = nil) -> Path {
    var path = Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: r)
    if rotate != 0 {
      path = path.applying(spin(rotate, about: about ?? CGPoint(x: x + w / 2, y: y + h / 2)))
    }
    return path.applying(CGAffineTransform(scaleX: scale, y: scale))
  }

  func line(from: CGPoint, to: CGPoint) -> Path {
    var path = Path()
    path.move(to: at(from.x, from.y))
    path.addLine(to: at(to.x, to.y))
    return path
  }

  private func spin(_ degrees: CGFloat, about point: CGPoint) -> CGAffineTransform {
    CGAffineTransform(translationX: point.x, y: point.y)
      .rotated(by: degrees * .pi / 180)
      .translatedBy(x: -point.x, y: -point.y)
  }

  // MARK: the parts every plated form shares

  mutating func ground(size: CGSize) {
    context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(groundColour))
  }

  /// The white ring the food sits in.
  mutating func plate(radius: CGFloat = 58) {
    let disc = ellipse(80, 80, radius, radius)
    context.fill(disc, with: .color(.white))
    context.stroke(disc, with: .color(.black.opacity(0.07)), lineWidth: by(1.5))
  }

  /// Steam, drawn on the cloth above the plate rather than on the plate: the
  /// first version was white on white and simply did not exist.
  mutating func steam(_ x: CGFloat, _ y: CGFloat) {
    var path = Path()
    path.move(to: at(x, y + 16))
    path.addQuadCurve(to: at(x, y + 5), control: at(x + 6, y + 10))
    path.addQuadCurve(to: at(x, y - 4), control: at(x - 6, y))
    context.stroke(
      path,
      with: .color(Color(rgb: 0x14181B).opacity(0.22)),
      style: StrokeStyle(lineWidth: by(2.4), lineCap: .round),
    )
  }

  // MARK: the nine forms

  mutating func form() {
    switch spec.form {
    case .soup: soup()
    case .dumpling: dumplings()
    case .fried: fried()
    case .noodle: noodles()
    case .grill: grill()
    case .salad: salad()
    case .rice: rice()
    case .skewer: skewer()
    case .drink: drink()
    }
  }

  private mutating func soup() {
    plate()
    let broth = ellipse(80, 80, 45, 45)
    context.fill(broth, with: .color(fill))
    context.stroke(broth, with: .color(.black.opacity(0.06)), lineWidth: by(1))
    for (cx, cy, rx, ry, angle) in [
      (66.0, 70.0, 13.0, 7.0, -18.0),
      (92.0, 78.0, 12.0, 6.5, 14.0),
      (74.0, 94.0, 12.0, 6.0, -6.0),
    ] {
      context.fill(ellipse(cx, cy, rx, ry, rotate: angle), with: .color(detail.opacity(0.92)))
    }
    steam(72, 34)
    steam(90, 30)
  }

  private mutating func dumplings() {
    plate()
    // Five parcels, placed by hand rather than in a ring: an even ring reads
    // as a diagram, a slight scatter reads as a plate.
    for (x, y) in [(62.0, 62.0), (98.0, 66.0), (58.0, 98.0), (96.0, 102.0), (80.0, 82.0)] {
      context.fill(ellipse(x, y, 19, 15), with: .color(fill))
      context.stroke(ellipse(x, y - 2, 19, 15), with: .color(detail), lineWidth: by(1.4))

      var pleat = Path()
      pleat.move(to: at(x - 11, y - 4))
      pleat.addQuadCurve(to: at(x, y - 11), control: at(x - 5.5, y - 11))
      pleat.addQuadCurve(to: at(x + 11, y - 4), control: at(x + 5.5, y - 11))
      context.stroke(pleat, with: .color(detail), style: StrokeStyle(lineWidth: by(1.8), lineCap: .round))

      context.fill(ellipse(x, y - 9, 2.6, 2.6), with: .color(detail))
    }
  }

  private mutating func fried() {
    plate()
    // Folded half-moons, overlapping the way they come off a pan.
    for (x, y, angle) in [(64.0, 70.0, -14.0), (96.0, 74.0, 12.0), (78.0, 100.0, -4.0)] {
      let pivot = CGPoint(x: x, y: y)
      let body = rounded(x - 26, y - 15, 52, 30, 14, rotate: angle, about: pivot)
      context.fill(body, with: .color(fill))
      context.stroke(body, with: .color(detail), lineWidth: by(1.6))

      for (dy, width, opacity) in [(-4.0, 1.6, 0.7), (4.0, 1.4, 0.5)] {
        let half: CGFloat = dy < 0 ? 18 : 16
        var crease = Path()
        crease.move(to: CGPoint(x: x - half, y: y + dy))
        crease.addLine(to: CGPoint(x: x + half, y: y + dy))
        crease = crease
          .applying(spin(angle, about: pivot))
          .applying(CGAffineTransform(scaleX: scale, y: scale))
        context.stroke(
          crease,
          with: .color(detail.opacity(opacity)),
          style: StrokeStyle(lineWidth: by(width), lineCap: .round),
        )
      }
    }
  }

  private mutating func noodles() {
    plate()
    // Strands as arcs across the plate, then the vegetables on top.
    for i in 0..<7 {
      let y = 58 + CGFloat(i) * 7
      let sweep: CGFloat = i % 2 == 0 ? 14 : -14
      var strand = Path()
      strand.move(to: at(42, y))
      strand.addQuadCurve(to: at(118, y), control: at(80, y + sweep))
      context.stroke(
        strand,
        with: .color(fill.opacity(0.95)),
        style: StrokeStyle(lineWidth: by(5), lineCap: .round),
      )
    }
    for (x, y, w, angle) in [(60.0, 66.0, 18.0, -24.0), (88.0, 86.0, 20.0, 16.0), (66.0, 100.0, 16.0, -8.0)] {
      context.fill(rounded(x, y, w, 6, 3, rotate: angle, about: CGPoint(x: x, y: y)), with: .color(detail))
    }
  }

  private mutating func grill() {
    plate()
    let cut = rounded(44, 54, 72, 52, 16)
    context.fill(cut, with: .color(fill))
    context.stroke(cut, with: .color(.black.opacity(0.08)), lineWidth: by(1.4))
    for (y1, y2) in [(68.0, 76.0), (84.0, 92.0)] {
      context.stroke(
        line(from: CGPoint(x: 56, y: y1), to: CGPoint(x: 104, y: y2)),
        with: .color(detail.opacity(0.85)),
        style: StrokeStyle(lineWidth: by(4.5), lineCap: .round),
      )
    }
    context.fill(ellipse(60, 112, 11, 5, rotate: -12), with: .color(Color(rgb: 0x7E9B4E).opacity(0.9)))
    context.fill(ellipse(78, 115, 9, 4.5), with: .color(Color(rgb: 0x7E9B4E).opacity(0.9)))
  }

  private mutating func skewer() {
    plate()
    // Meat alternating with onion — what makes a шорлог read as a шорлог at
    // icon size rather than as another piece of grilled meat.
    for (y, tilt) in [(66.0, -7.0), (98.0, 6.0)] {
      let pivot = CGPoint(x: 80, y: y)
      context.fill(rounded(36, y - 2, 88, 4, 2, rotate: tilt, about: pivot), with: .color(Color(rgb: 0xB9A98C)))
      for (i, x) in [52.0, 72.0, 92.0, 112.0].enumerated() {
        if i % 2 == 1 {
          var onion = Path(ellipseIn: CGRect(x: x - 7.5, y: y - 7.5, width: 15, height: 15))
          onion = onion.applying(spin(tilt, about: pivot)).applying(CGAffineTransform(scaleX: scale, y: scale))
          context.fill(onion, with: .color(Color(rgb: 0xEFE3CF)))
          context.stroke(onion, with: .color(.black.opacity(0.08)), lineWidth: by(1))
        } else {
          context.fill(rounded(x - 10, y - 11, 20, 22, 6, rotate: tilt, about: pivot), with: .color(fill))
          var mark = Path()
          mark.move(to: CGPoint(x: x - 6, y: y - 4))
          mark.addLine(to: CGPoint(x: x + 6, y: y - 4))
          mark = mark.applying(spin(tilt, about: pivot)).applying(CGAffineTransform(scaleX: scale, y: scale))
          context.stroke(mark, with: .color(detail), style: StrokeStyle(lineWidth: by(2.6), lineCap: .round))
        }
      }
    }
  }

  private mutating func salad() {
    plate()
    for (x, y, angle) in [
      (64.0, 68.0, -20.0), (96.0, 70.0, 24.0), (58.0, 96.0, 12.0),
      (98.0, 98.0, -16.0), (80.0, 84.0, 0.0),
    ] {
      context.fill(ellipse(x, y, 20, 12, rotate: angle), with: .color(fill.opacity(0.9)))
    }
    for (x, y, r) in [(68.0, 78.0, 7.0), (95.0, 90.0, 6.0), (80.0, 105.0, 5.0)] {
      context.fill(ellipse(x, y, r, r), with: .color(detail))
    }
  }

  private mutating func rice() {
    plate()
    context.fill(ellipse(80, 84, 43, 38), with: .color(fill))
    // Grains suggested by texture rather than counted out — the golden angle
    // scatters them without them landing in rings.
    for i in 0..<22 {
      let angle = CGFloat(i) * 2.39996
      let radius = 8 + CGFloat(i % 5) * 6.5
      let x = 80 + cos(angle) * radius
      let y = 84 + sin(angle) * radius * 0.8
      context.fill(
        ellipse(x, y, 4.4, 2.2, rotate: angle * 180 / .pi),
        with: .color(Color(rgb: 0x14181B).opacity(0.07)),
      )
    }
    context.fill(ellipse(92, 70, 14, 9, rotate: -16), with: .color(detail))
    context.fill(ellipse(74, 62, 11, 7, rotate: 12), with: .color(detail))
    context.fill(ellipse(62, 76, 9, 4.5, rotate: -20), with: .color(Color(rgb: 0x7E9B4E).opacity(0.85)))
    context.fill(ellipse(96, 94, 8, 4, rotate: 14), with: .color(Color(rgb: 0x7E9B4E).opacity(0.85)))
  }

  private mutating func drink() {
    let saucer = ellipse(80, 82, 52, 52)
    context.fill(saucer, with: .color(.white))
    context.stroke(saucer, with: .color(.black.opacity(0.07)), lineWidth: by(1.5))
    let cup = ellipse(80, 82, 38, 38)
    context.fill(cup, with: .color(fill))
    context.stroke(cup, with: .color(.black.opacity(0.07)), lineWidth: by(1.2))
    context.stroke(ellipse(80, 82, 27, 27), with: .color(detail.opacity(0.55)), lineWidth: by(2))
    steam(70, 30)
    steam(92, 26)
  }
}

/// A dish at the size a menu row gives it, with a real photograph taking over
/// the moment a restaurant sends one.
struct DishThumb: View {
  let item: MenuItem
  let table: DishTable
  var side: CGFloat = 56

  var body: some View {
    Group {
      if let url = item.photoURL {
        AsyncImage(url: url) { image in
          image.resizable().scaledToFill()
        } placeholder: {
          DishArt(spec: table[item.drawingSlug])
        }
      } else {
        DishArt(spec: table[item.drawingSlug])
      }
    }
    .frame(width: side, height: side)
    .clipShape(RoundedRectangle(cornerRadius: 4))
    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.line, lineWidth: 1))
  }
}
