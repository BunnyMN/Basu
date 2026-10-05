package mn.basu.app.core

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow

/** What the whole app shares, made once by `BasuApplication`. */
val LocalAppModel = staticCompositionLocalOf<AppModel> { error("no AppModel") }
val LocalSession = staticCompositionLocalOf<Session> { error("no Session") }
val LocalPlatform = staticCompositionLocalOf<Platform> { error("no Platform") }
val LocalAppLock = staticCompositionLocalOf<AppLock> { error("no AppLock") }
val LocalPush = staticCompositionLocalOf<PushRegistrar> { error("no PushRegistrar") }

/**
 * The `basu://` addresses that reach the app: `basu://order/{id}`,
 * `basu://wallet`, `basu://notifications`, `basu://dine` for the shell, and
 * `basu://auth#…` — where Google's round trip comes back — for the way in.
 */
object Links {
  val shell = MutableSharedFlow<Uri>(replay = 1, extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)
  val auth = MutableSharedFlow<Uri>(extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)

  fun route(uri: Uri?) {
    if (uri == null || uri.scheme != GoogleReturn.SCHEME) return
    if (uri.host == "auth") auth.tryEmit(uri) else shell.tryEmit(uri)
  }
}

/** The system's own browser tab, dark like the app: Google's sign-in, a link out of a page. */
fun openInBrowser(context: Context, uri: Uri) {
  val scheme = uri.scheme ?: return
  try {
    if (scheme == "http" || scheme == "https") {
      val dark = CustomTabColorSchemeParams.Builder()
        .setToolbarColor(0xFF100D0C.toInt())
        .setNavigationBarColor(0xFF100D0C.toInt())
        .build()
      CustomTabsIntent.Builder()
        .setColorScheme(CustomTabsIntent.COLOR_SCHEME_DARK)
        .setDefaultColorSchemeParams(dark)
        .setShowTitle(true)
        .build()
        .launchUrl(context, uri)
    } else {
      // A phone number, a bank's app — anything that is not a page is the system's.
      context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  } catch (_: ActivityNotFoundException) {
  } catch (_: SecurityException) {
  }
}
