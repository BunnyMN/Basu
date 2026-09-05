import BasuKit
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

  /// Both verticals, in one list, by the moment that matters. A sheep due
  /// Tuesday sits under today's lunch; the section does not know which app
  /// either came from.
  private var live: [LiveItem] {
    let count = model.live.count + model.liveIdesh.count
    let lunches = model.live.map { $0.asLiveItem(expanded: count == 1) }
    let provisions = model.liveIdesh.map { $0.asLiveItem() }
    return (lunches + provisions).sorted { $0.time < $1.time }
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
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.top, 6)
      .padding(.bottom, BasuMetric.tabBarInset)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
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

  /// `Basu` on the left, the bell alone on the right. No city label, no
  /// greeting, no avatar — all three were cut. Signed out there is no bell to
  /// ring, so the way in stands where it would be.
  private var header: some View {
    HStack(alignment: .top, spacing: 16) {
      Text("Basu")
        .font(.sans(27, .semibold))
        .tracking(-0.025 * 27)
        .foregroundStyle(Color.ink)
        .padding(.top, 8)
      Spacer(minLength: 8)
      if session.isSignedIn {
        bell
      } else {
        signIn
      }
    }
  }

  private var bell: some View {
    Button {
      open(.inbox)
    } label: {
      ShellGlyph(mark: .bell, size: BasuMetric.bell)
        .foregroundStyle(Color.ink)
        .overlay(alignment: .topTrailing) {
          if platform.unread > 0 {
            UnreadBadge(count: platform.unread).offset(x: 5, y: -3)
          }
        }
        .frame(width: BasuMetric.minTarget, height: BasuMetric.minTarget, alignment: .center)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    // The glyph is 26 in a 44 target; the design puts its top 4 below the
    // wordmark's, and the target's own slack accounts for the rest.
    .padding(.top, -5)
    .accessibilityIdentifier("home.inbox")
    .accessibilityLabel("Мэдэгдэл")
    .accessibilityValue(platform.unread > 0 ? "\(platform.unread) уншаагүй" : "уншаагүй алга")
  }

  private var signIn: some View {
    Button {
      signingIn = true
    } label: {
      Text("Нэвтрэх")
        .font(.sans(15, .medium))
        .foregroundStyle(Color.accent)
        .frame(minHeight: BasuMetric.minTarget)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.top, -5)
    .accessibilityIdentifier("home.account")
    .accessibilityLabel("Нэвтрэх")
  }

  // MARK: - what is running

  /// One card. The label sits inside it; rows follow, each with a hairline on
  /// top. Rows are not individual cards.
  private var liveSection: some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionLabel("Идэвхтэй")
        .padding(.top, 11)
        .padding(.horizontal, 14)
        .padding(.bottom, 10)
      ForEach(live) { item in
        Button {
          if let destination = item.destination { open(destination) }
        } label: {
          LiveRow(item: item)
        }
        .buttonStyle(.plain)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .glassCard()
    .accessibilityIdentifier("live.card")
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
            columns: [GridItem(.adaptive(minimum: BasuMetric.tileMin), spacing: BasuMetric.gridGapX, alignment: .topLeading)],
            alignment: .leading,
            spacing: BasuMetric.gridGapY,
          ) {
            ForEach(matching(band.apps)) { app in
              AppTile(app: app) {
                if let destination = app.destination { open(destination) }
              }
            }
          }
        }
      }

      if iconCount <= AppCatalogue.shipped.count {
        // A hairline and a sentence. Never a placeholder tile — that promises
        // a tap which does nothing.
        VStack(alignment: .leading, spacing: 0) {
          Hairline()
          Text(AppCatalogue.comingSoon)
            .font(.mono(11.5))
            .foregroundStyle(Color.ink3)
            .padding(.top, 12)
            .fixedSize(horizontal: false, vertical: true)
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
        .frame(width: 56, height: 12)
    }
    .padding(.horizontal, 9)
    .padding(.vertical, 5)
    .glassWell()
    .accessibilityIdentifier("home.search")
    .accessibilityLabel("Хайх")
  }
}

/**
 One live thing, as one row inside the card.

 Three lines on the left — the dot and the source, the title, the meta — and
 the moment on the right. A second line, separated by a hairline, only when
 the row is alone on the screen.
 */
struct LiveRow: View {
  let item: LiveItem

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(alignment: .top, spacing: 14) {
        VStack(alignment: .leading, spacing: 5) {
          HStack(spacing: 7) {
            Circle()
              .fill(item.status.tint)
              .frame(width: 6, height: 6)
            SourceLabel(text: item.source)
          }
          Text(item.title)
            .font(.sans(15.5, .semibold))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
          Text(item.meta)
            .font(.mono(11.5))
            .monospacedDigit()
            .foregroundStyle(Color.ink3)
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
        }
        Spacer(minLength: 0)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(item.timeLabel)
            .font(.mono(9, .medium))
            .tracking(9 * 0.14)
            .foregroundStyle(Color.ink3)
          Text(item.when)
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
              .font(.sans(12.5))
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
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .top) { Hairline() }
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("live.\(item.id)")
  }
}
