import BasuKit
import SwiftUI

/**
 The parts every form in the shell is made of: the way in, and the profile's
 own sheets — a name, an address, a password.

 One field, one code input, one button and one way of saying no, so that
 adding an address from the profile looks like the same app as signing in
 did. «Тансаг хар»: fields are the surface with a `line2` edge that turns to
 the ink when typed in; the one button is a crimson capsule; a refusal is
 crimson words under the field it is about.
 */

extension View {
  /// The one card the way in sits on.
  func authCard() -> some View {
    card(radius: BasuMetric.card)
  }
}

/// What a field shows while it is empty, in `ink3` — the system's own
/// placeholder grey is too faint to read on the charcoal.
func placeholder(_ words: String) -> Text {
  Text(words).foregroundStyle(Color.ink3)
}

/**
 A field: its mark, what is typed, and an edge that lights in the ink when it
 is the one being typed in. The whole of it takes the tap, not only the text —
 the mark is part of the target.

 At least the control height, never exactly it: at the largest text sizes
 the words need more room than 52 points, and a field that clips what is
 typed into it is worse than a taller field.
 */
struct AuthField<Content: View>: View {
  let symbol: String
  let active: Bool
  let tap: () -> Void
  @ViewBuilder let content: Content

  private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous) }

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: symbol)
        .font(.sans(16, .medium))
        .foregroundStyle(active ? Color.ink : Color.ink3)
        // Its own width, at least 22: fixed at 22, the largest text sizes drew
        // the mark over the words beside it.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .frame(minWidth: 22)
        .accessibilityHidden(true)
      content
        .font(.sans(16, .medium))
        .foregroundStyle(Color.ink)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 6)
    .frame(minHeight: BasuMetric.controlHeight)
    .background(Color.surface, in: shape)
    .overlay(shape.strokeBorder(active ? Color.focus : Color.line2, lineWidth: active ? 2 : BasuMetric.hairline))
    .contentShape(shape)
    .onTapGesture(perform: tap)
    .animation(.easeOut(duration: 0.15), value: active)
  }
}

/**
 Six digits in six boxes. The boxes are drawn; the typing goes to one plain
 field laid over them with its ink cleared, so pasting, the keyboard's
 «From Mail» suggestion and VoiceOver all see an ordinary text field.
 */
struct CodeInput<Field: Hashable>: View {
  @Binding var code: String
  var focus: FocusState<Field?>.Binding
  let field: Field
  let id: String

  var body: some View {
    let digits = Array(code)
    let typing = focus.wrappedValue == field
    ZStack {
      HStack(spacing: 8) {
        ForEach(0..<6, id: \.self) { index in
          let shape = RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous)
          let next = typing && index == min(digits.count, 5)
          Text(index < digits.count ? String(digits[index]) : "")
            .font(.display(28))
            .foregroundStyle(Color.ink)
            .frame(maxWidth: .infinity)
            .frame(height: BasuMetric.controlHeight + 6)
            .background(Color.surface, in: shape)
            .overlay(shape.strokeBorder(next ? Color.focus : Color.line2, lineWidth: next ? 2 : BasuMetric.hairline))
        }
      }
      // Six boxes are a row of digits at any text size; grown, they would
      // only push the row past the screen's edge.
      .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
      .allowsHitTesting(false)
      .accessibilityHidden(true)

      TextField("", text: $code)
        .keyboardType(.numberPad)
        .textContentType(.oneTimeCode)
        .focused(focus, equals: field)
        .foregroundStyle(.clear)
        .tint(.clear)
        .frame(height: BasuMetric.controlHeight + 6)
        .accessibilityLabel("Имэйлд ирсэн код")
        .accessibilityIdentifier(id)
    }
    .animation(.easeOut(duration: 0.12), value: code)
  }
}

/// The one thing the card is for: a crimson capsule with its own glow, and
/// the wait shown in place of the words.
struct PrimaryButton: View {
  let title: String
  let enabled: Bool
  let busy: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      ZStack {
        if busy {
          ProgressView().tint(Color.onAccent)
        } else {
          Text(title)
            .font(.sans(16, .bold))
            .multilineTextAlignment(.center)
        }
      }
      .foregroundStyle(Color.onAccent)
      .padding(.horizontal, 20)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity)
      .frame(minHeight: BasuMetric.buttonHeight)
      .background(Capsule().fill(Color.accent).glow(enabled || busy))
      .contentShape(Capsule())
    }
    .buttonStyle(Pressable())
    .disabled(!enabled || busy)
    .opacity(enabled || busy ? 1 : 0.45)
    .animation(.easeOut(duration: 0.15), value: enabled)
  }
}

