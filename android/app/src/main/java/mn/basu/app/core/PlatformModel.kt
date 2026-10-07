package mn.basu.app.core

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/**
 * The shell's own state: profile, wallet, inbox.
 *
 * Separate from `AppModel` on purpose. `AppModel` knows what of the guest's
 * is running — that is the apps'. This knows about a person and their money,
 * which is every app inside Basu's business and none of them in particular.
 */
class Platform(private val api: Api, private val session: Session, private val context: Context) {
  private val prefs = context.getSharedPreferences("basu", Context.MODE_PRIVATE)
  /** Per server: a developer's own one takes money that the pilot does not. */
  private val closedKey = "wallet.topupsClosedAt.${Endpoint.key}"
  private val background = CoroutineScope(Dispatchers.Main)

  var me: Me? by mutableStateOf(null)
    private set
  var wallet: WalletStatement by mutableStateOf(WalletStatement.empty)
    private set
  var inbox: Inbox by mutableStateOf(Inbox.empty)
    private set
  var preferences: NotifyPreferences by mutableStateOf(NotifyPreferences.default)
    private set
  var sessions: List<DeviceSession> by mutableStateOf(emptyList())
    private set
  /** Set while a page of the statement is on its way, so the button can say so. */
  var loadingMore: Boolean by mutableStateOf(false)
    private set
  /** The same, for a page of the inbox. */
  var loadingMoreInbox: Boolean by mutableStateOf(false)
    private set
  /** Whether any call has actually told us the balance. Until one has, the wallet shows nothing — never a zero. */
  var walletLoaded: Boolean by mutableStateOf(false)
    private set
  /** Set while a top-up is in flight, so the button can say so. */
  var toppingUp: Boolean by mutableStateOf(false)
    private set
  var trouble: String? by mutableStateOf(null)
    private set

  /**
   * Whether money can come in at all. A production server with no payment
   * key says no to every top-up; the first refusal is remembered — for a day,
   * so the amounts come back by themselves once payments open — and the
   * wallet stops offering a door that does not open.
   */
  var topupsOpen: Boolean by mutableStateOf(!refusalRemembered(prefs.getLong(closedKey, 0).takeIf { it > 0 }))
    private set

  val balanceMnt: Int get() = me?.wallet?.balanceMnt ?: wallet.balanceMnt
  val balanceKnown: Boolean get() = me != null || walletLoaded
  val unread: Int get() = maxOf(me?.unread ?: 0, inbox.unread)
  val isSignedIn: Boolean get() = session.isSignedIn

  /** The launcher's one call. Cheap enough to make on every appearance. */
  suspend fun refresh() {
    val token = session.token
    if (token == null) {
      me = null
      wallet = WalletStatement.empty
      inbox = Inbox.empty
      walletLoaded = false
      return
    }
    try {
      me = api.me(token)
      trouble = null
    } catch (error: Exception) {
      if (error is ApiError && error.isUnauthorised) {
        session.forget()
        me = null
      } else {
        // A launcher that cannot reach the server still has to draw. The last
        // known balance is better than a dash.
        note(error)
      }
    }
  }

  suspend fun loadWallet() {
    val token = session.token ?: return
    try {
      wallet = api.wallet(token)
      walletLoaded = true
      trouble = null
      // The server's word, when it gives one, outranks what was remembered.
      wallet.topupsOpen?.let { noteTopups(it) }
    } catch (error: Exception) {
      note(error)
    }
  }

  private fun noteTopups(open: Boolean) {
    topupsOpen = open
    if (open) prefs.edit().remove(closedKey).apply()
    else prefs.edit().putLong(closedKey, System.currentTimeMillis()).apply()
  }

  /**
   * The next page of the statement. Keyed on the last line rather than an
   * offset: entries are append-only, so a page cannot shift under somebody
   * who is scrolling while a refund lands.
   */
  suspend fun loadMoreWallet() {
    val token = session.token ?: return
    val cursor = wallet.next ?: return
    if (loadingMore) return
    loadingMore = true
    try {
      val page = api.wallet(token, before = cursor)
      wallet = WalletStatement(page.balanceMnt, page.currency, wallet.lines + page.lines, page.next, page.topupsOpen)
    } catch (error: Exception) {
      note(error)
    } finally {
      loadingMore = false
    }
  }

