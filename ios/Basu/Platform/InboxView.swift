import BasuKit
import SwiftUI

/**
 Everything Basu has said to this guest, from every app, in one list.

 A push is not the notification. A push that arrives in a pocket is gone; the
 thing it was about — your table is held, your money came back — is not. This is
 that record, and the push is only one way of pointing at it.

 Unread is a pine dot before the source, a heavier title and a muted blue
 wash; the wash alone was too faint to see. There is no mark-all-read:
 opening a message reads it, and swiping one away deletes it.

 Nothing is asked here. Notifications are asked for after the first order
 (see `PushRegistrar`), when there is something to be told about — not over
 an empty list.
 */
struct InboxView: View {
  let back: () -> Void
  /// Where a message points. A notification about an order that cannot be
  /// opened is a notification that made somebody go and find it themselves.
  let open: (Destination) -> Void

  @Environment(Platform.self) private var platform
  /// The one row whose Устгах is showing. Opening another closes it.
  @State private var swiped: String?
  /// Whether the list has been asked for since the screen opened. Until it
  /// has, an empty list means "not yet", not "nothing".
  @State private var loaded = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if platform.inbox.messages.isEmpty {
          if !loaded {
            skeleton
          } else if let trouble = platform.trouble {
            // Not «nothing here» when the list never came: that is a
            // different thing to be told.
            Banner(message: trouble)
              .padding(.top, 8)
              .accessibilityIdentifier("inbox.trouble")
          } else {
            empty
          }
        } else {
          ForEach(platform.inbox.messages) { message in
            SwipeToDelete(
              open: Binding(get: { swiped == message.id }, set: { swiped = $0 ? message.id : nil }),
              delete: { Task { await platform.delete(message) } },
            ) {
              Button {
                Task { await platform.markRead(message) }
                if let destination = message.destination { open(destination) }
              } label: {
                MessageRow(message: message)
              }
              .buttonStyle(.plain)
            }
          }
          // The wrapper reaches 12 past the content on both sides, is rounded
          // at 12, and clips — so the wash and the swipe never bleed square.
          .padding(.horizontal, -12)
        }
      }
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.bottom, BasuMetric.tabBarInset)
      .frame(maxWidth: .infinity, alignment: .leading)
      .clipShape(RoundedRectangle(cornerRadius: BasuMetric.card, style: .continuous))
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
    .safeAreaInset(edge: .top, spacing: 0) { ShellNav(title: "Мэдэгдэл", back: back) }
    .toolbarVisibility(.hidden, for: .navigationBar)
    // The bar is hidden, and with it went the edge swipe back; it is the
    // first thing a thumb tries.
    .background(InteractivePop())
    .refreshable { await platform.loadInbox() }
    .task {
      await platform.loadInbox()
      loaded = true
    }
  }

  /// A paragraph on the ground, under the same hairline the rows use. No
  /// illustration, no card, no button — there is nothing here to act on.
  private var empty: some View {
    VStack(alignment: .leading, spacing: 0) {
      Hairline()
      Text("Мэдэгдэл алга. Захиалга өгвөл явц нь энд, утсанд тань ирнэ.")
        .font(.sans(14))
        .lineSpacing(14 * 0.6 - 4)
        .foregroundStyle(Color.ink2)
        .padding(.top, 26)
        .frame(maxWidth: 300, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("inbox.empty")
    }
  }

  /// Three rows in the shape of what is coming, so the list does not arrive
  /// as a jump — and so «Мэдэгдэл алга» is never said before it is known.
  private var skeleton: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(0..<3, id: \.self) { _ in
        MessageRow(message: .placeholder)
      }
    }
    .redacted(reason: .placeholder)
    .padding(.horizontal, -12)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Уншиж байна")
    .accessibilityIdentifier("inbox.loading")
  }
}

/// One message: which app it came from, when, and what it said. Where to look
/// for it is said only when it is not this phone — an SMS.
struct MessageRow: View {
  let message: InboxMessage

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 10) {
        HStack(spacing: 8) {
          if !message.read {
            Circle()
              .fill(Color.accent)
              .frame(width: 8, height: 8)
              .accessibilityHidden(true)
          }
          SourceLabel(text: message.source)
          if message.channel == "sms" { ChannelChip(channel: message.channel) }
        }
        Spacer(minLength: 4)
        Text(Format.when(message.at))
          .font(.mono(11))
          .monospacedDigit()
          .foregroundStyle(Color.ink3)
      }
      Text(message.title ?? "Basu")
        .font(.sans(15.5, message.read ? .regular : .semibold))
        .lineSpacing(15.5 * 0.35 - 4)
        .foregroundStyle(message.read ? Color.ink2 : Color.ink)
        .fixedSize(horizontal: false, vertical: true)
        .multilineTextAlignment(.leading)
      Text(message.body)
        .font(.sans(13))
        .lineSpacing(13 * 0.5 - 3)
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
        .multilineTextAlignment(.leading)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(message.read ? Color.clear : Color.unread)
    .overlay(alignment: .top) { Hairline() }
    .contentShape(Rectangle())
    // Said in words: combined, the row read out «№» and «·» one by one, and
    // a day as a fraction.
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken)
    .accessibilityValue(message.read ? "уншсан" : "уншаагүй")
    .accessibilityIdentifier("inbox.\(message.template)")
  }

  private var spoken: String {
    [
      message.source.capitalized,
      message.channel == "sms" ? "SMS" : nil,
      Format.whenSpoken(message.at),
      Format.spoken(message.title ?? "Basu"),
      Format.spoken(message.body),
    ]
    .compactMap { $0 }
    .joined(separator: ", ")
  }
}

