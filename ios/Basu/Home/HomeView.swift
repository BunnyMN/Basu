import BasuKit
import StoreKit
import SwiftUI

/**
 The launcher.

 It owns no domain logic: a hello, the apps as tiles, and whatever of the
 guest's is running. The second app inside Basu is one entry in
 `AppCatalogue` and nothing on this screen moves.

 «Тансаг хар» (2026-10-05) lays it out as the owner's prototype does: the
 day and a greeting in the display face, Идэш as the big tile because it is
 the season's, Хоол — and Нийлүүлэгч for the few who are one — beside each
 other under it, each picture untouched in its porcelain square; then the
 orders that are running, one card each.

 Two rules are load-bearing and easy to erode later:

 - **The tiles never rearrange themselves.** No folders, no most-recently-used
   float. A screen that moves under the thumb cannot be learned, and recency
   already has a home one section lower.
 - **The order is editorial**, fixed by the product, not derived from usage.
 */
struct HomeView: View {
  let open: (Destination) -> Void
  /// «Бүгд»: every order, under the Захиалга tab.
  let showOrders: () -> Void

  @Environment(AppModel.self) private var model
  @Environment(Session.self) private var session
  @Environment(Platform.self) private var platform
  @Environment(\.requestReview) private var requestReview
  @State private var signingIn = false

  /// Everything on the launcher, in the catalogue's order: what everybody
  /// has, then what this guest has that others do not.
  private var apps: [LauncherApp] {
    let extra = model.supplier != nil ? [AppCatalogue.supplier] : []
    return AppCatalogue.bands(count: AppCatalogue.installedCount + extra.count, extra: extra).flatMap(\.apps)
  }

  /// The season's app takes the big tile; the rest sit two to a row under it.
  private var big: LauncherApp? { apps.first { $0.id == AppCatalogue.idesh.id } }
  private var small: [LauncherApp] { apps.filter { $0.id != big?.id } }

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
      VStack(alignment: .leading, spacing: 0) {
        header
          .padding(.horizontal, 4)

        if model.offline {
          OfflineBanner { await model.retry() }
            .padding(.top, 20)
        }

        tiles
          .padding(.top, 24)

        if !live.isEmpty {
          liveSection
            .padding(.top, 36)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 12)
      .padding(.bottom, BasuMetric.tabBarInset)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(Color.bg)
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
    .task {
      // Back on the launcher after something went right: a moment to settle
      // first, so the ask is not the first thing that happens on arrival.
      guard ReviewMoment.due else { return }
      try? await Task.sleep(for: .seconds(2))
      guard !Task.isCancelled, ReviewMoment.due else { return }
      ReviewMoment.markAsked()
      requestReview()
    }
  }

  // MARK: - the hello

  /// The day, small, over a greeting in the display face; the bell on the
  /// right. Somebody only looking around (see `RootView`) has no bell to
  /// ring, so the way in stands where it would be.
  private var header: some View {
    HStack(alignment: .top, spacing: 16) {
      TimelineView(.everyMinute) { context in
        VStack(alignment: .leading, spacing: 10) {
          Text("\(Format.weekday(context.date)), \(Format.dayWords(context.date))")
            .font(.sans(14, .semibold))
            .foregroundStyle(Color.ink3)
          // One line, always: beside «Нэвтрэх» it gives a little of its size
          // rather than breaking «Өдрийн / мэнд» over two.
          Text(Format.greeting(at: context.date))
            .font(.display(44))
            .foregroundStyle(Color.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .accessibilityAddTraits(.isHeader)
        }
      }
      .layoutPriority(1)
      Spacer(minLength: 8)
      if session.isSignedIn {
        bell
      } else {
        signIn
      }
    }
    // A bar, like the system's: past this the greeting and «Нэвтрэх» broke
    // mid-word against each other.
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
  }

  private var signIn: some View {
    Button {
      signingIn = true
    } label: {
      Text("Нэвтрэх")
        .font(.sans(15, .bold))
        .foregroundStyle(Color.ink)
        .fixedSize()
        .padding(.horizontal, 18)
        .frame(minHeight: BasuMetric.minTarget)
        .background(Color.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.line2, lineWidth: BasuMetric.hairline))
        .contentShape(Capsule())
    }
    .buttonStyle(Pressable())
    .padding(.top, 4)
    .accessibilityIdentifier("home.account")
    .accessibilityLabel("Нэвтрэх")
  }

