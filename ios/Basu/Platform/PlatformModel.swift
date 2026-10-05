import Foundation
import UIKit

/**
 The shell's own state: profile, wallet, inbox.

 Separate from `AppModel` on purpose. `AppModel` knows what of the guest's is
 running — that is the apps'. This knows about a person and their money, which
 is every app inside Basu's business and none of them in particular. When there
 is a second app on the launcher, it reads this one and does not learn a thing
 about lunch.
 */
@MainActor
@Observable
final class Platform {
  private(set) var me: Me?
  private(set) var wallet: WalletStatement = .empty
  private(set) var inbox: Inbox = .empty
  private(set) var preferences: NotifyPreferences = .default
  private(set) var sessions: [DeviceSession] = []
  /// Set while a page of the statement is on its way, so the button can say so.
  private(set) var loadingMore = false
  /// Whether any call has actually told us the balance. Until one has, the
  /// wallet shows nothing where the number goes — never a zero.
  private(set) var walletLoaded = false

  /// Set while a top-up is in flight, so the button can say so.
  private(set) var toppingUp = false
  private(set) var trouble: String?

  /**
   Whether money can come in at all.

   A production server with no payment key says no to every top-up, and its
   no ends in a promise («Удахгүй нээгдэнэ») this app does not make. The
   wallet's own answer says so up front when the server sends `topups_open`;
   until it does, the first refusal is remembered — for a day, so the
   amounts come back by themselves once payments open — and the wallet stops
   offering a door that does not open.
   */
  private(set) var topupsOpen: Bool

  private let api: API
  private let session: Session
  private let defaults: UserDefaults

  init(api: API, session: Session, defaults: UserDefaults = .standard) {
    let key = "wallet.topupsClosedAt.\(api.base.host ?? ""):\(api.base.port ?? 443)"
    self.api = api
    self.session = session
    self.defaults = defaults
    closedKey = key
    topupsOpen = !Self.refusalRemembered(defaults.object(forKey: key) as? Date)
  }

  /// Per server: a developer's own one takes money that the pilot does not.
  private let closedKey: String

  /// A refusal younger than a day still stands.
  nonisolated static func refusalRemembered(_ at: Date?, now: Date = .now) -> Bool {
    guard let at else { return false }
    return now.timeIntervalSince(at) < 24 * 60 * 60
  }

  var balanceMnt: Int { me?.wallet.balanceMnt ?? wallet.balanceMnt }
  var balanceKnown: Bool { me != nil || walletLoaded }
  var unread: Int { max(me?.unread ?? 0, inbox.unread) }
  var isSignedIn: Bool { session.isSignedIn }

  /// The launcher's one call. Cheap enough to make on every appearance.
  func refresh() async {
    guard let token = session.token else {
      me = nil
      wallet = .empty
      inbox = .empty
      walletLoaded = false
      return
    }
    do {
      me = try await api.me(token: token)
      trouble = nil
    } catch let error as APIError where error.isUnauthorised {
      session.forget()
      me = nil
    } catch {
      // A launcher that cannot reach the server still has to draw. The last
      // known balance is better than a dash, and `AppModel.offline` is already
      // saying out loud that this is stale.
      note(error)
    }
  }

  func loadWallet() async {
    guard let token = session.token else { return }
    do {
      wallet = try await api.wallet(token: token)
      walletLoaded = true
      trouble = nil
      // The server's word, when it gives one, outranks what was remembered.
      if let open = wallet.topupsOpen { noteTopups(open: open) }
    } catch {
      note(error)
    }
  }

  private func noteTopups(open: Bool) {
    topupsOpen = open
    if open {
      defaults.removeObject(forKey: closedKey)
    } else {
      defaults.set(Date.now, forKey: closedKey)
    }
  }