/// Shrinks a touch under the thumb: the only answer a tap gets before the server's.
struct Pressable: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
      .opacity(configuration.isPressed ? 0.88 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

/// The small print under a field: what happens next, and where the code goes.
struct Note: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.sans(13, .medium))
      .lineSpacing(2)
      .foregroundStyle(Color.ink3)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/**
 A refusal, said under the field it is about — never at the foot of the card,
 where on a phone with the keyboard up it is under the keys. The phone buzzes
 the way iOS says no, so a wrong code that empties the boxes is felt as well
 as read.
 */
struct TroubleNote<Extra: View>: View {
  let text: String
  var id = "signin.trouble"
  @ViewBuilder var extra: Extra

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "exclamationmark.circle")
          .font(.sans(15, .semibold))
          .foregroundStyle(Color.accentInk)
          .accessibilityHidden(true)
        Text(text)
          .font(.sans(14, .semibold))
          .foregroundStyle(Color.accentInk)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier(id)
      }
      extra
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
    .background(Color.stopSoft, in: RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous)
        .strokeBorder(Color.stopLine, lineWidth: BasuMetric.hairline),
    )
    .transition(.opacity.combined(with: .scale(scale: 0.98)))
  }
}

extension TroubleNote where Extra == EmptyView {
  init(text: String, id: String = "signin.trouble") {
    self.init(text: text, id: id) { EmptyView() }
  }
}

/**
 A password, hidden or shown. Shown, it must not be "helped": no capital
 letter at the start, no autocorrected word.

 Both fields stay on screen, one of them invisible, rather than one taking
 the other's place: a filled password field leaving the screen is how iOS
 recognises a sign-in, and swapping them made it offer «Save Password?» for
 whatever had been typed so far.

 Generic over the screen's own focus: the way in has one set of fields, the
 profile's password and address sheets another.
 */
struct PasswordField<Field: Hashable>: View {
  let title: String
  @Binding var text: String
  let reveal: Bool
  let content: UITextContentType
  var focus: FocusState<Field?>.Binding
  let hidden: Field
  let shown: Field

  var body: some View {
    ZStack {
      SecureField(title, text: $text, prompt: placeholder(title))
        .focused(focus, equals: hidden)
        .opacity(reveal ? 0 : 1)
        .allowsHitTesting(!reveal)
        .accessibilityHidden(reveal)
      TextField(title, text: $text, prompt: placeholder(title))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused(focus, equals: shown)
        .opacity(reveal ? 1 : 0)
        .allowsHitTesting(reveal)
        .accessibilityHidden(!reveal)
    }
    .textContentType(content)
  }
}

/**
 The eye beside a password. A secure field on iOS offers only keyboards that
 type Latin, and a password chosen on the web may be in Cyrillic — shown, the
 field takes the Mongolian keyboard like any other.

 Turned, the keyboard moves to the twin that is now on show, where the same
 characters already are. A whole thumb's worth of target: the eye is small,
 the place to tap it is not.
 */
struct RevealButton<Field: Hashable>: View {
  @Binding var reveal: Bool
  var focus: FocusState<Field?>.Binding
  /// Every password on the screen, as its hidden field and its shown one.
  let twins: [(hidden: Field, shown: Field)]

  var body: some View {
    Button {
      reveal.toggle()
      if let now = focus.wrappedValue,
         let twin = twins.first(where: { $0.hidden == now || $0.shown == now }) {
        focus.wrappedValue = reveal ? twin.shown : twin.hidden
      }
    } label: {
      Image(systemName: reveal ? "eye.slash" : "eye")
        .font(.sans(15, .medium))
        .foregroundStyle(Color.ink3)
        .frame(width: BasuMetric.minTarget, height: BasuMetric.minTarget)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    // The field around it keeps its height: the eye's target reaches past
    // the text line into the field's own padding rather than growing it.
    .padding(.vertical, -6)
    .padding(.trailing, -10)
    .accessibilityLabel(reveal ? "Нууц үгийг нуух" : "Нууц үгийг харуулах")
  }
}

/// A row on a form that is not typed in: the address a code will go to.
struct AuthValue: View {
  let symbol: String
  let label: String
  let value: String

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: symbol)
        .font(.sans(16, .medium))
        .foregroundStyle(Color.ink3)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .frame(minWidth: 22)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(label)
          .font(.sans(12, .semibold))
          .foregroundStyle(Color.ink3)
        Text(value)
          .font(.sans(16, .semibold))
          .foregroundStyle(Color.ink)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .frame(minHeight: BasuMetric.controlHeight)
    .background(Color.surface, in: RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous)
        .strokeBorder(Color.line, lineWidth: BasuMetric.hairline),
    )
    .accessibilityElement(children: .combine)
  }
}

/// A quiet text button under a card — «Код дахин авах» — at a thumb's height.
struct QuietLink: View {
  let title: String
  let action: () -> Void

  init(_ title: String, action: @escaping () -> Void) {
    self.title = title
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.sans(14, .bold))
        .foregroundStyle(Color.ink)
        .frame(minHeight: BasuMetric.minTarget)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}
