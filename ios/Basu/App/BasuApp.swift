import SwiftUI

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
    }
    .task {
      // APNs answers whenever it answers — before a sign-in or long after it —
      // so the token is handed over on arrival rather than asked for at a moment.
      PushRegistrar.shared.onToken = { token in
        Task { await platform.registerPush(token: token) }
      }
      await model.bootstrap()
      await platform.refresh()
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
      WalletView(back: { tab = .home })
    case .profile:
      ProfileView(back: { tab = .home })
    }
  }
}

/**
 The bar. Glass, a hairline on top, 78 points tall.

 It carries the shell and nothing else. The launcher used to hold a wallet strip
 as well; at nine icons there was no room for both, and the strip and this tab
 were the same tap twice — so the balance is one tap away rather than visible on
 arrival. That is a real trade against the brief, made once, on purpose.
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
          VStack(spacing: 5) {
            ShellGlyph(mark: item.mark, size: 23)
            Text(item.title)
              .font(.system(size: 10, weight: active ? .semibold : .medium))
          }
          .foregroundStyle(active ? Color.accent : Color.ink3)
          .frame(maxWidth: .infinity, minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("tab.\(item.rawValue)")
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(active ? [.isSelected] : [])
      }
    }
    .padding(.horizontal, 8)
    .padding(.top, 10)
    .frame(height: 78, alignment: .top)
    .background(.ultraThinMaterial)
    .overlay(alignment: .top) { Hairline() }
    .ignoresSafeArea(edges: .bottom)
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