/// `SMS`: where to go and look for a message that did not come to the app,
/// which is not the same question as which app sent it.
struct ChannelChip: View {
  let channel: String

  var body: some View {
    Text(channel == "sms" ? "SMS" : "АПП")
      .font(.mono(11, .medium))
      .tracking(11 * 0.08)
      .foregroundStyle(Color.ink2)
      .padding(.horizontal, 5)
      .padding(.vertical, 2)
      .overlay(
        RoundedRectangle(cornerRadius: BasuMetric.chip, style: .continuous)
          .strokeBorder(Color.line2, lineWidth: BasuMetric.hairline),
      )
  }
}

/**
 Swipe left to reveal Устгах: an 88pt `stop`-filled button pinned to the row's
 right edge. The row slides over it and stays open until it is tapped, swiped
 back, or another row opens.

 The row moves; it does not also shrink. Padded as well as moved, its words
 were cut at the left and an 88-point gap of bare ground opened between it
 and the button.

 VoiceOver does not swipe. The delete is also a custom action on the row, so
 the gesture is a shortcut and never the only way.
 */
struct SwipeToDelete<Content: View>: View {
  @Binding var open: Bool
  let delete: () -> Void
  @ViewBuilder let content: () -> Content

  @State private var drag: CGFloat = 0
  private let width = BasuMetric.swipeAction

  var body: some View {
    let offset = min(0, max(-width, (open ? -width : 0) + drag))
    ZStack(alignment: .trailing) {
      // Only there while it can be seen, so a closed row needs no opaque
      // back to hide it behind.
      if open || drag != 0 {
        Button(action: delete) {
          Text("Устгах")
            .font(.sans(14, .medium))
            .foregroundStyle(Color.onStop)
            .frame(width: width)
            .frame(maxHeight: .infinity)
            .background(Color.stop)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("inbox.delete")
        .accessibilityHidden(!open)
      }

      content()
        .background(open || drag != 0 ? Color.swipeGround : Color.clear)
        .offset(x: offset)
        .animation(.easeOut(duration: 0.2), value: open)
    }
    .clipped()
    // High priority, and over the button as well as the row: once a finger
    // has moved sideways this is a swipe — the row must not also take it as a
    // tap, and a swipe back that starts on Устгах closes the row rather than
    // deleting it.
    .highPriorityGesture(
      DragGesture(minimumDistance: 12, coordinateSpace: .local)
        .onChanged { value in
          guard abs(value.translation.width) > abs(value.translation.height) else { return }
          drag = value.translation.width
        }
        .onEnded { value in
          let settled = (open ? -width : 0) + value.translation.width
          withAnimation(.easeOut(duration: 0.2)) {
            open = settled < -width / 2
            drag = 0
          }
        },
    )
    .accessibilityAction(named: "Устгах", delete)
  }
}

extension InboxMessage {
  /// Which app the message is about, in the launcher's own vocabulary. A
  /// supplier hears about their own counter, not the guest's app.
  var source: String {
    if template.hasPrefix("supplier.") { return "НИЙЛҮҮЛЭГЧ" }
    switch subject {
    case "order": return "ХООЛ"
    case "idesh": return "ИДЭШ"
    default: return "BASU"
    }
  }

  /// What tapping it opens, when it is about something that can be opened:
  /// the order, or — when the message does not say which — the app it came
  /// from, whose own list starts with the person's orders. The platform's own
  /// messages — a welcome, a receipt — go nowhere.
  var destination: Destination? {
    // A new order at the supplier's counter opens the counter: the order is
    // a guest's, and their page would not open it for the supplier.
    if template.hasPrefix("supplier.") { return AppCatalogue.supplier.destination }
    let app: LauncherApp
    switch subject {
    case "order": app = AppCatalogue.food
    case "idesh": app = AppCatalogue.idesh
    default: return nil
    }
    return subjectId.flatMap(app.destination(order:)) ?? app.destination
  }

  /// The shape of a message, for the rows drawn while the real ones load.
  static let placeholder = InboxMessage(
    id: "placeholder",
    title: "Идэш баталгаажлаа",
    body: "Хонины мах · №7001. Нийлүүлэгч 10-р сарын 3-нд бэлэн байлгана.",
    template: "placeholder",
    subject: nil,
    subjectId: nil,
    channel: "push",
    state: "sent",
    at: .now,
    read: true,
  )
}
