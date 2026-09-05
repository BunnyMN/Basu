import Foundation

/**
 What the whole app knows: who is signed in, and what of the guest's is
 currently running.

 Everything else is a screen's own business, or a service's. The rule is the
 same one the web pages follow — the launcher never creates a session, so a
 person who has only opened the app has an account nowhere.
 */
@MainActor
@Observable
final class AppModel {
  let api: API
  let session: Session

  private(set) var live: [LiveOrder] = []
  private(set) var trouble: String?

  /// Whether the last call reached the server at all.
  ///
  /// An empty launcher and an unreachable server look the same — nothing —
  /// and the difference is the whole of what to do next. Worth one flag.
  private(set) var offline = false

  init(api: API = API(), session: Session? = nil) {
    self.api = api
    self.session = session ?? Session(api: api)
  }

  func bootstrap() async {
    offline = await !api.reachable()
    await refreshLive()
  }

  /// Ask again, after the person holding the phone has done something about it.
  func retry() async {
    offline = await !api.reachable()
    if !offline { await bootstrap() }
  }

  /// Every call that lands says so, and every one that never arrives says that.
  func noted(_ error: Error?) {
    guard let error else {
      offline = false
      return
    }
    if let api = error as? APIError, api.code == "OFFLINE" { offline = true }
  }

  /// The guest's live orders, if there is a guest.
  ///
  /// This is the shell's one view of what a service is doing: the launcher's
  /// ИДЭВХТЭЙ card, the lock screen and the widget all come from it. A
  /// service inside its web view tells the shell when something changed, and
  /// `ServiceView` asks on a timer besides, so the card outside is never far
  /// behind the page inside.
  func refreshLive() async {
    guard let token = session.token else {
      live = []
      return
    }
    do {
      live = try await api.liveOrders(token: token)
      noted(nil)
      OrderActivity.shared.sync(live: live)
    } catch let error as APIError where error.isUnauthorised {
      // A token from a reseeded database is dead, not a reason to shout at
      // somebody who has only just opened the app.
      session.forget()
      live = []
    } catch {
      noted(error)
      live = []
    }
  }

  func say(_ trouble: String?) { self.trouble = trouble }
}
