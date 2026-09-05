import Foundation

/**
 What the whole app knows: who is signed in, what a dish looks like, and what
 of the guest's is currently running.

 Everything below this is a screen's own business. The rule is the same one the
 web pages follow — the launcher never creates a session, so a person who has
 only opened the app has an account nowhere.
 */
@MainActor
@Observable
final class AppModel {
  let api: API
  let session: Session

  /// How to draw the nine forms, fetched once. Menus are chosen with the eyes
  /// and a row with a hole in it does not sell lunch, so this loads before the
  /// first menu is opened and is never invalidated: the table is a constant.
  private(set) var dishes = DishTable(fallback: .init(form: .soup, fill: "#B98A52", detail: "#EFE3CC", ground: "#EBE5D9"), dishes: [:])

  private(set) var live: [LiveOrder] = []
  private(set) var liveIdesh: [LiveIdesh] = []
  private(set) var trouble: String?

  /// Whether the last call reached the server at all.
  ///
  /// An empty map and an unreachable server look the same — nothing — and the
  /// difference is the whole of what to do next. Worth one flag.
  private(set) var offline = false

  /// Demo mode only: the server's idea of what time it is.
  private(set) var clockLabel: String?
  private(set) var clockIsControllable = false

  init(api: API = API(), session: Session? = nil) {
    self.api = api
    self.session = session ?? Session(api: api)
  }

  func bootstrap() async {
    offline = await !api.reachable()
    async let table = try? api.dishes()
    if let table = await table { dishes = table }
    await refreshLive()
    await readClock()
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

  /// The guest's live orders, if there is a guest. Two calls, one per
  /// vertical: the launcher is the one place that knows there are two.
  func refreshLive() async {
    guard let token = session.token else {
      live = []
      liveIdesh = []
      return
    }
    async let lunches = api.liveOrders(token: token)
    async let provisions = api.liveIdesh(token: token)
    do {
      live = try await lunches
      noted(nil)
    } catch let error as APIError where error.isUnauthorised {
      // A token from a reseeded database is dead, not a reason to shout at
      // somebody who has only just opened the app.
      session.forget()
      live = []
      liveIdesh = []
      return
    } catch {
      noted(error)
      live = []
    }
    // A server that predates the second vertical answers 404 here; that is
    // an empty list, not an outage.
    liveIdesh = (try? await provisions) ?? []
  }

  func readClock() async {
    clockLabel = try? await api.clock()
    clockIsControllable = clockLabel != nil
  }

  /// Move the kitchen's idea of time, then let the scheduler act on it —
  /// otherwise time moves and nothing happens.
  func setClock(to label: String) async {
    try? await api.setClock(to: label)
    try? await api.tick()
    await readClock()
    await refreshLive()
  }

  func advanceClock(minutes: Int) async {
    try? await api.advanceClock(minutes: minutes)
    try? await api.tick()
    await readClock()
    await refreshLive()
  }

  func runScheduler() async {
    try? await api.tick()
    await readClock()
    await refreshLive()
  }

  func say(_ trouble: String?) { self.trouble = trouble }
}
