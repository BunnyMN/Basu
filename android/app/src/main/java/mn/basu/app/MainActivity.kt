package mn.basu.app

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.CompletableDeferred
import mn.basu.app.calls.Calls
import mn.basu.app.core.Links
import mn.basu.app.core.LocalAppLock
import mn.basu.app.core.LocalAppModel
import mn.basu.app.core.LocalPlatform
import mn.basu.app.core.LocalPush
import mn.basu.app.core.LocalSession
import mn.basu.app.push.Rings
import mn.basu.app.shell.DebugLaunch
import mn.basu.app.shell.RootView

class MainActivity : FragmentActivity() {
  private val app get() = application as BasuApplication
  private var permissionAnswer: CompletableDeferred<Boolean>? = null
  private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
    permissionAnswer?.complete(granted.values.all { it })
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Dark bars on every screen, whatever the phone's own setting.
    enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
    super.onCreate(savedInstanceState)

    app.lock.check = ::authenticate
    app.push.request = { wanted ->
      val answer = CompletableDeferred<Boolean>()
      permissionAnswer = answer
      permissions.launch(wanted)
      answer.await()
    }
    // The microphone and camera for a call, asked the moment one is needed.
    Calls.request = app.push.request
    if (savedInstanceState == null) {
      Links.route(intent?.data)
      ringFrom(intent)
    }
    val debug = DebugLaunch.from(intent)

    setContent {
      CompositionLocalProvider(
        LocalAppModel provides app.model,
        LocalSession provides app.session,
        LocalPlatform provides app.platform,
        LocalAppLock provides app.lock,
        LocalPush provides app.push,
      ) {
        // With the lock on, the app switcher shows no balance and no order.
        LaunchedEffect(Unit) {
          snapshotFlow { app.lock.enabled }.collect { on ->
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
          }
        }
        RootView(debug)
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    Links.route(intent.data)
    ringFrom(intent)
  }

  /** The tray's ringing call, tapped or answered: the call screen takes it from here. */
  private fun ringFrom(intent: Intent?) {
    val callId = intent?.getStringExtra(Rings.EXTRA_CALL) ?: return
    Calls.openRing(callId, answer = intent.getBooleanExtra(Rings.EXTRA_ANSWER, false))
    intent.removeExtra(Rings.EXTRA_CALL)
  }

  override fun onStart() {
    super.onStart()
    app.lock.returned()
    app.push.look()
  }

  override fun onStop() {
    super.onStop()
    // A rotation or the system's own dialog is not a departure.
    if (!isChangingConfigurations) app.lock.left()
  }

  /** Finger or face, and the phone's own PIN or pattern when those do not match. */
  private suspend fun authenticate(reason: String): Boolean {
    val answer = CompletableDeferred<Boolean>()
    val prompt = BiometricPrompt(
      this,
      ContextCompat.getMainExecutor(this),
      object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          answer.complete(true)
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          answer.complete(false)
        }
      },
    )
    val info = BiometricPrompt.PromptInfo.Builder()
      .setTitle("Basu")
      .setSubtitle(reason)
      .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
      .build()
    return try {
      prompt.authenticate(info)
      answer.await()
    } catch (_: IllegalArgumentException) {
      false
    }
  }
}
