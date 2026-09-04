import BasuKit
import SwiftUI

/**
 Everything Basu has said to this guest, from every app, in one list.

 A push is not the notification. A push that arrives in a pocket is gone; the
 thing it was about — your table is held, your money came back — is not. This is
 that record, and the push is only one way of pointing at it.

 Unread is a muted blue wash and a heavier title. The accent is left to the
 bell's badge alone. There is no mark-all-read: opening a message reads it,
 and swiping one away deletes it.
 */
struct InboxView: View {
  let back: () -> Void
  /// Where a message points. A notification about an order that cannot be
  /// opened is a notification that made somebody go and find it themselves.
  let open: (Destination) -> Void

  @Environment(Platform.self) private var platform
  /// The one row whose Устгах is showing. Opening another closes it.
  @State private var swiped: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if platform.inbox.messages.isEmpty {
          empty
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
      .padding(.bottom, 78)
      .frame(maxWidth: .infinity, alignment: .leading)
      .clipShape(RoundedRectangle(cornerRadius: BasuMetric.card, style: .continuous))
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
    .safeAreaInset(edge: .top, spacing: 0) { ShellNav(title: "Мэдэгдэл", back: back) }
    .toolbarVisibility(.hidden, for: .navigationBar)
    .refreshable { await platform.loadInbox() }
    .task {
      await platform.loadInbox()
      // The moment the ask makes sense: they are looking at the messages, so
      // «may we send these to your lock screen» is a question about the thing
      // in front of them rather than an interruption on launch.
      await PushRegistrar.shared.askIfNeeded()
    }
  }

  /// A paragraph on the ground, under the same hairline the rows use. No
  /// illustration, no card, no button — there is nothing here to act on.
  private var empty: some View {
    VStack(alignment: .leading, spacing: 0) {
      Hairline()
      Text("Мэдэгдэл алга. Захиалга өгмөгц гал тавих цаг, ширээний мэдээллийг энд бичнэ.")
        .font(.sans(14))
        .lineSpacing(14 * 0.6 - 4)
        .foregroundStyle(Color.ink2)
        .padding(.top, 26)
        .frame(maxWidth: 300, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("inbox.empty")
    }
  }
}

/// One message. Source says where it came from; channel says where to look for
/// it — two separate facts, and both are on every row.
struct MessageRow: View {
  let message: InboxMessage

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 10) {
        HStack(spacing: 8) {
          SourceLabel(text: message.source)
          ChannelChip(channel: message.channel)
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
    .accessibilityElement(children: .combine)
    .accessibilityValue(message.read ? "уншсан" : "уншаагүй")
    .accessibilityIdentifier("inbox.\(message.template)")
  }
}

/// `SMS` or `АПП`. Where to go and look for it, which is not the same question
/// as which app sent it.
struct ChannelChip: View {
  let channel: String

  var body: some View {
    Text(channel == "sms" ? "SMS" : "АПП")
      .font(.mono(9, .medium))
      .tracking(9 * 0.12)
      .foregroundStyle(Color.ink2)
      .padding(.horizontal, 5)
      .padding(.vertical, 3)
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
        // The row's own right padding grows while open so the text
        // truncates rather than sliding out of the clip box.
        .padding(.trailing, open ? width : 0)
        .background(open || drag != 0 ? Color.swipeGround : Color.clear)
        .offset(x: offset)
        // High priority: once a finger has moved sideways this is a swipe,
        // and the row underneath must not also take it as a tap.
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
        .animation(.easeOut(duration: 0.2), value: open)
    }
    .clipped()
    .accessibilityAction(named: "Устгах", delete)
  }
}

extension InboxMessage {
  /// Which app the message is about, in the launcher's own vocabulary.
  var source: String { subject == "order" ? "ХООЛ" : "BASU" }

  /// What tapping it opens, when it is about something that can be opened.
  /// The platform's own messages — a welcome, a receipt — go nowhere.
  var destination: Destination? {
    guard subject == "order", let id = subjectId else { return nil }
    return .dine(orderId: id)
  }
}
