package mn.basu.app.shell

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import mn.basu.app.BuildConfig
import mn.basu.app.auth.SignInSheet
import mn.basu.app.calls.Calls
import mn.basu.app.core.Endpoint
import mn.basu.app.core.LocalAppModel
import mn.basu.app.core.LocalPush
import mn.basu.app.core.LocalSession
import mn.basu.app.core.openInBrowser
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.Chevron
import mn.basu.app.design.ChevronDirection
import mn.basu.app.design.OfflineBanner
import mn.basu.app.design.glass
import mn.basu.app.design.pressable
import mn.basu.app.design.sans
import org.json.JSONObject

/**
 * An app inside Basu: a web page from the shell's own server, full screen.
 *
 * The shell is native and the apps are not. Everything after the choice — the
 * map, the menu, the sitting, the status — is the web page at `/dine` or
 * `/idesh`, the same one the iOS app shows.
 *
 * Three things cross the line between the two, and only three:
 *
 * - **The session.** The shell signs the guest in and keeps the token. Before
 *   the page loads, the token is put where the page already looks —
 *   `localStorage['basu.guest']`. When the page needs a guest and has none it
 *   asks (`signIn`), the shell shows its own sheet, and the token arrives the
 *   same way.
 * - **The way out.** The page's `‹ Basu` link goes to `/`. Here it is this
 *   screen's parent, so the navigation is cancelled and the screen closes.
 * - **What changed.** The page tells the shell when an order moved, so the
 *   cards outside catch up at once rather than on the next poll.
 *
 * The page speaks to `window.webkit.messageHandlers.basu`, as it does on iOS;
 * here that name is a small shim over a JavaScript interface, put in before
 * any of the page's own scripts run. A page that works there works here.
 *
 * Until the page has drawn, and whenever it cannot, the shell's own «‹ Basu»
 * stands in its corner; the system's back walks the page's own screens first,
 * and from the first one leaves the app.
 */
@Composable
fun ServiceView(app: String, path: String, back: () -> Unit) {
  val model = LocalAppModel.current
  val session = LocalSession.current
  val push = LocalPush.current
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val page = remember { ServicePage(context) }
  val leave by rememberUpdatedState(back)

  var signingIn by remember { mutableStateOf(false) }
  var askingPush by remember { mutableStateOf(false) }
  // A beat after opening. A page that draws within it never shows the shell's
  // chip or spinner at all, rather than flashing them.
  var slow by remember { mutableStateOf(false) }
  val isSupplier = app == AppCatalogue.supplier.id

  // The moment the question is about something, if Android has never put it:
  // a guest's order running — just paid for, as a rule — or a supplier's
  // counter open.
  fun offerPush() {
    if (!session.isSignedIn || signingIn || askingPush) return
    if (!isSupplier && model.live.isEmpty() && model.liveIdesh.isEmpty()) return
    if (!push.shouldOffer()) return
    push.markOffered()
    askingPush = true
  }

  DisposableEffect(Unit) {
    page.home = { leave() }
    page.signIn = { signingIn = true }
    page.changed = {
      scope.launch {
        model.refreshLive()
        offerPush()
      }
    }
    page.load(path, session.token)
    onDispose { page.destroy() }
  }
  LaunchedEffect(session.token) { page.deliver(session.token) }
  LaunchedEffect(Unit) {
    delay(450)
    slow = true
  }
  LaunchedEffect(Unit) {
    // The card outside the page keeps up with the page. Five seconds is the
    // web status sheet's own cadence.
    while (true) {
      delay(5000)
      model.refreshLive()
    }
  }
  // The supplier's counter is where new orders arrive, and a notification is
  // how they reach a supplier who is not looking: asked as it opens.
  LaunchedEffect(page.loaded) { if (page.loaded && isSupplier) offerPush() }

  // The page's own screens first; from the first one, out of the app.
  BackHandler {
    if (page.walksItsOwnHistory) page.goBack() else leave()
  }

  Box(Modifier.fillMaxSize().background(BasuColor.bg).windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.ime))) {
    // A page that could not be reached has nothing to show or touch: a
    // proxy's «502 Bad Gateway» must not show through under the banner.
    AndroidView(
      factory = { page.webView },
      modifier = Modifier.fillMaxSize().alpha(if (page.unreachable) 0f else 1f).testTag("service.$app"),
    )

    AnimatedVisibility(
      !page.loaded && !page.unreachable && slow,
      Modifier.align(Alignment.Center),
      enter = fadeIn(),
      exit = fadeOut(),
    ) {
      CircularProgressIndicator(
        Modifier.size(36.dp).semantics { contentDescription = "Уншиж байна" },
        color = BasuColor.ink3,
        strokeWidth = 3.dp,
      )
    }

    AnimatedVisibility((!page.loaded && slow) || page.unreachable, enter = fadeIn(), exit = fadeOut()) {
      Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HomeChip(leave)
        if (page.unreachable) {
          OfflineBanner(Modifier.padding(horizontal = BasuMetric.screenPadding)) {
            model.retry()
            page.reload()
          }
        }
      }
    }
  }

  if (signingIn) {
    // A guest asked mid-order hears why and that nothing was lost; the
    // supplier's counter asking again has no order to speak of.
    SignInSheet(
      reason = if (isSupplier) null else "Захиалгаа дуусгахын тулд нэвтэрнэ үү — сонгосон зүйлс тань хэвээр үлдэнэ.",
      onDismiss = {
        signingIn = false
        // Whatever happened in the sheet, the page is waiting for an answer.
        page.deliver(session.token)
      },
    )
  }
  if (askingPush) {
    PushAsk(if (isSupplier) PushAudience.Supplier else PushAudience.Guest) {
      askingPush = false
      scope.launch { push.askIfNeeded() }
    }
  }
}