  /// A round button on the surface; something unread is a crimson dot on
  /// its shoulder, ringed in the surface so it reads as on top.
  private var bell: some View {
    Button {
      open(.inbox)
    } label: {
      ShellGlyph(mark: .bell, size: BasuMetric.bell)
        .foregroundStyle(Color.ink)
        .frame(width: BasuMetric.minTarget, height: BasuMetric.minTarget)
        .background(Color.surface, in: Circle())
        .overlay(Circle().strokeBorder(Color.line, lineWidth: BasuMetric.hairline))
        .overlay(alignment: .topTrailing) {
          if platform.unread > 0 {
            Circle()
              .fill(Color.accent)
              .frame(width: 8, height: 8)
              .padding(2)
              .background(Color.surface, in: Circle())
              .offset(x: -8, y: 8)
              .accessibilityHidden(true)
          }
        }
        .contentShape(Circle())
    }
    .buttonStyle(Pressable())
    .padding(.top, 4)
    .accessibilityIdentifier("home.inbox")
    .accessibilityLabel("Мэдэгдэл")
    .accessibilityValue(platform.unread > 0 ? "\(platform.unread) уншаагүй" : "уншаагүй алга")
  }

  // MARK: - the tiles

  private var tiles: some View {
    VStack(spacing: 12) {
      if let big {
        BigTile(app: big) { if let destination = big.destination { open(destination) } }
      }
      // Two to a row; one left over spans the row rather than leaving a hole.
      let pairs = stride(from: 0, to: small.count, by: 2).map { Array(small[$0..<min($0 + 2, small.count)]) }
      ForEach(pairs, id: \.first?.id) { pair in
        HStack(spacing: 12) {
          ForEach(pair) { app in
            SmallTile(app: app, wide: pair.count == 1) {
              if let destination = app.destination { open(destination) }
            }
          }
        }
      }
    }
  }

  // MARK: - what is running

  /// A label and «Бүгд», then one card per order.
  private var liveSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Text("Идэвхтэй захиалга".uppercased())
          .font(.sans(13, .bold))
          .tracking(13 * 0.14)
          .foregroundStyle(Color.ink3)
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: 8)
        Button(action: showOrders) {
          Text("Бүгд")
            .font(.sans(14, .bold))
            .foregroundStyle(Color.ink2)
            .padding(.leading, 16)
            .frame(minHeight: BasuMetric.minTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -14)
        .accessibilityIdentifier("home.orders")
        .accessibilityLabel("Бүх захиалга")
      }
      .padding(.horizontal, 4)

      ForEach(live) { item in
        Button {
          if let destination = item.destination { open(destination) }
        } label: {
          OrderCard(item: item)
        }
        .buttonStyle(Pressable())
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("live.card")
  }
}

/// The tile's ground: lit from the upper left, settling into the surface.
private var tileGround: LinearGradient {
  LinearGradient(
    colors: [Color(hex: 0x2A2321), Color(hex: 0x1D1817)],
    startPoint: UnitPoint(x: 0.2, y: 0),
    endPoint: UnitPoint(x: 0.75, y: 0.62),
  )
}

/**
 The season's app, as the big tile: a gold overline, the name in the display
 face at 64, one line of what it is, and its picture at 132 on the right.
 */