  suspend fun movement(id: String): Movement? {
    val token = session.token ?: return null
    return try {
      api.movement(id, token)
    } catch (error: Exception) {
      note(error)
      null
    }
  }

  // ── where you are signed in ──────────────────────────────────────────

  suspend fun loadSessions() {
    val token = session.token ?: return
    try {
      sessions = api.sessions(token)
      trouble = null
    } catch (error: Exception) {
      note(error)
    }
  }

  /**
   * Out on this phone, and on the server too. The phone forgets its token at
   * once, so the way in is on screen without waiting for the network; the
   * session it named is ended behind that, with the token kept in hand for
   * the one call.
   */
  fun signOut() {
    val token = session.token
    session.signOut()
    sessions = emptyList()
    if (token == null) return
    background.launch {
      runCatching {
        val mine = api.sessions(token).firstOrNull { it.current } ?: return@launch
        api.revokeSession(mine.id, token)
      }
    }
  }

  suspend fun signOutOtherDevices(): Int {
    val token = session.token ?: return 0
    return try {
      val revoked = api.revokeOtherSessions(token)
      loadSessions()
      revoked
    } catch (error: Exception) {
      note(error)
      0
    }
  }

  suspend fun signOutDevice(device: DeviceSession) {
    val token = session.token ?: return
    if (device.current) return
    try {
      api.revokeSession(device.id, token)
      loadSessions()
    } catch (error: Exception) {
      note(error)
    }
  }

  // ── the ways back in ─────────────────────────────────────────────────
  //
  // These throw rather than setting `trouble`: each is a step in a sheet of
  // its own, and the refusal belongs beside the field it is about.

  /** A code to the address, for an account that has none. `password` is the current one, when there is one. */
  suspend fun requestEmailCode(email: String, password: String?) {
    api.attachEmailCode(Session.address(email), password, bearer())
  }

  /** The code from the letter: the address is the account's, and the profile says so. */
  suspend fun attachEmail(email: String, code: String) {
    api.attachEmail(Session.address(email), code, bearer())
    refresh()
  }

  /** A code for the first password, to the address on the account. Returns where it went. */
  suspend fun requestPasswordCode(): String = api.firstPasswordCode(bearer())

  /** Returns how many other devices it signed out. The first password comes with a code, and no `current`. */
  suspend fun changePassword(current: String?, next: String, code: String? = null): Int {
    val revoked = api.changePassword(current, next, code, bearer())
    refresh()
    loadSessions()
    return revoked
  }

  private fun bearer(): String = session.token ?: throw ApiError(401, "UNAUTHORIZED", "Нэвтэрч орно уу.")

  /**
   * Close the account. The server refuses while the wallet holds money or
   * something is still running, and says which in Mongolian. Returns null
   * once it is closed, or that refusal.
   */
  suspend fun closeAccount(): String? {
    val token = session.token ?: return null
    return try {
      api.closeAccount(token)
      session.signOut()
      me = null
      wallet = WalletStatement.empty
      inbox = Inbox.empty
      sessions = emptyList()
      trouble = null
      null
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      (error as? ApiError)?.message ?: "Бүртгэлийг хааж чадсангүй. Дахин оролдоно уу."
    }
  }

  /** The newest page. Whatever was paged in below it is let go: a refresh starts over. */
  suspend fun loadInbox() {
    val token = session.token ?: return
    try {
      inbox = api.inbox(token)
      trouble = null
    } catch (error: Exception) {
      note(error)
    }
  }

