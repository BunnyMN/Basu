import BasuKit
import SwiftUI

/// The uppercase mono label the web pages use above every section — at 11,
/// the web's floor for anything that has to be read.
struct SectionLabel: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text.uppercased())
      .font(.mono(11, .medium))
      .tracking(11 * 0.14)
      .foregroundStyle(Color.ink3)
  }
}

/// The big button at the bottom of a sheet — pay, cancel, send — at the
/// button corner the web's buttons have.
struct WideButton: View {
  enum Kind { case primary, quiet, danger }

  let title: String
  var kind: Kind = .primary
  var enabled: Bool = true
  let action: () -> Void

  private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: BasuMetric.button, style: .continuous) }

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.sans(15, kind == .primary ? .semibold : .regular))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 15)
        .foregroundStyle(foreground)
        .background(background, in: shape)
        .overlay(shape.strokeBorder(border, lineWidth: 1))
        .contentShape(shape)
    }
    .buttonStyle(Pressable())
    .disabled(!enabled)
    .opacity(enabled ? 1 : 0.45)
  }

  private var foreground: Color {
    switch kind {
    case .primary: .onAccent
    case .quiet: .ink2
    case .danger: .stop
    }
  }
  private var background: Color { kind == .primary ? .accent : .surface }
  private var border: Color {
    switch kind {
    case .primary: .accent
    case .quiet: .line2
    case .danger: .stopLine
    }
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

  private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: BasuMetric.button, style: .continuous) }

  var body: some View {
    // At the largest text sizes the words take the whole width and «Дахин»
    // goes under them: beside them, both broke mid-word («Холбол/т», «Дах/ин»).
    Group {
      if typeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 10) {
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            mark
            words
          }
          again
        }
      } else {
        HStack(alignment: .center, spacing: 10) {
          mark
          words
          Spacer(minLength: 6)
          again
            .padding(.vertical, -5)
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.holdSoft, in: shape)
    .overlay(shape.strokeBorder(Color.holdLine, lineWidth: 1))
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
      .font(.sans(15))
      .foregroundStyle(Color.hold)
      .accessibilityHidden(true)
  }

  private var words: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("Холболт тасарлаа")
        .font(.sans(13.5, .semibold))
        .foregroundStyle(Color.ink)
        .fixedSize(horizontal: false, vertical: true)
      Text("Интернэтээ шалгаад дахин оролдоно уу.")
        .font(.sans(12))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// The only thing to do here, so a thumb's worth of it: a capsule in a
  /// 44-point target, not eleven points of mono — and never narrower than
  /// the word on it.
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
          ProgressView().controlSize(.small)
        } else {
          Text("Дахин")
            .font(.sans(14, .semibold))
            .foregroundStyle(Color.accentInk)
            .fixedSize()
        }
      }
      .padding(.horizontal, 14)
      .frame(minWidth: 64, minHeight: 34)
      .background(Color.surface, in: Capsule())
      .overlay(Capsule().strokeBorder(Color.holdLine, lineWidth: BasuMetric.hairline))
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

  private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: BasuMetric.button, style: .continuous) }

  var body: some View {
    Text(message)
      .font(.sans(13))
      .foregroundStyle(Color.stop)
      .frame(maxWidth: .infinity, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(12)
      .background(Color.stopSoft, in: shape)
      .overlay(shape.strokeBorder(Color.stopLine, lineWidth: 1))
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

/// The count on the bell. A pill rather than a circle, so it grows rightward
/// from its own left edge and the bell underneath never shifts.
struct UnreadBadge: View {
  let count: Int

  var body: some View {
    Text(count > 99 ? "99+" : "\(count)")
      .font(.mono(9.5, .semibold))
      .monospacedDigit()
      .foregroundStyle(Color.onAccent)
      .padding(.horizontal, 4)
      .frame(minWidth: 15, minHeight: 15)
      .background(Color.accent, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }
}

/// The tracked mono label that names which app a row came from.
struct SourceLabel: View {
  let text: String
  var size: CGFloat = 11

  var body: some View {
    Text(text)
      .font(.mono(size, .medium))
      .tracking(size * 0.12)
      .foregroundStyle(Color.ink3)
  }
}