  /**
   The next page of the statement.

   Keyed on the last line rather than an offset: entries are append-only, so a
   page cannot shift under somebody who is scrolling while a refund lands.
   */
  func loadMoreWallet() async {
    guard let token = session.token, let cursor = wallet.next, !loadingMore else { return }
    loadingMore = true
    defer { loadingMore = false }
    do {
      let page = try await api.wallet(token: token, before: cursor)
      wallet = WalletStatement(
        balanceMnt: page.balanceMnt,
        currency: page.currency,
        lines: wallet.lines + page.lines,
        next: page.next,
        topupsOpen: page.topupsOpen,
      )
    } catch {
      note(error)
    }
  }

  func movement(_ id: String) async -> Movement? {
    guard let token = session.token else { return nil }
    do {
      return try await api.movement(id, token: token)
    } catch {
      note(error)
      return nil
    }
  }

  /* ── where you are signed in ─────────────────────────────────────── */

  func loadSessions() async {
    guard let token = session.token else { return }
    do {
      sessions = try await api.sessions(token: token)
      trouble = nil
    } catch {
      note(error)
    }
  }

  /**
   Out on this phone, and on the server too.

   The phone forgets its token at once, so the way in is on screen without
   waiting for the network; the session it named is ended behind that, with
   the token kept in hand for the one call. Left alone it stayed on the
   server for sixty days, and every sign-out and sign-in added one more row
   to «Нэвтэрсэн төхөөрөмж».
   */
  func signOut() {
    let token = session.token
    session.signOut()
    sessions = []
    guard let token else { return }
    let api = self.api
    Task {
      guard let mine = try? await api.sessions(token: token).first(where: \.current) else { return }
      try? await api.revokeSession(mine.id, token: token)
    }
  }

  @discardableResult
  func signOutOtherDevices() async -> Int {
    guard let token = session.token else { return 0 }
    do {
      let revoked = try await api.revokeOtherSessions(token: token)
      await loadSessions()
      return revoked
    } catch {
      note(error)
      return 0
    }
  }

  func signOutDevice(_ device: DeviceSession) async {
    guard let token = session.token, !device.current else { return }
    do {
      try await api.revokeSession(device.id, token: token)
      await loadSessions()
    } catch {
      note(error)
    }
  }

  /* ── the ways back in ────────────────────────────────────────────── */
  //
  // These throw rather than setting `trouble`: each is a step in a sheet of
  // its own, and the refusal belongs beside the field it is about, not at
  // the foot of the profile under the sheet.

  /// A code to the address, for an account that has none. `password` is the
  /// current one, when the account has one.
  func requestEmailCode(_ email: String, password: String?) async throws {
    try await api.attachEmailCode(email: Session.address(email), password: password, token: bearer())
  }

  /// The code from the letter: the address is the account's, and the
  /// profile says so.
  func attachEmail(_ email: String, code: String) async throws {
    try await api.attachEmail(email: Session.address(email), code: code, token: bearer())
    await refresh()
  }

  /// A code for the first password, to the address on the account. Returns
  /// where it went.
  func requestPasswordCode() async throws -> String {
    try await api.firstPasswordCode(token: bearer())
  }

  /// Returns how many other devices it signed out; the list catches up. The
  /// first password comes with the code from its letter, and no `current`.
  func changePassword(current: String?, next: String, code: String? = nil) async throws -> Int {
    let revoked = try await api.changePassword(current: current, next: next, code: code, token: bearer())
    await refresh()
    await loadSessions()
    return revoked
  }

  private func bearer() throws -> String {
    guard let token = session.token else {
      throw APIError(status: 401, code: "UNAUTHORIZED", message: "Нэвтэрч орно уу.")
    }
    return token
  }

  /**
   Close the account.

   The server refuses while the wallet holds money or something is still
   running, and says which in Mongolian — so the refusal is shown rather than
   guessed at here. Returns nil once it is closed, or that refusal, for the
   profile to put in front of the person rather than at the foot of a page.
   */
  func closeAccount() async -> String? {
    guard let token = session.token else { return nil }
    do {
      try await api.closeAccount(token: token)
      session.signOut()
      me = nil
      wallet = .empty
      inbox = .empty
      sessions = []
      trouble = nil
      return nil
    } catch {
      return (error as? APIError)?.message ?? "Бүртгэлийг хааж чадсангүй. Дахин оролдоно уу."
    }
  }

