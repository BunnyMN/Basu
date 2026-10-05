package mn.basu.app.core

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * The phone's own lock over the shell: the wallet and the orders stay behind
 * the phone's owner, even when the phone is handed to somebody else unlocked.
 *
 * Off until somebody turns it on, and turned on only by passing it once — a
 * switch that could lock its owner out without their finger or code having
 * worked even one time is a trap. The phone's own PIN or pattern is always
 * the way past a finger that will not match; Basu keeps no second secret.
 *
 * Leaving for a moment does not lock: paying through a bank's app, or reading
 * a code in the mail, and coming straight back is one errand. A minute away
 * is a departure. While the app is away the shell is curtained either way.
 */
class AppLock(private val context: Context) {
  private val prefs = context.getSharedPreferences("basu", Context.MODE_PRIVATE)

  var enabled: Boolean by mutableStateOf(prefs.getBoolean(KEY, false))
    private set
  /** Asks for the finger or the code before the shell shows. */
  var locked: Boolean by mutableStateOf(prefs.getBoolean(KEY, false))
    private set
  /** Away from the screen: the shell is covered, whatever happens next. */
  var curtained: Boolean by mutableStateOf(false)
    private set

  private var leftAt: Long? = null

  /** The system's prompt, as the activity on screen shows it. Set by `MainActivity`. */
  var check: (suspend (String) -> Boolean)? = null

  /** What this phone checks with: the switch's words and the button's. */
  val kind: Kind
    get() {
      val manager = BiometricManager.from(context)
      return when {
        manager.canAuthenticate(BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS -> Kind.Biometric
        manager.canAuthenticate(BIOMETRIC_WEAK or DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS -> Kind.Passcode
        else -> Kind.None
      }
    }

  // ── coming and going ─────────────────────────────────────────────────

  fun left(now: Long = System.currentTimeMillis()) {
    if (!enabled) return
    curtained = true
    if (leftAt == null) leftAt = now
  }

  fun returned(now: Long = System.currentTimeMillis()) {
    val left = leftAt
    leftAt = null
    if (!enabled) {
      curtained = false
      return
    }
    if (left != null && now - left > GRACE_MS) locked = true
    curtained = locked
  }

  // ── the finger ───────────────────────────────────────────────────────

  /** Signing in is proof enough: a lock left over from launch does not ask again. */
  fun admitted() {
    locked = false
    curtained = false
  }

  /** One try. A cancelled or failed one leaves the lock where it was. */
  suspend fun unlock() {
    if (!locked) return
    // A phone that has since lost its screen lock has nothing to check
    // against, and a lock nobody can open is worse than none.
    if (kind == Kind.None) {
      locked = false
      curtained = false
      return
    }
    if (check?.invoke("Basu-г нээх") == true) {
      locked = false
      curtained = false
    }
  }

  /** On only once the finger or code has worked here; off at a touch. */
  suspend fun turn(on: Boolean) {
    if (on) {
      val kind = kind
      if (kind == Kind.None || check?.invoke("Basu-г ${kind.by} түгжих") != true) return
    }
    enabled = on
    locked = false
    curtained = false
    prefs.edit().putBoolean(KEY, on).apply()
  }

  enum class Kind(val title: String, val by: String) {
    Biometric("Хурууны хээ, нүүр", "хурууны хээ, нүүрээр"),
    Passcode("Нууц код", "нууц кодоор"),
    None("Нууц код", "нууц кодоор"),
  }

  companion object {
    const val KEY = "lock.enabled"
    /** How long the app may be away before coming back asks again. */
    const val GRACE_MS = 60_000L
  }
}