private struct BigTile: View {
  let app: LauncherApp
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .center, spacing: 12) {
        VStack(alignment: .leading, spacing: 0) {
          Text("Энэ улирал".uppercased())
            .font(.sans(11, .bold))
            .tracking(11 * 0.18)
            .foregroundStyle(Color.gold)
          Text(app.name)
            .font(.display(64))
            .foregroundStyle(Color.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .padding(.top, 8)
          Text(app.line)
            .font(.sans(15, .semibold))
            .foregroundStyle(Color.ink2)
            .frame(maxWidth: 170, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        Porcelain(name: art, size: 132, radius: BasuMetric.iconTileLarge)
      }
      .padding(.leading, 24)
      .padding(.trailing, 22)
      .padding(.vertical, 26)
      .frame(maxWidth: .infinity, minHeight: 204, alignment: .leading)
      .card(radius: BasuMetric.tile, fill: tileGround, stroke: Color(hex: 0xFFF4EC, opacity: 0.06))
      .contentShape(RoundedRectangle(cornerRadius: BasuMetric.tile, style: .continuous))
    }
    .buttonStyle(Pressable())
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    .accessibilityIdentifier("app.\(app.name)")
    .accessibilityLabel("\(app.name), \(app.tag)")
  }

  private var art: String {
    if case .raster(let name) = app.icon { return name }
    return "idesh-tile"
  }
}

/**
 An app beside another: its picture at 72 in the corner, an arrow opposite,
 the name in the display face and a line under it at the foot. Alone on its
 row it lies on its side — picture, words, arrow — rather than leave half a
 row empty.
 */
private struct SmallTile: View {
  let app: LauncherApp
  var wide = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Group {
        if wide {
          HStack(spacing: 16) {
            mark
            VStack(alignment: .leading, spacing: 8) { name; line }
            Spacer(minLength: 0)
            arrow
          }
          .padding(18)
          .frame(maxWidth: .infinity, minHeight: 108, alignment: .leading)
        } else {
          VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
              mark
              Spacer(minLength: 0)
              arrow
            }
            Spacer(minLength: 16)
            name
            line.padding(.top, 8)
          }
          .padding(.top, 18)
          .padding(.horizontal, 16)
          .padding(.bottom, 18)
          .frame(maxWidth: .infinity, minHeight: 190, alignment: .leading)
        }
      }
      .card(radius: BasuMetric.tile, fill: tileGround, stroke: Color(hex: 0xFFF4EC, opacity: 0.06))
      .contentShape(RoundedRectangle(cornerRadius: BasuMetric.tile, style: .continuous))
    }
    .buttonStyle(Pressable())
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    // Not `.disabled`: the plain style dims a disabled button, and the design
    // draws every tile at full strength. A tile with nothing behind it simply
    // does nothing when tapped, and says so.
    .accessibilityIdentifier("app.\(app.name)")
    .accessibilityLabel("\(app.name), \(app.tag)")
    .accessibilityHint(app.isLive ? "" : "Удахгүй")
  }

  @ViewBuilder private var mark: some View {
    switch app.icon {
    case .raster(let name):
      Porcelain(name: name, size: 72, radius: BasuMetric.iconTile)
    case .glyph(let kind):
      Glyph(kind: kind, size: BasuMetric.glyph)
        .frame(width: 72, height: 72)
        .background(Color.surface3, in: RoundedRectangle(cornerRadius: BasuMetric.iconTile, style: .continuous))
    }
  }

  private var arrow: some View {
    ShellGlyph(mark: .arrow, size: 20)
      .foregroundStyle(Color.ink3)
  }

  private var name: some View {
    Text(app.name)
      .font(.display(28))
      .foregroundStyle(Color.ink)
      .lineLimit(1)
      .minimumScaleFactor(0.6)
  }

  private var line: some View {
    Text(app.line)
      .font(.sans(13, .semibold))
      .foregroundStyle(Color.ink2)
      .lineLimit(2)
      .fixedSize(horizontal: false, vertical: true)
  }
}
