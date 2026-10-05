package mn.basu.app.core

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Whether Basu may notify, and the one place the phone's own question is put.
 *
 * The question is put when there is something to be told about, not on a
 * screen: right after a guest's first order, and as a supplier's counter
 * opens. First in the shell's own words (`PushAsk`), which lead only to
 * Android's own dialog.
 *
 * Two flags, because they are two different facts. `offered`: the shell's
 * screen has been up this run, and once a run is enough. `asked`: Android's
 * own dialog has been asked for, whose answer stands.
 */
class PushRegistrar(private val context: Context) {
  private val prefs = context.getSharedPreferences("basu", Context.MODE_PRIVATE)

  /** Android's dialog, as the activity on screen shows it. Set by `MainActivity`. */
  var request: (suspend (Array<String>) -> Boolean)? = null

  /** Android's own dialog has been asked for this run. */
  var asked: Boolean by mutableStateOf(false)
    private set
  /** The shell's own screen has been put up this run. */
  var offered: Boolean by mutableStateOf(false)
    private set
  /** Whether notifications are on for Basu, as of the last look. */
  var allowed: Boolean by mutableStateOf(isAllowed())
    private set

  private fun isAllowed(): Boolean {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
    return Build.VERSION.SDK_INT < 33 ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
  }

  /** Look again: the answer may have been changed in Settings while the app was away. */
  fun look() {
    allowed = isAllowed()
  }

  /** Android has never put the question: before 13 there is none to put, and a no is an answer. */
  val undetermined: Boolean
    get() = Build.VERSION.SDK_INT >= 33 && !isAllowed() && !prefs.getBoolean(ASKED, false)

  /** Whether to put the shell's screen up now. */
  fun shouldOffer(): Boolean = !offered && !asked && undetermined

  fun markOffered() {
    offered = true
  }

  /** Ask once. A refusal is an answer: pestering through a second path only annoys the same person twice. */
  suspend fun askIfNeeded() {
    if (asked) return
    asked = true
    if (undetermined) {
      prefs.edit().putBoolean(ASKED, true).apply()
      request?.invoke(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
    }
    look()
  }

  /** The phone's own page for Basu's notifications, where a no is turned into a yes. */
  fun openSettings() {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
      .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
  }

  companion object {
    private const val ASKED = "push.asked"
  }
}
