import BasuKit
import SwiftUI

/// The small uppercase label above a section: 12, bold, tracked wide, in
/// `ink3` — the web's own eyebrow, in the sans now that there is no mono.
struct SectionLabel: View {
  let text: String
  var colour: Color = .ink3
  init(_ text: String, colour: Color = .ink3) {
    self.text = text
    self.colour = colour
  }

  var body: some View {
    Text(text.uppercased())
      .font(.sans(12, .bold))
      .tracking(12 * 0.14)
      .foregroundStyle(colour)
      .accessibilityAddTraits(.isHeader)
  }
}

/**
 The buttons of a sheet's foot.

 - `primary`: the crimson capsule, white words, its own glow — the one thing
   the screen is for.
 - `quiet`: an outlined capsule — the way past, the second choice.
 - `danger`: crimson words and nothing else; what it does is asked again in
   an alert before it happens.
 */
struct WideButton: View {
  enum Kind { case primary, quiet, danger }

  let title: String
  var kind: Kind = .primary
  var enabled: Bool = true
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.sans(16, .bold))
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .frame(minHeight: kind == .danger ? BasuMetric.minTarget : BasuMetric.buttonHeight)
        .foregroundStyle(foreground)
        .background {
          switch kind {
          case .primary: Capsule().fill(Color.accent).glow(enabled)
          case .quiet: Capsule().strokeBorder(Color.line2, lineWidth: BasuMetric.hairline)
          case .danger: EmptyView()
          }
        }
        .contentShape(Capsule())
    }
    .buttonStyle(Pressable())
    .disabled(!enabled)
    .opacity(enabled ? 1 : 0.45)
  }

  private var foreground: Color {
    switch kind {
    case .primary: .onAccent
    case .quiet: .ink
    case .danger: .accentInk
    }
  }
}

/**
 A tile's picture in its porcelain square: the supplied render, untouched,
 clipped to the square's corner, with a white hairline at six per cent and a
 deep shadow so it sits on the charcoal rather than being pasted on it.
 */
struct Porcelain: View {
  let name: String
  var size: CGFloat = 72
  var radius: CGFloat = BasuMetric.iconTile

  var body: some View {
    RasterTile(name: name, size: size, radius: radius)
      .overlay(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(Color.white.opacity(0.06), lineWidth: BasuMetric.hairline),
      )
      .shadow(color: .black.opacity(0.8), radius: 14, y: 14)
  }
}

/**
 The server is not answering.

 Said out loud rather than left as an empty screen: "no restaurants today" and
 "this phone cannot reach anything" are the same picture and completely
 different problems, and only one of them is the guest's to wait out. Said in
 the guest's words — a lost connection, the internet to check — not the
 developer's: nobody holding a phone knows what a server is.

 The words are for whoever holds the phone, in every build. A debug build
 once added the API's address and `npm run dev` here, and a debug copy on a
 phone showed that to its owner; the developer's line goes to the console.
 */
