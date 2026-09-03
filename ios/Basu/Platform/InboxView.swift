import SwiftUI

/**
 Everything Basu has said to this guest, from every app, in one list.

 A push is not the notification. A push that arrives in a pocket is gone; the
 thing it was about — your table is held, your money came back — is not. This is
 that record, and the push is only one way of pointing at it.

 Unread is a dot and a heavier title, never a tinted row. A page of coloured
 blocks is harder to scan, not easier.
 */
struct InboxView: View {
  let back: () -> Void
  /// Where a message points. A notification about an order that cannot be
  /// opened is a notification that made somebody go and find it themselves.
  let open: (Destination) -> Void

  @Environment(Platform.self) private var platform

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        Text("Мэдэгдэл")
          .font(.system(size: 28, weight: .semibold))
          .kerning(-0.56)
          .foregroundStyle(Color.ink)
          .padding(.bottom, 18)

        if platform.inbox.messages.isEmpty {
          empty
        } else {
          ForEach(platform.inbox.messages) { message in
            Button {
              Task { await platform.markRead(message) }
              if let destination = message.destination { open(destination) }
            } label: {
              MessageRow(message: message)
            }
            .buttonStyle(.plain)
          }
        }
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 88)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
    .safeAreaInset(edge: .top) {
      ShellHeader(back: back, trailing: AnyView(readAll))
    }
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

  @ViewBuilder private var readAll: some View {
    if platform.unread > 0 {
      Button {
        Task { await platform.markAllRead() }
      } label: {
        Text("Бүгдийг уншсан")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Color.accent)
          .frame(minHeight: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("inbox.readall")
    }
  }

  /// A paragraph on the ground, under the same hairline the rows use. No
  /// illustration, no card, no button — there is nothing here to act on.
  private var empty: some View {
    VStack(alignment: .leading, spacing: 0) {
      Hairline()
      Text("Мэдэгдэл алга. Захиалга өгмөгц гал тавих цаг, ширээний мэдээллийг энд бичнэ.")
        .font(.system(size: 14))
        .lineSpacing(4.4)
        .foregroundStyle(Color.ink2)
        .padding(.top, 26)
        .frame(maxWidth: 300, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// One message. Source says where it came from; channel says where to look for
/// it — two separate facts, and both are on every row.
struct MessageRow: View {
  let message: InboxMessage

  var body: some View {
    VStack(spacing: 0) {
      Hairline()
      HStack(alignment: .top, spacing: 12) {
        // Read rows keep the spacer so every title starts on the same column.
        Group {
          if message.read {
            Color.clear
          } else {
            Circle().fill(Color.accent)
          }
        }
        .frame(width: 6, height: 6)
        .padding(.top, 8)

        VStack(alignment: .leading, spacing: 7) {
          HStack(spacing: 10) {
            SourceLabel(text: message.source)
            ChannelChip(channel: message.channel)
            Spacer(minLength: 4)
            Text(Format.when(message.at))
              .font(.mono(11))
              .monospacedDigit()
              .foregroundStyle(Color.ink3)
          }
          Text(message.title ?? "Basu")
            .font(.system(size: 15.5, weight: message.read ? .regular : .semibold))
            .foregroundStyle(message.read ? Color.ink2 : Color.ink)
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
          Text(message.body)
            .font(.system(size: 13))
            .lineSpacing(3.5)
            .foregroundStyle(Color.ink2)
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
        }
      }
      .padding(.vertical, 16)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
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
      .tracking(1.08)
      .foregroundStyle(Color.ink2)
      .padding(.horizontal, 5)
      .padding(.vertical, 3)
      .overlay(
        RoundedRectangle(cornerRadius: 2, style: .continuous)
          .strokeBorder(Color.line2, lineWidth: 1),
      )
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
