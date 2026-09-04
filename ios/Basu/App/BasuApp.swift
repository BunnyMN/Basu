import BasuKit
import SwiftUI
import WidgetKit

/**
 Basu — a launcher, and the things that arrive inside it.

 The home screen owns no domain logic: it is a list of icons, whatever of the
 guest's is running, and a way into the three things every app shares. Today
 there is one icon. The second is one entry in `AppCatalogue` and one
 `Destination` case, and nothing else on this screen changes — which is the
 whole of what "shell" means here.

 Wallet, notifications and profile are not apps. They are the shell's, they are
 in `Platform/`, and a second vertical gets all three without writing any of it.
 */
@main
struct BasuApp: App {
  @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
  @State private var model: AppModel
  @State private var platform: Platform

  init() {
    let model = AppModel()
    _model = State(initialValue: model)
    _platform = State(initialValue: Platform(api: model.api, session: model.session))
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .environment(model.session)
        .environment(platform)
        .tint(.accent)
    }
  }
}

/// The three the tab bar carries. Apps are never tabs — they stay in the grid.
enum ShellTab: String, CaseIterable, Hashable {
  case home, wallet, profile

  var title: String {
    switch self {
    case .home: "Нүүр"
    case .wallet: "Түрийвч"
    case .profile: "Профайл"
    }
  }

  var mark: ShellMark {
    switch self {
    case .home: .home
    case .wallet: .wallet
    case .profile: .profile
    }
  }
}

