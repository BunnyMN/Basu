import SwiftUI

/**
 Everything Basu has said to this guest, in one place.

 It exists because a message is not a notification. A push that arrives while
 the phone is in a pocket is gone; the thing it was about — your table is being
 held, your money came back — is not. The inbox is the record, and the push is
 only one way of pointing at it.
 */
struct InboxView: View {
  @Environment(Platform.self) private var platform

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if platform.inbox.messages.isEmpty {
          empty
        } else {
          VStack(spacing: 8) {
            ForEach(platform.inbox.messages) { message in
              Button {
                Task { await platform.markRead(message) }
              } label: {
                MessageCard(message: message)
              }
              .buttonStyle(.plain)
            }
          }
        }
      }
      .padding(.horizontal, 18)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Color.bg)
    .navigationTitle("Мэдэгдэл")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if platform.unread > 0 {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Бүгдийг уншсан") { Task { await platform.markAllRead() } }
            .font(.system(size: 13))
            .accessibilityIdentifier("inbox.readall")
        }
      }
    }
    .refreshable { await platform.loadInbox() }
    .task {
      await platform.loadInbox()
      // The moment the ask makes sense: they are looking at the messages, so
      // "may we send these to your lock screen" is a question about the thing
      // in front of them rather than an interruption on launch.
      await PushRegistrar.shared.askIfNeeded()
    }
  }

  private var empty: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Мэдэгдэл алга")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Color.ink)
      Text("Захиалга өгмөгц гал тавих цаг, ширээний мэдээллийг энд бичнэ.")
        .font(.system(size: 13))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 40)
  }
}

/// One message. Unread is a mark and a weight, not a colour wash — the list is
/// read top to bottom and a page of tinted blocks is harder to scan, not easier.
struct MessageCard: View {
  let message: InboxMessage

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Circle()
        .fill(message.read ? Color.clear : Color.accent)
        .frame(width: 6, height: 6)
        .padding(.top, 6)

      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(message.title ?? "Basu")
            .font(.system(size: 14, weight: message.read ? .medium : .semibold))
            .foregroundStyle(Color.ink)
          Spacer(minLength: 4)
          Text(Format.when(message.at))
            .font(.mono(10))
            .foregroundStyle(Color.ink3)
        }
        Text(message.body)
          .font(.system(size: 13))
          .foregroundStyle(Color.ink2)
          .fixedSize(horizontal: false, vertical: true)
          .multilineTextAlignment(.leading)
        // Said out loud, because "we texted you" and "we pushed you" are
        // different promises about where to look for it.
        Text(message.channel == "sms" ? "МЕССЕЖЭЭР" : "АППААР")
          .font(.mono(8.5))
          .tracking(1)
          .foregroundStyle(Color.ink3)
          .padding(.top, 2)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.surface, in: RoundedRectangle(cornerRadius: 4))
    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.line, lineWidth: 1))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("inbox.\(message.template)")
  }
}
