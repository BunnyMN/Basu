package mn.basu.app.core

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlin.coroutines.cancellation.CancellationException

/**
 * What the whole app knows: who is signed in, and what of the guest's is
 * currently running.
 *
 * Everything else is a screen's own business, or a service's. The launcher
 * never creates a session, so a person who has only opened the app has an
 * account nowhere.
 */
class AppModel(val api: Api, val session: Session, context: Context) {
  private val prefs = context.getSharedPreferences("basu", Context.MODE_PRIVATE)

  var live: List<LiveOrder> by mutableStateOf(emptyList())
    private set
  var liveIdesh: List<LiveIdesh> by mutableStateOf(emptyList())
    private set
  /** The supplier this guest is, when they are one: the launcher's extra tile. */
  var supplier: SupplierMine? by mutableStateOf(null)
    private set

  private var browsingState by mutableStateOf(prefs.getBoolean("browsing", false))

  /**
   * Signed out, but past the way in to look around: «Бүртгэлгүйгээр үзэх».
   * Kept until somebody signs in — then the next sign-out lands on the way in
   * again. The account is asked for at the order, the wallet and the profile.
   */
  var browsing: Boolean
    get() = browsingState
    set(value) {
      browsingState = value
      prefs.edit().putBoolean("browsing", value).apply()
    }

  /**
   * A word for somebody who has just arrived, said once over wherever they
   * landed. The way in cannot say it itself: the moment there is a session
   * the root swaps it for the launcher, so it is left here for the root.
   */
  var notice: String? by mutableStateOf(null)

  /**
   * Whether the last call reached the server at all. An empty launcher and an
   * unreachable server look the same — nothing — and the difference is the
   * whole of what to do next.
   */
  var offline: Boolean by mutableStateOf(false)
    private set

  suspend fun bootstrap() {
    offline = !api.reachable()
    refreshLive()
  }

  /** Ask again, after the person holding the phone has done something about it. */
  suspend fun retry() {
    offline = !api.reachable()
    if (!offline) refreshLive()
  }

  /**
   * While the server is unreachable, keep asking — every ten seconds — so the
   * banner goes by itself when the network or the server comes back.
   */
  suspend fun watchWhileOffline() {
    while (offline) {
      delay(10_000)
      retry()
    }
  }

  /** Every call that lands says so, and every one that never arrives says that. */
  fun noted(error: Throwable?) {
    if (error == null) {
      offline = false
      return
    }
    if (error is ApiError && error.code == "OFFLINE") offline = true
  }

  /**
   * The guest's live orders, if there is a guest. This is the shell's one
   * view of what a service is doing: the launcher's cards and the Захиалга
   * tab both come from it.
   */
  suspend fun refreshLive() {
    val token = session.token
    if (token == null) {
      live = emptyList()
      liveIdesh = emptyList()
      supplier = null
      return
    }
    // Three calls: one per service, and whether this guest is a supplier.
    // A server without the second service or the supplier's side answers
    // 404 there; that is an empty list and no tile, not an outage.
    coroutineScope {
      val lunches = async { runCatching { api.liveOrders(token) } }
      val provisions = async { runCatching { api.liveIdesh(token) } }
      val mine = async { runCatching { api.supplierMine(token) } }

      val orders = lunches.await()
      orders.exceptionOrNull()?.let { error ->
        if (error is CancellationException) throw error
        if (error is ApiError && error.isUnauthorised) {
          // A token from a reseeded database is dead, not a reason to shout
          // at somebody who has only just opened the app.
          session.forget()
          live = emptyList()
          liveIdesh = emptyList()
          supplier = null
          return@coroutineScope
        }
        noted(error)
        live = emptyList()
      }
      orders.getOrNull()?.let {
        live = it
        noted(null)
        if (it.any { order -> order.state == OrderState.SERVED }) ReviewMoment.noteFinished(prefs)
      }

      val idesh = provisions.await()
      if (idesh.exceptionOrNull() is CancellationException) throw idesh.exceptionOrNull()!!
      liveIdesh = idesh.getOrNull() ?: emptyList()
      if (liveIdesh.any { it.state == IdeshState.HANDED }) ReviewMoment.noteFinished(prefs)

      val own = mine.await()
      if (own.exceptionOrNull() is CancellationException) throw own.exceptionOrNull()!!
      supplier = own.getOrNull()
    }
  }
}

/**
 * When to ask for a rating: after something went right — a lunch served, a
 * sheep handed over — and then the next time the guest is back on the
 * launcher. Not in the middle of ordering, not on a first launch, and not
 * twice for one version. Play still decides whether the prompt appears.
 */
object ReviewMoment {
  private const val FINISHED = "review.finishedOrder"
  private const val ASKED = "review.askedForVersion"

  fun noteFinished(prefs: android.content.SharedPreferences) {
    prefs.edit().putBoolean(FINISHED, true).apply()
  }

  fun due(prefs: android.content.SharedPreferences, version: String): Boolean =
    prefs.getBoolean(FINISHED, false) && prefs.getString(ASKED, null) != version

  fun markAsked(prefs: android.content.SharedPreferences, version: String) {
    prefs.edit().putString(ASKED, version).putBoolean(FINISHED, false).apply()
  }
}