/// Where the app opens, and the one place navigation is described.
struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(Platform.self) private var platform

  @State private var tab: ShellTab = .home
  @State private var path: [Destination] = []
  @State private var splash = true

  var body: some View {
    ZStack(alignment: .bottom) {
      LinearGradient.ground.ignoresSafeArea()

      NavigationStack(path: $path) {
        surface
          .navigationDestination(for: Destination.self) { destination in
            switch destination {
            case .dine(let orderId):
              DineView(resuming: orderId)
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
        TabBar(tab: $tab)
      }

      if splash {
        SplashView()
          .transition(.opacity)
          .zIndex(1)
      }
    }
    // The bar is 66 from the screen's bottom edge, home indicator included —
    // not 66 above the safe area. Content pads itself past it.
    .ignoresSafeArea(edges: .bottom)
    .onOpenURL { url in open(url) }
    .task {
      // APNs answers whenever it answers — before a sign-in or long after it —
      // so the token is handed over on arrival rather than asked for at a moment.
      PushRegistrar.shared.onToken = { token in
        Task { await platform.registerPush(token: token) }
      }
      OrderActivity.shared.register = { orderId, token in
        await platform.registerActivityToken(token, order: orderId)
      }
      Self.jumpForDebug(tab: &tab, path: &path)
      await Self.signInForDebug(model)
      async let boot: Void = model.bootstrap()
      async let me: Void = platform.refresh()
      // The splash lasts as long as the launch does and not a moment longer;
      // the floor is so a fast launch does not flash.
      async let floor: Void = { try? await Task.sleep(for: .milliseconds(650)) }()
      _ = await (boot, me, floor)
      if !Self.debugHoldsSplash {
        withAnimation(.easeOut(duration: 0.35)) { splash = false }
      }
    }
  }

  /// True while a vertical owns the screen. The shell's own pushes do not
  /// count — the inbox keeps the bar, and keeps Нүүр lit under it.
  private var inApp: Bool {
    path.contains { if case .dine = $0 { true } else { false } }
  }

  @ViewBuilder private var surface: some View {
    switch tab {
    case .home:
      HomeView(open: { path.append($0) })
    case .wallet:
      WalletView()
    case .profile:
      ProfileView(home: { tab = .home })
    }
  }

  /// `basu://order/{id}`, `basu://wallet`, `basu://notifications`, `basu://dine`.
  /// The Live Activity and both widgets link to the first.
  private func open(_ url: URL) {
    guard url.scheme == "basu" else { return }
    switch url.host {
    case "order":
      let id = url.pathComponents.dropFirst().first
      tab = .home
      path = [.dine(orderId: id)]
    case "dine":
      tab = .home
      path = [.dine(orderId: nil)]
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

  /// `BASU_SCREEN=wallet|profile|inbox|splash` lands the app on a screen so the
  /// pass can photograph it. Debug only; production has no such door.
  private static func jumpForDebug(tab: inout ShellTab, path: inout [Destination]) {
    #if DEBUG
      switch ProcessInfo.processInfo.environment["BASU_SCREEN"] {
      case "wallet": tab = .wallet
      case "profile": tab = .profile
      case "inbox": path = [.inbox]
      default: break
      }
    #endif
  }

  /// `BASU_DEMO_SIGNIN=1` signs the demo guest in before the first draw, so
  /// the pass photographs a launcher with a bell rather than a way in.
  private static func signInForDebug(_ model: AppModel) async {
    #if DEBUG
      guard ProcessInfo.processInfo.environment["BASU_DEMO_SIGNIN"] == "1",
            !model.session.isSignedIn else { return }
      try? await model.session.demoSignIn()
    #endif
  }

  private static var debugHoldsSplash: Bool {
    #if DEBUG
      ProcessInfo.processInfo.environment["BASU_SCREEN"] == "splash"
    #else
      false
    #endif
  }
}

/**
 The splash. The wordmark, a rule, and the city — no logo file, no spinner,
 no progress text. It sits over the launcher and fades to reveal it, so there
 is no jump between the two.
 */
struct SplashView: View {
  var body: some View {
    ZStack {
      LinearGradient.ground.ignoresSafeArea()
      VStack(spacing: 14) {
        Text("Basu")
          .font(.sans(44, .semibold))
          .tracking(-0.03 * 44)
          .foregroundStyle(Color.ink)
        RoundedRectangle(cornerRadius: 1, style: .continuous)
          .fill(Color.accent)
          .frame(width: 34, height: 2)
      }
      VStack {
        Spacer()
        Text("УЛААНБААТАР")
          .font(.mono(10.5))
          .tracking(0.16 * 10.5)
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
 The bar. Glass, a hairline on top, 66 points tall, icon only.

 It carries the shell and nothing else. The launcher used to hold a wallet strip
 as well; at nine icons there was no room for both, and the strip and this tab
 were the same tap twice — so the balance is one tap away rather than visible on
 arrival. That is a real trade against the brief, made once, on purpose.

 The labels came off with the same revision. The bar is icon-only, so the
 accessibility labels below are the only thing VoiceOver has.
 */
struct TabBar: View {
  @Binding var tab: ShellTab

  var body: some View {
    HStack(spacing: 0) {
      ForEach(ShellTab.allCases, id: \.self) { item in
        let active = item == tab
        Button {
          tab = item
        } label: {
          ShellGlyph(mark: item.mark, size: BasuMetric.tabGlyph)
            .foregroundStyle(active ? Color.accent : Color.ink3)
            .frame(maxWidth: .infinity, minHeight: BasuMetric.minTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("tab.\(item.rawValue)")
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(active ? [.isSelected] : [])
      }
    }
    .padding(.horizontal, 8)
    .padding(.top, 14 - (BasuMetric.minTarget - BasuMetric.tabGlyph) / 2)
    .frame(height: BasuMetric.tabBar, alignment: .top)
    .background(.ultraThinMaterial)
    .overlay(alignment: .top) { Hairline() }
  }
}

enum Destination: Hashable {
  /// `orderId` is the deep link: the launcher sends somebody straight to the
  /// order they already have, rather than to a map they have to search.
  case dine(orderId: String?)

  /// Reached from the bell, and pushed over the launcher rather than given a
  /// tab — an inbox is somewhere you go back from, not somewhere you live.
  case inbox
}
