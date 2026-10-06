import BasuKit
import SwiftUI
import WidgetKit

/**
 Basu — a launcher, and the things that arrive inside it.

 The home screen owns no domain logic: it is a list of icons, whatever of the
 guest's is running, and a way into the three things every app shares. Today
 there is one icon. The second is one entry in `AppCatalogue`, and nothing
 else on this screen changes — which is the whole of what "shell" means here.

 The shell is native and the apps are not. Every icon opens a web page from
 the shell's own server inside `ServiceView`, signed in as the shell's guest;
 the shell keeps the launcher, the wallet, the inbox, the profile and the
 lock screen, which are the parts a person sees before choosing anything.

 Wallet, notifications and profile are not apps. They are the shell's, they are
 in `Platform/`, and a second vertical gets all three without writing any of it.
 */
@main
struct BasuApp: App {
  @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
  @State private var model: AppModel
  @State private var platform: Platform
  @State private var lock = AppLock()

  init() {
    let model = AppModel()
    _model = State(initialValue: model)
    _platform = State(initialValue: Platform(api: model.api, session: model.session))
    // Light, dark or the phone's own was a choice until «Тансаг хар»: Basu is
    // dark now whatever the phone says, and the old answer is let go of.
    UserDefaults.standard.removeObject(forKey: "appearance")
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .environment(model.session)
        .environment(platform)
        .environment(lock)
        // Dark on every screen, sheets and alerts included, whatever the
        // phone's own setting (Info.plist says the same to UIKit).
        .preferredColorScheme(.dark)
        // System controls — a sheet's «Болих», an alert's button, a cursor —
        // in the ink. Crimson is kept for the one primary action.
        .tint(.ink)
    }
  }
}

/// The four the tab bar carries. Apps are never tabs — they are tiles.
enum ShellTab: String, CaseIterable, Hashable {
  case home, orders, wallet, profile

  var title: String {
    switch self {
    case .home: "Нүүр"
    case .orders: "Захиалга"
    case .wallet: "Түрийвч"
    case .profile: "Профайл"
    }
  }

  var mark: ShellMark {
    switch self {
    case .home: .home
    case .orders: .orders
    case .wallet: .wallet
    case .profile: .profile
    }
  }
}