  /**
   * The page after the last message shown. Keyed on that message, as the
   * wallet is, so a message that arrives mid-scroll does not shift the page.
   */
  suspend fun loadMoreInbox() {
    val token = session.token ?: return
    val cursor = inbox.next ?: return
    if (loadingMoreInbox) return
    loadingMoreInbox = true
    try {
      val page = api.inbox(token, before = cursor)
      inbox = Inbox(page.unread, inbox.messages + page.messages, page.next)
    } catch (error: Exception) {
      note(error)
    } finally {
      loadingMoreInbox = false
    }
  }

  suspend fun loadPreferences() {
    val token = session.token ?: return
    try {
      preferences = api.notifyPreferences(token)
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
    }
  }

  /**
   * Money in. Two steps, because they are two different things: asking the
   * provider for the money, and the money arriving. Both paths are safe —
   * settling twice credits once.
   */
  suspend fun topUp(amountMnt: Int): Boolean {
    val token = session.token ?: return false
    toppingUp = true
    trouble = null
    try {
      val started = api.startTopup(amountMnt, token)
      started.actionUrl?.let { raw ->
        runCatching {
          context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(raw)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
      }
      api.settleTopup(started.topupId, token)
      noteTopups(true)
      loadWallet()
      refresh()
      return true
    } catch (error: Exception) {
      if (error is ApiError && error.code == "PAYMENTS_CLOSED") {
        // Not a failure of this tap, and not a thing to try again: the wallet
        // says plainly that money cannot come in, and stops offering it.
        noteTopups(false)
      } else {
        note(error)
      }
      return false
    } finally {
      toppingUp = false
    }
  }

  /**
   * The swipe. Gone from the list at once; the server is told after, and a
   * refusal puts it back rather than leaving a hole nobody explained.
   */
  suspend fun delete(message: InboxMessage) {
    val token = session.token ?: return
    val kept = inbox
    inbox = inbox.copy(
      unread = if (message.read) inbox.unread else maxOf(0, inbox.unread - 1),
      messages = inbox.messages.filter { it.id != message.id },
    )
    try {
      api.deleteMessage(message.id, token)
      refresh()
    } catch (error: Exception) {
      inbox = kept
      note(error)
    }
  }

  /**
   * Opening a message reads it. The row is changed in place rather than the
   * list fetched again: fetching again would be the newest page only, and
   * drop whatever the guest had scrolled down to.
   */
  suspend fun markRead(message: InboxMessage) {
    val token = session.token ?: return
    if (message.read) return
    try {
      api.markRead(message.id, token)
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
    }
    inbox = inbox.copy(
      unread = maxOf(0, inbox.unread - 1),
      messages = inbox.messages.map { if (it.id == message.id) it.copy(read = true) else it },
    )
    refresh()
  }

  /** Returns whether it was kept, so the sheet it came from stays open with the refusal. */
  suspend fun save(displayName: String?, locale: String?): Boolean {
    val token = session.token ?: return false
    return try {
      me = api.updateProfile(displayName, locale, token)
      trouble = null
      true
    } catch (error: Exception) {
      note(error)
      false
    }
  }

  suspend fun setPreference(push: Boolean? = null, sms: Boolean? = null, marketing: Boolean? = null) {
    val token = session.token ?: return
    // Move the switch first: a toggle that waits for the network before it
    // budges reads as broken, and the reload below puts it back if it failed.
    preferences = preferences.copy(
      push = push ?: preferences.push,
      sms = sms ?: preferences.sms,
      marketing = marketing ?: preferences.marketing,
    )
    try {
      preferences = api.setNotifyPreferences(push, sms, marketing, token)
    } catch (error: Exception) {
      note(error)
      loadPreferences()
    }
  }

  fun clearTrouble() {
    trouble = null
  }

  private fun note(error: Throwable) {
    // A screen that left before its answer came has nothing to be told.
    if (error is CancellationException) throw error
    trouble = error.words
  }

  companion object {
    /** A refusal younger than a day still stands. */
    fun refusalRemembered(atMillis: Long?, now: Long = System.currentTimeMillis()): Boolean =
      atMillis != null && now - atMillis < 24 * 60 * 60 * 1000
  }
}