/**
 * «‹ Basu»: the shell's way out of an app, drawn by the shell, in the page's
 * own words for it. Shown until the page has drawn its own in the same
 * corner, and whenever the page cannot be reached.
 */
@Composable
private fun HomeChip(action: () -> Unit) {
  Row(
    Modifier
      .padding(start = BasuMetric.screenPadding - 6.dp)
      .defaultMinSize(minHeight = BasuMetric.minTarget)
      .glass(CircleShape)
      .clip(CircleShape)
      .pressable(onClick = action)
      .padding(start = 12.dp, end = 16.dp)
      .semantics { contentDescription = "Basu нүүр" }
      .testTag("service.home"),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Chevron(BasuColor.ink, direction = ChevronDirection.Back, size = 17.dp)
    Text("Basu", color = BasuColor.ink, style = sans(15, FontWeight.Bold))
  }
}

/**
 * One page, and the three messages it can send. Kept outside the composable
 * because a `WebView` is expensive to make and must not be remade on every
 * state change, and because the client callbacks need a stable object.
 */
@SuppressLint("SetJavaScriptEnabled")
class ServicePage(context: Context) {
  /** The server could not be reached. Said out loud, not left as a white page. */
  var unreachable by mutableStateOf(false)
    private set
  /** The page this app opened on has drawn — its own «‹ Basu» is there. */
  var loaded by mutableStateOf(false)
    private set
  /** The web view has history to go back through (`pushState` included). */
  private var canGoBack by mutableStateOf(false)

  /**
   * The page is up and has screens of its own to go back through. A page
   * that never drew has nothing to go back through, whatever its history says.
   */
  val walksItsOwnHistory: Boolean get() = canGoBack && loaded && !unreachable

  var home: (() -> Unit)? = null
  var signIn: (() -> Unit)? = null
  var changed: (() -> Unit)? = null

  private val base = Uri.parse(Endpoint.base)
  private var pending: String? = null
  /** The app's own pages: the path it was opened on, and what is under it. */
  private var prefix = "/"
  /** The last answer for the whole page was a failure — an error page is not the app having loaded. */
  private var failed = false
  private var script: ScriptHandler? = null
  private var token: String? = null
  private val main = Handler(Looper.getMainLooper())

  val webView: WebView = WebView(context).apply {
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    // What shows before the page paints, and past its edge: the charcoal, not white.
    setBackgroundColor(0xFF100D0C.toInt())
    overScrollMode = WebView.OVER_SCROLL_NEVER
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.mediaPlaybackRequiresUserGesture = false
    settings.setSupportMultipleWindows(false)
    settings.textZoom = 100
    settings.userAgentString = settings.userAgentString + " BasuAndroid/" + BuildConfig.VERSION_NAME
    addJavascriptInterface(Bridge(), BRIDGE)
    webViewClient = Client()
    webChromeClient = WebChromeClient()
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
  }

  /** Put the session where the page looks, then open it. */
  fun load(path: String, token: String?) {
    inject(token)
    val url = Uri.parse(Endpoint.base + path)
    prefix = url.path?.ifEmpty { "/" } ?: "/"
    pending = url.toString()
    failed = false
    webView.loadUrl(url.toString())
  }

  fun reload() {
    unreachable = false
    loaded = false
    failed = false
    pending?.let(webView::loadUrl) ?: webView.reload()
  }

  fun goBack() {
    webView.goBack()
  }

  /**
   * The answer to `signIn`: the token, or `null` when the sheet was dismissed
   * without one. Either way the page stops waiting.
   */
  fun deliver(token: String?) {
    inject(token)
    webView.evaluateJavascript(
      sessionScript(token) +
        "\nif (typeof window.__basuSignedIn === 'function') window.__basuSignedIn(${literal(token)});",
      null,
    )
  }

  fun destroy() {
    home = null
    signIn = null
    changed = null
    webView.stopLoading()
    (webView.parent as? ViewGroup)?.removeView(webView)
    webView.destroy()
  }

