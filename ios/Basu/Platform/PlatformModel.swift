import Foundation
import UIKit

/**
 The shell's own state: profile, wallet, inbox.

 Separate from `AppModel` on purpose. `AppModel` knows about dishes and live
 orders — those are dine's. This knows about a person and their money, which is
 every app inside Basu's business and none of them in particular. When there is
 a second app on the launcher, it reads this one and does not learn a thing
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

  /// Set while a top-up is in flight, so the button can say so.
  private(set) var toppingUp = false
  private(set) var trouble: String?

  private let api: API
  private let session: Session

  init(api: API, session: Session) {
    self.api = api
    self.session = session
  }

  var balanceMnt: Int { me?.wallet.balanceMnt ?? wallet.balanceMnt }
  var unread: Int { max(me?.unread ?? 0, inbox.unread) }
  var isSignedIn: Bool { session.isSignedIn }

  /// The launcher's one call. Cheap enough to make on every appearance.
  func refresh() async {
    guard let token = session.token else {
      me = nil
      wallet = .empty
      inbox = .empty
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
      trouble = nil
    } catch {
      note(error)
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

  /**
   Close the account.

   The server refuses while the wallet holds money or something is still
   running, and says which in Mongolian — so the refusal is shown rather than
   guessed at here. Returns whether it went through.
   */
  func closeAccount() async -> Bool {
    guard let token = session.token else { return false }
    do {
      try await api.closeAccount(token: token)
      session.signOut()
      me = nil
      wallet = .empty
      inbox = .empty
      sessions = []
      trouble = nil
      return true
    } catch {
      note(error)
      return false
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
      await loadWallet()
      await refresh()
      return true
    } catch {
      note(error)
      return false
    }
  }

  func markAllRead() async {
    guard let token = session.token, unread > 0 else { return }
    try? await api.markRead(nil, token: token)
    await loadInbox()
    await refresh()
  }

  func markRead(_ message: InboxMessage) async {
    guard let token = session.token, !message.read else { return }
    try? await api.markRead(message.id, token: token)
    await loadInbox()
    await refresh()
  }

  func save(displayName: String?, locale: String?) async {
    guard let token = session.token else { return }
    do {
      me = try await api.updateProfile(displayName: displayName, locale: locale, token: token)
      trouble = nil
    } catch {
      note(error)
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

  private func note(_ error: Error) {
    trouble = (error as? APIError)?.message ?? "Алдаа гарлаа."
  }
}
