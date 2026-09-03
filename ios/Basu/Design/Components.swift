import SwiftUI

/// The uppercase mono label the web pages use above every section.
struct SectionLabel: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text.uppercased())
      .font(.mono(10, .medium))
      .tracking(1.6)
      .foregroundStyle(Color.ink3)
  }
}

/// The state chip: `PLACED`, `FIRED`, `READY` — each with the colour the
/// kitchen display and the web app already give it.
struct StateChip: View {
  let state: OrderState
  let label: String

  var body: some View {
    Text(label)
      .font(.mono(11, .medium))
      .foregroundStyle(state.tint)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(state.soft, in: RoundedRectangle(cornerRadius: 3))
      .overlay(RoundedRectangle(cornerRadius: 3).stroke(state.line, lineWidth: 1))
  }
}

/// The big button at the bottom of a sheet — pay, cancel, send.
struct WideButton: View {
  enum Kind { case primary, quiet, danger }

  let title: String
  var kind: Kind = .primary
  var enabled: Bool = true
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 15, weight: kind == .primary ? .semibold : .regular))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 15)
        .foregroundStyle(foreground)
        .background(background, in: RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(border, lineWidth: 1))
    }
    .disabled(!enabled)
    .opacity(enabled ? 1 : 0.45)
  }

  private var foreground: Color {
    switch kind {
    case .primary: .white
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

/// Five tappable stars. Keeps its own value so the form around it can rebuild
/// without taking the caret out of whatever somebody is typing.
struct StarPicker: View {
  @Binding var stars: Int
  var size: CGFloat = 30

  var body: some View {
    HStack(spacing: 4) {
      ForEach(1...5, id: \.self) { n in
        Button {
          stars = n
        } label: {
          Image(systemName: n <= stars ? "star.fill" : "star")
            .font(.system(size: size))
            .foregroundStyle(n <= stars ? Color.accentInk : Color.line2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(n) од")
      }
    }
  }
}

/**
 The server is not answering.

 Said out loud rather than left as an empty screen: "no restaurants today" and
 "this phone cannot reach anything" are the same picture and completely
 different problems, and only one of them is the guest's to wait out. A debug
 build adds the line the developer actually needs.
 */
struct OfflineBanner: View {
  let retry: () async -> Void
  @State private var trying = false

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "wifi.slash")
        .font(.system(size: 15))
        .foregroundStyle(Color.hold)
      VStack(alignment: .leading, spacing: 2) {
        Text("Серверт холбогдож чадсангүй")
          .font(.system(size: 13.5, weight: .semibold))
          .foregroundStyle(Color.ink)
        Text(hint)
          .font(.system(size: 12))
          .foregroundStyle(Color.ink2)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 6)
      Button {
        Task {
          trying = true
          await retry()
          trying = false
        }
      } label: {
        if trying {
          ProgressView().controlSize(.small)
        } else {
          Text("Дахин")
            .font(.mono(11, .semibold))
            .foregroundStyle(Color.accentInk)
        }
      }
      .accessibilityIdentifier("offline.retry")
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.holdSoft, in: RoundedRectangle(cornerRadius: 4))
    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.holdLine, lineWidth: 1))
    // Without this the row is a handful of loose labels rather than one thing
    // anybody — VoiceOver or a test — can point at.
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("offline.banner")
  }

  private var hint: String {
    #if DEBUG
      return "API: \(Endpoint.base.absoluteString) — `npm run dev` ажиллаж байгаа эсэхийг шалгана уу."
    #else
      return "Сүлжээгээ шалгаад дахин оролдоно уу."
    #endif
  }
}

/// A line of trouble, said in Mongolian, in the place it happened.
struct Banner: View {
  let message: String

  var body: some View {
    Text(message)
      .font(.system(size: 13))
      .foregroundStyle(Color.stop)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(Color.stopSoft, in: RoundedRectangle(cornerRadius: 4))
      .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.stopLine, lineWidth: 1))
  }
}