  /**
   * Before any of the page's own scripts run, on every page of ours: the
   * session where the page looks for it, and the bridge under the name the
   * page already speaks to.
   */
  private fun inject(token: String?) {
    this.token = token
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    script?.remove()
    val origin = base.scheme + "://" + base.host + (if (base.port != -1) ":" + base.port else "")
    script = WebViewCompat.addDocumentStartJavaScript(webView, SHIM + sessionScript(token), setOf(origin))
  }

  private fun isOurs(url: Uri): Boolean = url.host == base.host && url.port == base.port

  /** The web launcher, which is where a page's «‹ Basu» goes in a browser. */
  private fun isHome(url: Uri): Boolean = isOurs(url) && (url.path ?: "") in setOf("", "/", "/app", "/app/")

  private inner class Bridge {
    @JavascriptInterface
    fun postMessage(json: String) {
      val message = runCatching { JSONObject(json) }.getOrNull() ?: return
      val type = message.optString("type")
      main.post {
        when (type) {
          "signIn" -> signIn?.invoke()
          "orders" -> changed?.invoke()
          "home" -> home?.invoke()
          // The order page's «Апп-аар залгах»: the shell rings, with its own call screen.
          "call" -> {
            val subject = message.optString("subject")
            val subjectId = message.optString("subject_id")
            if (subject.isNotEmpty() && subjectId.isNotEmpty()) Calls.ringOut(subject, subjectId, message.optString("peer_name"))
          }
        }
      }
    }
  }

  private inner class Client : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      val url = request.url
      if (!request.isForMainFrame) return false
      // `‹ Basu` goes to `/`, which is the launcher — this screen's parent.
      if (isHome(url)) {
        home?.invoke()
        return true
      }
      val scheme = url.scheme ?: return false
      // A phone number, a bank's app — anything that is not a page — is the
      // system's. The supplier's number on an order is the one link a guest
      // most needs, and a bank's deep link is how an invoice is paid.
      if (scheme !in setOf("http", "https", "about", "blob", "data", "file")) {
        openInBrowser(view.context, url)
        return true
      }
      if (scheme != "http" && scheme != "https") return false
      // The kitchen's screen is for a kitchen's own tablet.
      if (isOurs(url) && staffOnly(url.path ?: "")) return true
      // A link out of the page is the browser's, and so is any page of ours
      // that is not this app's — the dashboard, the website's sign-in.
      if (!isOurs(url) || !belongs(url.path ?: "/", prefix)) {
        openInBrowser(view.context, url)
        return true
      }
      return false
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
      // An old WebView with no document-start hook gets the same script as
      // early as it can be given.
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
        view.evaluateJavascript(SHIM + sessionScript(token), null)
      }
    }

    override fun onPageFinished(view: WebView, url: String?) {
      val at = url?.let(Uri::parse)
      if (at != null && isOurs(at) && !failed) {
        unreachable = false
        loaded = true
      } else if (failed) {
        unreachable = true
      }
      canGoBack = view.canGoBack()
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
      // `pushState` tells no other callback anything; the history does.
      canGoBack = view.canGoBack()
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
      if (!request.isForMainFrame) return
      failed = true
      unreachable = true
    }

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
      // A proxy's «502 Bad Gateway» is never the app: the shell says the
      // server is not answering.
      if (!request.isForMainFrame || response.statusCode < 500) return
      failed = true
      unreachable = true
    }
  }

  companion object {
    private const val BRIDGE = "BasuBridge"

    /** `window.webkit.messageHandlers.basu`, the page's side of the bridge, as it is named on iOS. */
    private const val SHIM = """
(function () {
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.basu) return;
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.basu = {
    postMessage: function (message) {
      try { $BRIDGE.postMessage(JSON.stringify(message)); } catch (e) {}
    }
  };
})();
// This shell rings with its own call screen: the order page offers «Апп-аар залгах».
window.__basuCalls = true;
"""

    private fun sessionScript(token: String?): String = """
(function () {
  try {
    var t = ${literal(token)};
    if (t) localStorage.setItem('basu.guest', t); else localStorage.removeItem('basu.guest');
  } catch (e) {}
})();
"""

    /** A Kotlin string as a JavaScript one, `null` for none. */
    private fun literal(value: String?): String = if (value == null) "null" else JSONObject.quote(value)

    /**
     * The pages this app may show inside the shell: its own (`/idesh` and
     * what is under it), the other app a guest has, and the two every page
     * links to. Anything else of ours is the website, and opens in the browser.
     */
    fun belongs(path: String, prefix: String): Boolean {
      if (path in setOf("/terms", "/privacy")) return true
      val own = if (prefix.endsWith("/") && prefix.length > 1) prefix.dropLast(1) else prefix
      val guests = listOf("/dine", "/idesh")
      val mates = if (own in guests) guests else listOf(own)
      return mates.any { path == it || path.startsWith("$it/") }
    }

    /** The kitchen's screen is for a kitchen's own tablet. A guest's app goes nowhere near it. */
    fun staffOnly(path: String): Boolean = path == "/kds" || path.startsWith("/kds/")
  }
}
