import SwiftUI

/**
 Basu — one app, several things inside it.

 The home screen is a launcher and owns no domain logic. The first icon on it
 is dine-in pre-order, which is the product this repository is about; the
 second one will be a new entry in `HomeView.apps` and nothing else.

 Beside the launcher sit three things that belong to no app in particular —
 profile, wallet and inbox. They are the shell's, they live in `Platform/`, and
 the second app inside Basu gets all three without writing any of them.
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

/// Where the app opens, and the one place navigation is described.
struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(Platform.self) private var platform
  @State private var path = NavigationPath()

  var body: some View {
    NavigationStack(path: $path) {
      HomeView(open: { path.append($0) })
        .navigationDestination(for: Destination.self) { destination in
          switch destination {
          case .dine(let orderId):
            DineView(resuming: orderId)
          case .wallet:
            WalletView()
          case .inbox:
            InboxView()
          case .profile:
            ProfileView()
          }
        }
    }
    .task {
      // APNs can answer before or after somebody signs in, so the token is
      // handed over whenever it arrives rather than asked for at a moment.
      PushRegistrar.shared.onToken = { token in
        Task { await platform.registerPush(token: token) }
      }
      await model.bootstrap()
      await platform.refresh()
    }
  }
}

enum Destination: Hashable {
  /// `orderId` is the deep link: the home screen sends somebody straight to
  /// the order they already have, rather than to a map they have to search.
  case dine(orderId: String?)

  /// The shell's own three. Not apps — every app has them.
  case wallet
  case inbox
  case profile
}