/// Where the app opens, and the one place navigation is described.
///
/// Signed out, the app opens on the way in: no launcher behind it, no tab bar
/// over it — and under the doors, «Бүртгэлгүйгээр үзэх», which opens the
/// shell to look around without an account. App Review sends back an app that
/// asks for an account before its products can be seen (guideline 5.1.1(v),
/// 1.0.3 on 2026-09-26); the account is asked for at the order, the wallet
/// and the profile.
struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(Session.self) private var session
  @Environment(Platform.self) private var platform
  @Environment(AppLock.self) private var lock
  @Environment(\.scenePhase) private var phase

  @State private var tab: ShellTab = .home
  @State private var path: [Destination] = []
  @State private var splash = true
  @State private var debugPush = false
  @State private var debugPay: PayRequest?

  var body: some View {
    ZStack {
      if session.isSignedIn || model.browsing {
        shell
          .transition(.opacity)
      } else {
        SignInSheet(gate: true)
          .transition(.opacity)
      }

      // Over the shell, under the splash: away, the app switcher sees the
      // wordmark rather than a balance; locked, the face comes first.
      if session.isSignedIn && (lock.locked || lock.curtained) {
        LockView()
          .transition(.opacity)
          .zIndex(0.5)
      }

      if splash {
        SplashView()
          .transition(.opacity)
          .zIndex(1)
      }
    }
    .animation(.easeOut(duration: 0.25), value: session.isSignedIn)
    .animation(.easeOut(duration: 0.25), value: model.browsing)
    // Out and back in lands on the launcher, not on whatever the last
    // person left open.
    .onChange(of: session.isSignedIn) { _, signedIn in
      if signedIn {
        lock.admitted()
        // In now: signing out later lands on the way in, not on browsing.
        model.browsing = false
        // The token APNs gave at launch had nobody to belong to; now it has.
        Task { await PushRegistrar.shared.registerIfAllowed() }
      } else {
        tab = .home
        path = []
        // Nothing of the last person's stays on the lock screen or the widget.
        Task { await OrderActivity.shared.clear() }
      }
    }
    .onChange(of: phase) { _, now in
      switch now {
      case .background: lock.left(at: .now)
      case .active:
        lock.returned(at: .now)
        // Back from the bank app, perhaps: a top-up paid there shows now.
        Task { await platform.checkTopup() }
      default: break
      }
    }
    // Offline anywhere — the launcher, the way in — clears by itself once
    // the server answers again.
    .task(id: model.offline) { await model.watchWhileOffline() }
    .alert(
      "Нэвтэрлээ",
      isPresented: Binding(
        get: { model.notice != nil && session.isSignedIn && !splash },
        set: { if !$0 { model.notice = nil } },
      ),
    ) {
      Button("Ойлголоо", role: .cancel) {}
    } message: {
      Text(model.notice ?? "")
    }
    .onOpenURL { url in open(url) }
    .sheet(item: $debugPay) { request in
      QPaySheet(request: request, check: { false }) { debugPay = nil }
    }
    .sheet(isPresented: $debugPush) {
      PushAsk(audience: .guest) { debugPush = false }
    }
    .onChange(of: splash) { _, showing in
      if !showing, Self.debugAsksPush { debugPush = true }
      if !showing, debugPay == nil { debugPay = Self.debugPayment }
    }
    .task {
      // APNs answers whenever it answers — before a sign-in or long after it —
      // so the token is handed over on arrival rather than asked for at a moment.
      PushRegistrar.shared.onToken = { token in
        Task { await platform.registerPush(token: token) }
      }
      OrderActivity.shared.register = { subject, orderId, token in
        await platform.registerActivityToken(token, subject: subject, order: orderId)
      }
      // A phone that already said yes tells the server where it is now; one
      // that has not been asked is asked after its first order, not here.
      await PushRegistrar.shared.registerIfAllowed()
      Self.jumpForDebug(tab: &tab, path: &path)
      #if DEBUG
        if ProcessInfo.processInfo.environment["BASU_SCREEN"] == "activity" {
          await OrderActivity.shared.showSample()
        }
        if ProcessInfo.processInfo.environment["BASU_SCREEN"] == "idesh-activity" {
          await OrderActivity.shared.showIdeshSample()
        }
      #endif
      await Self.signInForDebug(model)
      // The splash lasts as long as the launch does, within limits: the floor
      // is so a fast launch does not flash, and the cap is so a stalled
      // network is not a minute of wordmark. Past the cap the launcher draws
      // what it has, and the live card and the offline banner arrive on
      // their own when the network does.
      let cap = Task {
        try? await Task.sleep(for: .milliseconds(1200))
        if !Task.isCancelled { lift() }
      }
      async let boot: Void = model.bootstrap()
      async let me: Void = platform.refresh()
      async let floor: Void = { try? await Task.sleep(for: .milliseconds(650)) }()
      _ = await (boot, me, floor)
      cap.cancel()
      lift()
    }
  }

  private func lift() {
    guard splash, !Self.debugHoldsSplash else { return }
    withAnimation(.easeOut(duration: 0.35)) { splash = false }
  }

  /// The launcher and the three it shares a bar with.
  private var shell: some View {
    // Read before the bottom edge is given up below: the floating bar sits a
    // fixed distance above the home indicator, and this is how far that is.
    GeometryReader { outer in
      ZStack(alignment: .bottom) {
        Color.bg.ignoresSafeArea()

        NavigationStack(path: $path) {
          surface
            .navigationDestination(for: Destination.self) { destination in
              switch destination {
              case .app(let id, let page):
                ServiceView(app: id, path: page, back: { if !path.isEmpty { path.removeLast() } })
              case .inbox:
                InboxView(
                  back: { if !path.isEmpty { path.removeLast() } },
                  open: { path.append($0) },
                )
              }
            }
        }

        // Drawn over the scrolling content rather than inset beside it: the
        // glass wants something to be translucent against, and content sliding
        // under it is the only thing that gives it that.
        //
        // It stays up over the inbox — that is still the shell, and the bell is
        // a detour rather than a departure. An app takes the whole screen.
        if !inApp {
          // Content fades out as it nears the bar rather than peeking round
          // both ends of the capsule. It takes no touches: what is under it
          // is still the page's.
          LinearGradient(
            stops: [
              .init(color: Color.bg.opacity(0), location: 0),
              .init(color: Color.bg.opacity(0.9), location: 0.55),
              .init(color: Color.bg, location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom,
          )
          .frame(height: outer.safeAreaInsets.bottom + 84)
          .allowsHitTesting(false)
          .accessibilityHidden(true)

          TabBar(tab: tab, bottom: outer.safeAreaInsets.bottom) { chosen in
            // A tab always lands on its own root: from the inbox, Түрийвч
            // shows the wallet rather than the inbox over it.
            path = []
            tab = chosen
          }
        }
      }
      // Content pads itself past the bar. The shell's alone: the way in keeps
      // the bottom edge, and the keyboard with it.
      .ignoresSafeArea(edges: .bottom)
    }
    .ignoresSafeArea(.keyboard, edges: .bottom)
  }

  /// True while a vertical owns the screen. The shell's own pushes do not
  /// count — the inbox keeps the bar, and keeps Нүүр lit under it.
  private var inApp: Bool {
    path.contains { if case .app = $0 { true } else { false } }
  }

  @ViewBuilder private var surface: some View {
    switch tab {
    case .home:
      HomeView(open: { path.append($0) }, showOrders: { tab = .orders })
    case .orders:
      OrdersView(open: { path.append($0) })
    case .wallet:
      WalletView()
    case .profile:
      ProfileView()
    }
  }

  /// `basu://order/{id}`, `basu://wallet`, `basu://notifications`, `basu://dine`.
  /// The Live Activity and both widgets link to the first.
  private func open(_ url: URL) {
    guard url.scheme == "basu" else { return }
    switch url.host {
    case "order":
      tab = .home
      if let id = url.pathComponents.dropFirst().first,
         let destination = AppCatalogue.food.destination(order: id) {
        path = [destination]
      } else if let destination = AppCatalogue.food.destination {
        path = [destination]
      }
    case "idesh":
      // The идэш lock screen card: straight to that order on the page.
      tab = .home
      if let id = url.pathComponents.dropFirst().first,
         let destination = AppCatalogue.idesh.destination(order: id) {
        path = [destination]
      } else if let destination = AppCatalogue.idesh.destination {
        path = [destination]
      }
    case "dine":
      tab = .home
      if let destination = AppCatalogue.food.destination { path = [destination] }
    case "wallet":
      path = []
      tab = .wallet
    case "notifications":
      tab = .home
      path = [.inbox]
    default:
      break
    }
  }

  // MARK: - the design pass

  /// `BASU_SCREEN=orders|wallet|profile|inbox|splash|food|idesh|signin|push|activity|idesh-activity` lands the app
  /// on a screen so the pass — and the store's pictures — can photograph it.
  /// `BASU_BROWSE=1` with `signin` looks around signed out instead of stopping
  /// at the way in. Debug only; production has no such door.
  private static func jumpForDebug(tab: inout ShellTab, path: inout [Destination]) {
    #if DEBUG
      switch ProcessInfo.processInfo.environment["BASU_SCREEN"] {
      case "orders": tab = .orders
      case "wallet": tab = .wallet
      case "profile": tab = .profile
      case "inbox": path = [.inbox]
      case "food": path = [AppCatalogue.food.destination].compactMap { $0 }
      case "idesh": path = [AppCatalogue.idesh.destination].compactMap { $0 }
      default: break
      }
    #endif
  }

  /// `BASU_DEMO_SIGNIN=1` signs the demo guest in before the first draw, so
  /// the pass photographs the shell rather than the way in. `BASU_SCREEN=signin`
  /// is the opposite: whoever an earlier run left signed in is signed out.
  private static func signInForDebug(_ model: AppModel) async {
    #if DEBUG
      let environment = ProcessInfo.processInfo.environment
      if environment["BASU_SCREEN"] == "signin" || environment["BASU_BROWSE"] == "1" {
        model.session.signOut()
        model.browsing = environment["BASU_BROWSE"] == "1"
        return
      }
      guard environment["BASU_DEMO_SIGNIN"] == "1" else { return }
      // `BASU_DEMO_PHONE` picks whose account: the store's pictures use one
      // with nobody else's business in it.
      let phone = environment["BASU_DEMO_PHONE"] ?? "+97699001122"
      if model.session.isSignedIn, model.session.phone == phone { return }
      model.session.signOut()
      try? await model.session.demoSignIn(phone: phone)
    #endif
  }

  private static var debugHoldsSplash: Bool {
    #if DEBUG
      ProcessInfo.processInfo.environment["BASU_SCREEN"] == "splash"
    #else
      false
    #endif
  }

  /// `BASU_SCREEN=qpay`: the payment sheet over the launcher, with QPay's
  /// banks as Wire listed them on 2026-10-05 and a QR that pays nothing.
  fileprivate static var debugPayment: PayRequest? {
    #if DEBUG
      let environment = ProcessInfo.processInfo.environment
      guard environment["BASU_SCREEN"] == "qpay" else { return nil }
      // `BASU_QPAY_BANKS=n`: the first n only, to photograph what is under them.
      let shown = Int(environment["BASU_QPAY_BANKS"] ?? "") ?? .max
      return PayRequest(id: "debug", amountMnt: 460_000, invoice: QPayInvoice(
        qr: "BASU-DEMO",
        banks: Array([
          .init(name: "qPay wallet", description: "qPay хэтэвч", logo: "https://s3.qpay.mn/p/e9bbdc69-3544-4c2f-aff0-4c292bc094f6/launcher-icon-ios.jpg", link: "qpaywallet://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Khan bank", description: "Хаан банк", logo: "https://qpay.mn/q/logo/khanbank.png", link: "khanbank://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "State bank 3.0", description: "Төрийн банк 3.0", logo: "https://qpay.mn/q/logo/state_3.png", link: "statebankmongolia://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Xac bank", description: "Хас банк", logo: "https://qpay.mn/q/logo/xacbank.png", link: "xacbank://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Trade and Development bank", description: "TDB online", logo: "https://qpay.mn/q/logo/tdbbank.png", link: "tdbbank://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Social Pay", description: "Голомт банк", logo: "https://qpay.mn/q/logo/socialpay.png", link: "socialpay-payment://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Most money", description: "МОСТ мони", logo: "https://qpay.mn/q/logo/most.png", link: "most://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "National investment bank", description: "Үндэсний хөрөнгө оруулалтын банк", logo: "https://qpay.mn/q/logo/nibank.jpeg", link: "nibank://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Chinggis khaan bank", description: "Чингис Хаан банк", logo: "https://qpay.mn/q/logo/ckbank.png", link: "ckbank://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Capitron bank", description: "Капитрон банк", logo: "https://qpay.mn/q/logo/capitronbank.png", link: "capitronbank://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Bogd bank", description: "Богд банк", logo: "https://qpay.mn/q/logo/bogdbank.png", link: "bogdbank://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Trans bank", description: "Тээвэр хөгжлийн банк", logo: "https://qpay.mn/q/logo/transbank.png", link: "transbank://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "M bank", description: "М банк", logo: "https://qpay.mn/q/logo/mbank.png", link: "mbank://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Ard App", description: "Ард Апп", logo: "https://qpay.mn/q/logo/ard.png?v=2", link: "ard://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Toki App", description: "Toki App", logo: "https://qpay.mn/q/logo/tokipay.png", link: "toki://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Arig bank", description: "Ариг банк", logo: "https://qpay.mn/q/logo/arig.png", link: "arig://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Monpay", description: "Мон Пэй", logo: "https://qpay.mn/q/logo/monpay.png", link: "monpay://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Hipay", description: "Hipay", logo: "https://qpay.mn/q/logo/hipay.png", link: "hipay://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Happy Pay", description: "Happy Pay MN", logo: "https://qpay.mn/q/logo/tdbwallet.png", link: "tdbwallet://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Sono", description: "Sono", logo: "https://qpay.mn/q/logo/sono.png", link: "sono://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "PayOn", description: "PayOn", logo: "https://qpay.mn/q/logo/payon.png", link: "payon://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Tino", description: "Tino", logo: "https://qpay.mn/q/logo/tino.png", link: "tino://q?qPay_QRcode=BASU-DEMO"),
          .init(name: "Pass.mn", description: "Pass.mn", logo: "https://qpay.mn/q/logo/pass.png", link: "pass://q?qPay_QRcode=BASU-DEMO"),
        ].prefix(shown)),
        expiresAt: Date.now.addingTimeInterval(15 * 60),
      ))
    #else
      nil
    #endif
  }

  /// `BASU_SCREEN=push`: the push pre-prompt over the launcher, so the pass
  /// can photograph a screen that otherwise waits for a first order.
  fileprivate static var debugAsksPush: Bool {
    #if DEBUG
      ProcessInfo.processInfo.environment["BASU_SCREEN"] == "push"
    #else
      false
    #endif
  }
}

/**
 The splash. The wordmark in the display face, a gold rule, and the city — no
 logo file, no spinner, no progress text. It sits over the launcher and fades
 to reveal it, on the same charcoal, so there is no jump between the two.
 */
struct SplashView: View {
  var body: some View {
    ZStack {
      Color.bg.ignoresSafeArea()
      VStack(spacing: 16) {
        Text("Basu")
          .font(.display(64))
          .foregroundStyle(Color.ink)
        RoundedRectangle(cornerRadius: 1, style: .continuous)
          .fill(Color.gold)
          .frame(width: 34, height: 2)
      }
      VStack {
        Spacer()
        Text("УЛААНБААТАР")
          .font(.sans(12, .bold))
          .tracking(12 * 0.18)
          .foregroundStyle(Color.ink3)
          .padding(.bottom, 44)
      }
    }
    // Centred on the whole screen, status bar included, the way it is drawn.
    .ignoresSafeArea()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Basu")
    .accessibilityIdentifier("splash")
  }
}

/**
 The bar: a dark glass capsule floating just above the home indicator, four
 tabs of equal width, each its mark over its name; the chosen one is an
 off-white pill with dark words on it.

 It carries the shell and nothing else — the apps are tiles on the launcher,
 never tabs. The pill slides between tabs and the phone ticks as it lands —
 or, with Reduce Motion on, fades from one tab to the next without
 travelling. To VoiceOver the bar is one tab bar, «1 of 4» and so on, rather
 than four loose buttons.
 */
struct TabBar: View {
  let tab: ShellTab
  /// The screen's bottom safe area: the bar floats this far up, less a little.
  let bottom: CGFloat
  let select: (ShellTab) -> Void
  @Namespace private var lit
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    HStack(spacing: 0) {
      ForEach(ShellTab.allCases, id: \.self) { item in
        let active = item == tab
        Button {
          withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.34, dampingFraction: 0.82)) {
            select(item)
          }
        } label: {
          VStack(spacing: 4) {
            ShellGlyph(mark: item.mark, size: 22, lineWidth: active ? 1.9 : 1.75)
            Text(item.title)
              .font(.sans(11, .bold))
              .lineLimit(1)
              .minimumScaleFactor(0.8)
          }
          .foregroundStyle(active ? Color.onLight : Color.ink3)
          .frame(maxWidth: .infinity)
          .frame(height: 56)
          .background {
            if active {
              if reduceMotion {
                Capsule().fill(Color.ink)
                  .transition(.opacity)
              } else {
                Capsule().fill(Color.ink)
                  .matchedGeometryEffect(id: "lit", in: lit)
              }
            }
          }
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("tab.\(item.rawValue)")
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(active ? [.isSelected] : [])
      }
    }
    .padding(6)
    .background {
      ZStack {
        Capsule().fill(.ultraThinMaterial)
        Capsule().fill(BasuColor.bar)
      }
      .shadow(color: .barShadow, radius: 24, y: 16)
    }
    .overlay(Capsule().strokeBorder(BasuColor.barEdge, lineWidth: BasuMetric.hairline))
    // The pill is 56 tall; past this the names no longer fit inside it.
    .dynamicTypeSize(...DynamicTypeSize.xLarge)
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isTabBar)
    .padding(.horizontal, 16)
    .padding(.bottom, max(bottom - 4, 14))
    .sensoryFeedback(.selection, trigger: tab)
  }
}

enum Destination: Hashable {
  /// An app: its id from `AppCatalogue`, and the page to open — `/dine`, or
  /// `/dine?order=…` when the launcher sends somebody straight to the order
  /// they already have rather than to a map they have to search.
  case app(id: String, path: String)

  /// Reached from the bell, and pushed over the launcher rather than given a
  /// tab — an inbox is somewhere you go back from, not somewhere you live.
  case inbox
}
