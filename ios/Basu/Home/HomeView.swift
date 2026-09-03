import SwiftUI

/**
 The Basu home screen.

 It owns no domain logic: everything here is a name, a glyph and a link — plus
 whatever of the guest's is currently running, because a launcher that cannot
 tell you your lunch is on the fire is only a menu of links.
 */
struct HomeView: View {
  let open: (Destination) -> Void

  @Environment(AppModel.self) private var model
  @Environment(Session.self) private var session
  @Environment(Platform.self) private var platform
  @State private var signingIn = false

  /// Everything inside Basu, in the order it appears. A list rather than
  /// markup because this is the part that will grow: the second app is a new
  /// entry here and nothing else.
  private var apps: [(name: String, tag: String, destination: Destination)] {
    [("Хоол", "урьдчилсан", .dine(orderId: nil))]
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        header

        if model.offline {
          OfflineBanner { await model.retry() }
            .padding(.bottom, 20)
        }

        // The wallet sits above the apps because it is the thing that decides
        // whether any of them will work. A launcher that makes you open an app
        // to find out you have no money is a launcher that wasted a tap.
        if session.isSignedIn {
          Button { open(.wallet) } label: { WalletStrip(balanceMnt: platform.balanceMnt) }
            .buttonStyle(.plain)
            .padding(.bottom, 26)
        }

        if !model.live.isEmpty {
          SectionLabel("Идэвхтэй")
            .padding(.bottom, 10)
          VStack(spacing: 8) {
            ForEach(model.live) { order in
              Button { open(.dine(orderId: order.id)) } label: { LiveOrderCard(order: order) }
                .buttonStyle(.plain)
            }
          }
          .padding(.bottom, 26)
        }

        SectionLabel("Аппууд")
          .padding(.bottom, 10)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 10, alignment: .top)], alignment: .leading, spacing: 14) {
          ForEach(apps, id: \.name) { app in
            AppTile(name: app.name, tag: app.tag) { open(app.destination) }
          }
        }
        .padding(.bottom, 26)
      }
      .padding(.horizontal, 18)
      .padding(.top, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Color.bg)
    .safeAreaInset(edge: .top) { DemoClockBar() }
    .toolbarVisibility(.hidden, for: .navigationBar)
    .sheet(isPresented: $signingIn) { SignInSheet() }
    .refreshable {
      await model.refreshLive()
      await platform.refresh()
    }
    .task(id: session.token) {
      await model.refreshLive()
      await platform.refresh()
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text("Basu")
          .font(.system(size: 30, weight: .black))
          .kerning(-1.2)
          .foregroundStyle(Color.accentInk)
        Text("УЛААНБААТАР")
          .font(.mono(10))
          .tracking(2)
          .foregroundStyle(Color.ink3)
        Spacer()
        if session.isSignedIn {
          Button { open(.inbox) } label: {
            Image(systemName: "bell")
              .font(.system(size: 20))
              .foregroundStyle(Color.ink3)
              .overlay(alignment: .topTrailing) {
                // A count, not a dot: three messages waiting and one waiting
                // are different amounts of "later".
                if platform.unread > 0 {
                  Text("\(min(platform.unread, 99))")
                    .font(.mono(9, .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.accent, in: Capsule())
                    .offset(x: 7, y: -5)
                }
              }
          }
          .accessibilityIdentifier("home.inbox")
          .padding(.trailing, 4)
        }
        Button {
          if session.isSignedIn { open(.profile) } else { signingIn = true }
        } label: {
          Image(systemName: session.isSignedIn ? "person.crop.circle.fill" : "person.crop.circle")
            .font(.system(size: 22))
            .foregroundStyle(session.isSignedIn ? Color.accentInk : Color.ink3)
        }
        .accessibilityIdentifier("home.account")
      }
      Text(session.isSignedIn ? (platform.me?.greeting ?? "Өнөөдөр юу хийх вэ?") : "Сайн байна уу. Өнөөдөр юу хийх вэ?")
        .font(.system(size: 15))
        .foregroundStyle(Color.ink2)
        .padding(.bottom, 22)
    }
  }
}

/// One live order, as one line: where, what state, and the moment that matters.
struct LiveOrderCard: View {
  let order: LiveOrder

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(order.restaurant.name)
          .font(.system(size: 15, weight: .bold))
          .foregroundStyle(Color.ink)
        if let sub = order.state.subtitle, !sub.isEmpty {
          Text(sub)
            .font(.system(size: 12.5))
            .foregroundStyle(Color.ink2)
        }
        HStack(spacing: 6) {
          Text("№\(order.code)")
            .font(.mono(10))
            .foregroundStyle(Color.ink3)
          StateChip(state: order.state, label: order.state.word)
        }
        .padding(.top, 3)
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 1) {
        Text(Format.hhmm(order.moment.time))
          .font(.mono(17, .semibold))
          .foregroundStyle(Color.accentInk)
        Text(order.moment.label.uppercased())
          .font(.mono(8))
          .tracking(1)
          .foregroundStyle(Color.ink3)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity)
    .background(Color.surface, in: RoundedRectangle(cornerRadius: 4))
    .overlay(alignment: .leading) { Rectangle().fill(Color.accent).frame(width: 3) }
    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.line, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: 4))
    .accessibilityIdentifier("live.\(order.code)")
  }
}


/**
 The balance, on the launcher.

 One line because that is all it is worth here: the number, and a word saying
 what to do if it is too small. The statement is a screen away, and nobody
 needed it to decide whether to order lunch.
 */
struct WalletStrip: View {
  let balanceMnt: Int

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 1) {
        SectionLabel("Түрийвч")
        Text(Format.mnt(balanceMnt))
          .font(.mono(20, .semibold))
          .foregroundStyle(Color.ink)
          .contentTransition(.numericText())
      }
      Spacer(minLength: 8)
      Text(balanceMnt > 0 ? "Дэлгэрэнгүй" : "Цэнэглэх")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Color.accentInk)
      Image(systemName: "chevron.right")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Color.ink3)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 13)
    .frame(maxWidth: .infinity)
    .background(Color.surface, in: RoundedRectangle(cornerRadius: 4))
    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.line, lineWidth: 1))
    // One element, not five: a strip whose every label carries the same
    // identifier is read out as that identifier five times over.
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("home.wallet")
  }
}
