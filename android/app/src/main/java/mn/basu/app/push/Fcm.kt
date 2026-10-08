package mn.basu.app.push

import android.content.Context
import android.os.Build
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import mn.basu.app.calls.registerRingToken
import mn.basu.app.calls.revokeRingToken
import mn.basu.app.core.Api
import mn.basu.app.core.registerPushToken
import mn.basu.app.core.revokePushToken
import kotlin.coroutines.resume

/**
 * This phone's Firebase token, and the one place it is turned into something
 * the server knows — the twin of iOS's PushRegistrar and PushKit token.
 *
 * One token does both jobs on Android: order news for the tray
 * (`/v1/notifications/devices`) and a call's ring with the app closed
 * (`/v1/calls/tokens`, kind `fcm`). It is told to the server whenever somebody
 * is signed in and the token is known, whichever comes second, and taken
 * back at sign-out.
 *
 * A build without app/google-services.json has no Firebase at all; then
 * every call here does nothing, and the app works as it did before push.
 */
object Fcm {
  private lateinit var context: Context
  private lateinit var api: Api
  private var sessionOf: () -> String? = { null }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  /** The session the current token was last told to, so it is told once. */
  private var toldFor: String? = null
  private var token: String? = null

  fun attach(context: Context, api: Api, session: () -> String?) {
    this.context = context.applicationContext
    this.api = api
    sessionOf = session
  }

  private val present: Boolean
    get() = ::context.isInitialized && FirebaseApp.getApps(context).isNotEmpty()

  /** Whether the app is on screen: then a ring is the app's own, not the tray's. */
  val foreground: Boolean
    get() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

  /** Somebody is signed in (at launch, or just now): the server learns where to reach them. */
  fun signedIn() {
    if (!present) return
    scope.launch {
      val current = token ?: fetch() ?: return@launch
      token = current
      tell(current)
    }
  }

  /** Firebase issued a new token: the old one is dead, the new one is told at once. */
  fun tokenChanged(token: String) {
    this.token = token
    toldFor = null
    if (sessionOf() != null) scope.launch { tell(token) }
  }

  /** Signing out: this phone stops being pushed and rung for them. Said while the session still opens the door. */
  fun signedOut(session: String?) {
    val current = token
    toldFor = null
    if (session == null || current == null) return
    scope.launch {
      runCatching { api.revokePushToken(current, session) }
      runCatching { api.revokeRingToken(current, session) }
    }
  }

  private suspend fun tell(token: String) {
    val session = sessionOf() ?: return
    if (toldFor == session) return
    val label = listOfNotNull(Build.MANUFACTURER?.replaceFirstChar { it.uppercase() }, Build.MODEL).joinToString(" ")
    val pushed = runCatching { api.registerPushToken(token, label, session) }.isSuccess
    val rung = runCatching { api.registerRingToken("fcm", token, session) }.isSuccess
    if (pushed && rung) toldFor = session
  }

  private suspend fun fetch(): String? = suspendCancellableCoroutine { done ->
    runCatching {
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        done.resume(if (task.isSuccessful) task.result else null)
      }
    }.onFailure { done.resume(null) }
  }
}