struct OfflineBanner: View {
  let retry: () async -> Void
  @State private var trying = false
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    // At the largest text sizes the words take the whole width and «Дахин»
    // goes under them: beside them, both broke mid-word («Холбол/т», «Дах/ин»).
    Group {
      if typeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 10) {
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            mark
            words
          }
          again
        }
      } else {
        HStack(alignment: .center, spacing: 12) {
          mark
          words
          Spacer(minLength: 6)
          again
            .padding(.vertical, -5)
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .card(radius: BasuMetric.card)
    // Without this the row is a handful of loose labels rather than one thing
    // anybody — VoiceOver or a test — can point at.
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("offline.banner")
    .onAppear {
      #if DEBUG
        NSLog("Basu: no answer from \(Endpoint.base.absoluteString) — is `npm run dev` running?")
      #endif
    }
  }

  private var mark: some View {
    Image(systemName: "wifi.slash")
      .font(.sans(16, .semibold))
      .foregroundStyle(Color.gold)
      .accessibilityHidden(true)
  }

  private var words: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text("Холболт тасарлаа")
        .font(.sans(15, .bold))
        .foregroundStyle(Color.ink)
        .fixedSize(horizontal: false, vertical: true)
      Text("Интернэтээ шалгаад дахин оролдоно уу.")
        .font(.sans(13, .medium))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// The only thing to do here, so a thumb's worth of it: an outlined
  /// capsule in a 44-point target — and never narrower than the word on it.
  private var again: some View {
    Button {
      Task {
        trying = true
        await retry()
        trying = false
      }
    } label: {
      ZStack {
        if trying {
          ProgressView().controlSize(.small).tint(Color.ink)
        } else {
          Text("Дахин")
            .font(.sans(14, .bold))
            .foregroundStyle(Color.ink)
            .fixedSize()
        }
      }
      .padding(.horizontal, 16)
      .frame(minWidth: 72, minHeight: 36)
      .overlay(Capsule().strokeBorder(Color.line2, lineWidth: BasuMetric.hairline))
      .frame(minHeight: BasuMetric.minTarget)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(trying)
    .accessibilityIdentifier("offline.retry")
  }
}

/// A line of trouble, said in Mongolian, in the place it happened.
struct Banner: View {
  let message: String

  private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: BasuMetric.inner, style: .continuous) }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.circle")
        .font(.sans(15, .semibold))
        .foregroundStyle(Color.accentInk)
        .accessibilityHidden(true)
      Text(message)
        .font(.sans(14, .medium))
        .foregroundStyle(Color.accentInk)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(14)
    .background(Color.stopSoft, in: shape)
    .overlay(shape.strokeBorder(Color.stopLine, lineWidth: BasuMetric.hairline))
  }
}

/**
 A run of things that wraps, the way a paragraph does.

 The live row needs it: a status dot, a source label, a title and a meta line
 sit on one line when they fit and fall onto the next when they do not, so a
 restaurant called «Алтан Тавган» and one called «Чингисийн өргөн чөлөө» both
 read correctly without either being truncated or given its own layout.
 */
struct FlowLayout: Layout {
  var spacing: CGSize = CGSize(width: 8, height: 4)
  var alignment: VerticalAlignment = .center

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    let rows = rows(subviews, in: width)
    let height = rows.reduce(0) { $0 + $1.height } + spacing.height * CGFloat(max(0, rows.count - 1))
    let widest = rows.map(\.width).max() ?? 0
    return CGSize(width: min(width, widest), height: height)
  }

  func placeSubviews(
    in bounds: CGRect,
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout (),
  ) {
    var y = bounds.minY
    for row in rows(subviews, in: bounds.width) {
      var x = bounds.minX
      for index in row.indices {
        let size = subviews[index].sizeThatFits(.unspecified)
        let dy = alignment == .center ? (row.height - size.height) / 2 : 0
        subviews[index].place(
          at: CGPoint(x: x, y: y + dy),
          proposal: ProposedViewSize(size),
        )
        x += size.width + spacing.width
      }
      y += row.height + spacing.height
    }
  }

  private struct Row {
    var indices: [Int] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func rows(_ subviews: Subviews, in width: CGFloat) -> [Row] {
    var rows: [Row] = []
    var row = Row()
    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      let needed = row.indices.isEmpty ? size.width : row.width + spacing.width + size.width
      if !row.indices.isEmpty, needed > width {
        rows.append(row)
        row = Row()
      }
      row.width = row.indices.isEmpty ? size.width : row.width + spacing.width + size.width
      row.height = max(row.height, size.height)
      row.indices.append(index)
    }
    if !row.indices.isEmpty { rows.append(row) }
    return rows
  }
}

/// The tracked label that names which app a row came from: «ИДЭШ», «ХООЛ».
struct SourceLabel: View {
  let text: String
  var size: CGFloat = 12
  var colour: Color = .ink3

  var body: some View {
    Text(text)
      .font(.sans(size, .bold))
      .tracking(size * 0.14)
      .foregroundStyle(colour)
  }
}
