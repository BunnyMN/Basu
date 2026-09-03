import SwiftUI

/**
 The launcher.

 It owns no domain logic: a header, whatever of the guest's is running, and a
 grid of icons. The second app inside Basu is one entry in `AppCatalogue` and
 nothing on this screen moves.

 Two rules are load-bearing and easy to erode later:

 - **The grid never rearranges itself.** No folders, no most-recently-used
   float. A grid that moves under the thumb cannot be learned, and recency
   already has a home one section higher.
 - **Bands are editorial**, fixed by the product, not derived from usage.
 */
struct HomeView: View {
  let open: (Destination) -> Void

  @Environment(AppModel.self) private var model
  @Environment(Session.self) private var session
  @Environment(Platform.self) private var platform
  @State private var signingIn = false
  @State private var query = ""

  private var bands: [AppBand] { AppCatalogue.bands(count: AppCatalogue.installedCount) }
  private var iconCount: Int { bands.reduce(0) { $0 + $1.apps.count } }

  private var live: [LiveItem] {
    let orders = model.live
    return orders.map { $0.asLiveItem(expanded: orders.count == 1) }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 9) {
        header

        if model.offline {
          OfflineBanner { await model.retry() }
            .padding(.top, 8)
        }

        if !live.isEmpty { liveSection }
        grid
      }
      .padding(.horizontal, 20)
      .padding(.top, 6)
      .padding(.bottom, 82)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
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

  // MARK: - header

  private var header: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 16) {
        VStack(alignment: .leading, spacing: 5) {
          SectionLabel("Улаанбаатар")
          Text("Basu")
            .font(.system(size: 27, weight: .semibold))
            .kerning(-0.675)
            .foregroundStyle(Color.ink)
        }
        Spacer(minLength: 8)
        HStack(spacing: 14) {
          if session.isSignedIn { bell }
          account
        }
        .padding(.top, 4)
      }

      Text(greeting)
        .font(.system(size: 17))
        .foregroundStyle(Color.ink2)
    }
  }

  private var greeting: String {
    guard session.isSignedIn else { return "Сайн байна уу. Өнөөдөр юу хийх вэ?" }
    return platform.me?.greeting ?? "Өнөөдөр юу хийх вэ?"
  }

  private var bell: some View {
    Button {
      open(.inbox)
    } label: {
      ShellGlyph(mark: .bell, size: 26)
        .foregroundStyle(Color.ink)
        .overlay(alignment: .topTrailing) {
          if platform.unread > 0 {
            UnreadBadge(count: platform.unread).offset(x: 5, y: -3)
          }
        }
        .frame(width: 44, height: 44, alignment: .center)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("home.inbox")
    .accessibilityLabel("Мэдэгдэл")
    .accessibilityValue(platform.unread > 0 ? "\(platform.unread) уншаагүй" : "уншаагүй алга")
  }

  private var account: some View {
    Button {
      if !session.isSignedIn { signingIn = true }
    } label: {
      Group {
        if session.isSignedIn {
          SeedAvatar(seed: platform.me?.avatarSeed ?? "00000000", size: 30)
        } else {
          ShellGlyph(mark: .profile, size: 26).foregroundStyle(Color.ink3)
        }
      }
      .frame(width: 44, height: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    // Signed in, the avatar is decoration — the profile is a tab. Signed out,
    // it is the way in, and the only control on the screen that does anything.
    .disabled(session.isSignedIn)
    .accessibilityIdentifier("home.account")
    .accessibilityLabel(session.isSignedIn ? "Бүртгэл" : "Нэвтрэх")
  }

  // MARK: - what is running

  private var liveSection: some View {
    VStack(alignment: .leading, spacing: 7) {
      SectionLabel("Идэвхтэй")
      VStack(spacing: 6) {
        ForEach(live) { item in
          Button {
            if let destination = item.destination { open(destination) }
          } label: {
            LiveRow(item: item)
          }
          .buttonStyle(.plain)
        }
      }
    }
  }

  // MARK: - the grid

  private var grid: some View {
    VStack(alignment: .leading, spacing: 9) {
      ForEach(bands) { band in
        VStack(alignment: .leading, spacing: 9) {
          HStack(spacing: 12) {
            SectionLabel(band.label)
            Spacer(minLength: 8)
            // Under seven icons a filter is slower than looking.
            if band.id == bands.first?.id, iconCount >= AppCatalogue.searchThreshold {
              SearchField(query: $query)
            }
          }
          .frame(minHeight: 22)

          LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 92), spacing: 14, alignment: .topLeading)],
            alignment: .leading,
            spacing: 10,
          ) {
            ForEach(matching(band.apps)) { app in
              AppTile(app: app) {
                if let destination = app.destination { open(destination) }
              }
            }
          }
        }
      }

      if iconCount == 1 {
        // A hairline and a sentence. Never a placeholder tile — that promises
        // a tap which does nothing.
        VStack(alignment: .leading, spacing: 0) {
          Hairline()
          Text(AppCatalogue.comingSoon)
            .font(.mono(11.5))
            .foregroundStyle(Color.ink3)
            .padding(.top, 12)
        }
      }
    }
  }

  private func matching(_ apps: [LauncherApp]) -> [LauncherApp] {
    let needle = query.trimmingCharacters(in: .whitespaces)
    guard !needle.isEmpty else { return apps }
    return apps.filter { $0.name.localizedCaseInsensitiveContains(needle) }
  }
}

/// The filter. It appears at seven icons and is hidden below that.
struct SearchField: View {
  @Binding var query: String

  var body: some View {
    HStack(spacing: 8) {
      ShellGlyph(mark: .magnifier, size: 13, lineWidth: 1.8)
        .foregroundStyle(Color.ink3)
      TextField("Хайх", text: $query)
        .font(.mono(12))
        .foregroundStyle(Color.ink)
        .textFieldStyle(.plain)
        .frame(width: 74)
    }
    .padding(.horizontal, 9)
    .padding(.vertical, 5)
    .glassWell()
    .accessibilityIdentifier("home.search")
  }
}

/**
 One live thing, as one row.

 The header run wraps: dot, source, title and meta sit on one line when they fit
 and fall onto the next when they do not, which is why «Чингисийн өргөн чөлөө»
 and «Алтан Тавган» both read without either being truncated.
 */
struct LiveRow: View {
  let item: LiveItem

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(alignment: .center, spacing: 14) {
        FlowLayout(spacing: CGSize(width: 8, height: 4)) {
          Circle()
            .fill(item.status.tint)
            .frame(width: 6, height: 6)
          SourceLabel(text: item.source)
          Text(item.title)
            .font(.system(size: 15.5, weight: .semibold))
            .foregroundStyle(Color.ink)
          Text(item.meta)
            .font(.mono(11.5))
            .foregroundStyle(Color.ink3)
        }
        Spacer(minLength: 0)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(item.timeLabel)
            .font(.mono(9, .medium))
            .tracking(1.26)
            .foregroundStyle(Color.ink3)
          Text(Format.hhmm(item.time))
            .font(.mono(23, .semibold))
            .monospacedDigit()
            .foregroundStyle(Color.ink)
        }
        .fixedSize()
      }

      if let extra = item.extra {
        VStack(spacing: 0) {
          Hairline()
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(extra.label)
              .font(.system(size: 12.5))
              .foregroundStyle(Color.ink2)
            Spacer(minLength: 0)
            Text(Format.hhmm(extra.time))
              .font(.mono(12.5, .semibold))
              .monospacedDigit()
              .foregroundStyle(Color.accent)
          }
          .padding(.top, 9)
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .glassCard()
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("live.\(item.id)")
  }
}