  func loadInbox() async {
    guard let token = session.token else { return }
    do {
      inbox = try await api.inbox(token: token)
      trouble = nil
    } catch {
      note(error)
    }
  }

  func loadPreferences() async {
    guard let token = session.token else { return }
    if let loaded = try? await api.notifyPreferences(token: token) { preferences = loaded }
  }

  /**
   Money in.

   Two steps, because they are two different things: asking the provider for
   the money, and the money arriving. In production QPay's callback settles it
   and this poll is a courtesy to a guest who came back faster than the webhook;
   against the demo provider there is nothing to open, so it settles at once.
   Both paths are safe — settling twice credits once.
   */
  func topUp(amountMnt: Int) async -> Bool {
    guard let token = session.token else { return false }
    toppingUp = true
    trouble = nil
    defer { toppingUp = false }

    do {
      let started = try await api.startTopup(amountMnt: amountMnt, token: token)
      if let raw = started.actionUrl, let url = URL(string: raw),
         UIApplication.shared.canOpenURL(url) {
        await UIApplication.shared.open(url)
      }
      _ = try await api.settleTopup(started.topupId, token: token)
      noteTopups(open: true)
      await loadWallet()
      await refresh()
      return true
    } catch let error as APIError where error.code == "PAYMENTS_CLOSED" {
      // Not a failure of this tap, and not a thing to try again: the wallet
      // says plainly that money cannot come in, and stops offering it.
      noteTopups(open: false)
      return false
    } catch {
      note(error)
      return false
    }
  }

  /// The swipe. Gone from the list at once; the server is told after, and a
  /// refusal puts it back rather than leaving a hole nobody explained.
  func delete(_ message: InboxMessage) async {
    guard let token = session.token else { return }
    let kept = inbox
    inbox = Inbox(
      unread: message.read ? inbox.unread : max(0, inbox.unread - 1),
      messages: inbox.messages.filter { $0.id != message.id },
    )
    do {
      try await api.deleteMessage(message.id, token: token)
      await refresh()
    } catch {
      inbox = kept
      note(error)
    }
  }

  func markRead(_ message: InboxMessage) async {
    guard let token = session.token, !message.read else { return }
    try? await api.markRead(message.id, token: token)
    await loadInbox()
    await refresh()
  }

  /// Returns whether it was kept, so the sheet it came from stays open with
  /// the refusal rather than closing over it.
  @discardableResult
  func save(displayName: String?, locale: String?) async -> Bool {
    guard let token = session.token else { return false }
    do {
      me = try await api.updateProfile(displayName: displayName, locale: locale, token: token)
      trouble = nil
      return true
    } catch {
      note(error)
      return false
    }
  }

  func setPreference(push: Bool? = nil, sms: Bool? = nil, marketing: Bool? = nil) async {
    guard let token = session.token else { return }
    // Move the switch first: a toggle that waits for the network before it
    // budges reads as broken, and the reload below puts it back if it failed.
    if let push { preferences.push = push }
    if let sms { preferences.sms = sms }
    if let marketing { preferences.marketing = marketing }
    do {
      preferences = try await api.setNotifyPreferences(
        push: push, sms: sms, marketing: marketing, token: token,
      )
    } catch {
      note(error)
      await loadPreferences()
    }
  }

  /// Called when APNs hands us a token. Silent: a guest who has not signed in
  /// has nothing to attach it to, and will register on their next launch.
  func registerPush(token pushToken: String) async {
    guard let session = session.token else { return }
    try? await api.registerPushToken(pushToken, label: UIDevice.current.name, token: session)
  }

  /// ActivityKit's token for one order's lock screen card.
  func registerActivityToken(_ pushToken: String, subject: String, order orderId: String) async {
    guard let session = session.token else { return }
    try? await api.registerActivityToken(pushToken, subject: subject, order: orderId, token: session)
  }

  private func note(_ error: Error) {
    // A screen that left before its answer came has nothing to be told.
    guard !(error is CancellationError) else { return }
    trouble = (error as? APIError)?.message ?? APIError.fallback
  }
}
