package mn.basu.app.shell

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import mn.basu.app.BuildConfig
import mn.basu.app.auth.SignInScreen
import mn.basu.app.core.AppLock
import mn.basu.app.core.Links
import mn.basu.app.core.LocalAppLock
import mn.basu.app.core.LocalAppModel
import mn.basu.app.core.LocalPlatform
import mn.basu.app.core.LocalPush
import mn.basu.app.core.LocalSession
import mn.basu.app.design.BasuAlert
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.FitText
import mn.basu.app.design.ShellGlyph
import mn.basu.app.design.ShellMark
import mn.basu.app.design.Symbol
import mn.basu.app.design.display
import mn.basu.app.design.glow
import mn.basu.app.design.plainClick
import mn.basu.app.design.pressable
import mn.basu.app.design.sans
import mn.basu.app.design.tracked
import mn.basu.app.platform.InboxView
import mn.basu.app.platform.ProfileView
import mn.basu.app.platform.WalletView

/**
 * The design pass's doors, debug builds only: `adb shell am start -n
 * mn.basu.app/.MainActivity --es BASU_SCREEN wallet --ez BASU_DEMO_SIGNIN true`.
 * `screen` is one of orders|wallet|profile|inbox|food|idesh|signin|push|splash;
 * `browse` looks around signed out. Production has no such door.
 */
data class DebugLaunch(val screen: String? = null, val demoSignIn: Boolean = false, val browse: Boolean = false, val phone: String? = null) {
  companion object {
    fun from(intent: Intent?): DebugLaunch {
      if (!BuildConfig.DEBUG || intent == null) return DebugLaunch()
      return DebugLaunch(
        screen = intent.getStringExtra("BASU_SCREEN"),
        demoSignIn = intent.getBooleanExtra("BASU_DEMO_SIGNIN", false),
        browse = intent.getBooleanExtra("BASU_BROWSE", false),
        phone = intent.getStringExtra("BASU_DEMO_PHONE"),
      )
    }
  }
}

/**
 * Where the app opens, and the one place navigation is described.
 *
 * Signed out, the app opens on the way in: no launcher behind it, no tab bar
 * over it — and under the doors, «Бүртгэлгүйгээр үзэх», which opens the shell
 * to look around without an account. The account is asked for at the order,
 * the wallet and the profile.
 */
@Composable
fun RootView(debug: DebugLaunch = DebugLaunch()) {
  val model = LocalAppModel.current
  val session = LocalSession.current
  val platform = LocalPlatform.current
  val lock = LocalAppLock.current
  val push = LocalPush.current
  val scope = rememberCoroutineScope()

  var tab by rememberSaveable { mutableStateOf(ShellTab.Home) }
  val path = remember { mutableStateListOf<Destination>() }
  var splash by remember { mutableStateOf(true) }
  var debugPush by remember { mutableStateOf(false) }

  // Out and back in lands on the launcher, not on whatever the last person
  // left open.
  var wasSignedIn by remember { mutableStateOf(session.isSignedIn) }
  LaunchedEffect(session.isSignedIn) {
    val arrived = session.isSignedIn && !wasSignedIn
    wasSignedIn = session.isSignedIn
    if (session.isSignedIn) {
      // Signing in is proof enough: a lock left over does not ask again.
      if (arrived) lock.admitted()
      // In now: signing out later lands on the way in, not on browsing.
      model.browsing = false
    } else {
      tab = ShellTab.Home
      path.clear()
    }
  }

  // Offline anywhere — the launcher, the way in — clears by itself once the
  // server answers again.
  LaunchedEffect(model.offline) { model.watchWhileOffline() }

  // basu://order/{id}, basu://wallet, basu://notifications, basu://dine
  LaunchedEffect(Unit) {
    Links.shell.collect { uri ->
      Links.shell.resetReplayCache()
      open(uri, setTab = { tab = it }, path = path)
    }
  }

  LaunchedEffect(Unit) {
    when (debug.screen) {
      "orders" -> tab = ShellTab.Orders
      "wallet" -> tab = ShellTab.Wallet
      "profile" -> tab = ShellTab.Profile
      "inbox" -> path.add(Destination.Inbox)
      "food" -> path.add(AppCatalogue.food.destination)
      "idesh" -> path.add(AppCatalogue.idesh.destination)
    }
    if (debug.screen == "signin" || debug.browse) {
      session.signOut()
      model.browsing = debug.browse
    } else if (debug.demoSignIn) {
      val phone = debug.phone ?: "+97699001122"
      if (!(session.isSignedIn && session.phone == phone)) {
        session.signOut()
        runCatching { session.demoSignIn(phone) }
      }
    }
    // The splash lasts as long as the launch does, within limits: the floor
    // is so a fast launch does not flash, and the cap is so a stalled network
    // is not a minute of wordmark.
    val cap = launch {
      delay(1200)
      if (debug.screen != "splash") splash = false
    }
    coroutineScope {
      val boot = async { model.bootstrap() }
      val me = async { platform.refresh() }
      delay(650)
      boot.await()
      me.await()
    }
    cap.cancel()
    if (debug.screen != "splash") splash = false
    if (debug.screen == "push") debugPush = true
  }

  Box(Modifier.fillMaxSize().background(BasuColor.bg)) {
    Crossfade(session.isSignedIn || model.browsing, animationSpec = tween(250), label = "root") { inside ->
      if (inside) {
        Shell(tab, path, setTab = { tab = it })
      } else {
        SignInScreen(gate = true)
      }
    }

    // Over the shell, under the splash: away, the app switcher sees the
    // wordmark rather than a balance; locked, the finger comes first.
    AnimatedVisibility(
      session.isSignedIn && (lock.locked || lock.curtained),
      Modifier.zIndex(0.5f),
      enter = fadeIn(),
      exit = fadeOut(),
    ) { LockView() }

    AnimatedVisibility(splash, Modifier.zIndex(1f), enter = fadeIn(tween(0)), exit = fadeOut(tween(350))) { SplashView() }
  }

  val notice = model.notice
  if (notice != null && session.isSignedIn && !splash) {
    BasuAlert(title = "Нэвтэрлээ", message = notice, onConfirm = { model.notice = null }, onDismiss = { model.notice = null })
  }
  if (debugPush) {
    PushAsk(PushAudience.Guest) {
      debugPush = false
      scope.launch { push.askIfNeeded() }
    }
  }
}

private fun open(uri: Uri, setTab: (ShellTab) -> Unit, path: MutableList<Destination>) {
  when (uri.host) {
    "order" -> {
      setTab(ShellTab.Home)
      path.clear()
      val id = uri.pathSegments.firstOrNull()
      path.add(if (id != null) AppCatalogue.food.destination(order = id) else AppCatalogue.food.destination)
    }
    "dine" -> {
      setTab(ShellTab.Home)
      path.clear()
      path.add(AppCatalogue.food.destination)
    }
    "wallet" -> {
      path.clear()
      setTab(ShellTab.Wallet)
    }
    "notifications" -> {
      setTab(ShellTab.Home)
      path.clear()
      path.add(Destination.Inbox)
    }
  }
}

/** The launcher and the three it shares a bar with. */
@Composable
private fun Shell(tab: ShellTab, path: MutableList<Destination>, setTab: (ShellTab) -> Unit) {
  val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
  // True while a vertical owns the screen. The shell's own pushes do not
  // count — the inbox keeps the bar, and keeps Нүүр lit under it.
  val inApp = path.any { it is Destination.App }
  val pop: () -> Unit = { if (path.isNotEmpty()) path.removeAt(path.lastIndex) }

  BackHandler(enabled = path.isNotEmpty() && path.last() is Destination.Inbox, onBack = pop)
  BackHandler(enabled = path.isEmpty() && tab != ShellTab.Home) { setTab(ShellTab.Home) }

  Box(Modifier.fillMaxSize().background(BasuColor.bg)) {
    Crossfade(tab, animationSpec = tween(150), label = "tab") { shown ->
      when (shown) {
        ShellTab.Home -> HomeView(open = { path.add(it) }, showOrders = { setTab(ShellTab.Orders) })
        ShellTab.Orders -> OrdersView(open = { path.add(it) })
        ShellTab.Wallet -> WalletView()
        ShellTab.Profile -> ProfileView()
      }
    }

    AnimatedContent(
      path.lastOrNull(),
      transitionSpec = {
        val forward = targetState != null && (initialState == null || targetState is Destination.App)
        if (forward) {
          (slideInHorizontally(tween(280)) { it } + fadeIn(tween(200))) togetherWith fadeOut(tween(200))
        } else {
          fadeIn(tween(200)) togetherWith (slideOutHorizontally(tween(260)) { it } + fadeOut(tween(200)))
        }
      },
      label = "path",
    ) { destination ->
      when (destination) {
        is Destination.App -> ServiceView(app = destination.id, path = destination.path, back = pop)
        Destination.Inbox -> InboxView(back = pop, open = { path.add(it) })
        null -> Box(Modifier)
      }
    }

    // Drawn over the scrolling content rather than inset beside it. It stays
    // up over the inbox — that is still the shell. An app takes the whole screen.
    AnimatedVisibility(!inApp, Modifier.align(Alignment.BottomCenter), enter = fadeIn(), exit = fadeOut()) {
      Box(contentAlignment = Alignment.BottomCenter) {
        // Content fades out as it nears the bar rather than peeking round
        // both ends of the capsule. It takes no touches.
        Box(
          Modifier
            .fillMaxWidth()
            .height(bottom + 84.dp)
            .background(
              Brush.verticalGradient(
                0f to BasuColor.bg.copy(alpha = 0f),
                0.55f to BasuColor.bg.copy(alpha = 0.9f),
                1f to BasuColor.bg,
              ),
            ),
        )
        TabBar(tab, bottom) { chosen ->
          // A tab always lands on its own root: from the inbox, Түрийвч shows
          // the wallet rather than the inbox over it.
          path.clear()
          setTab(chosen)
        }
      }
    }
  }
}

/**
 * The splash. The wordmark in the display face, a gold rule, and the city —
 * no logo file, no spinner, no progress text. It sits over the launcher and
 * fades to reveal it, on the same charcoal.
 */
@Composable
fun SplashView() {
  Box(Modifier.fillMaxSize().background(BasuColor.bg).semantics { contentDescription = "Basu" }.testTag("splash")) {
    Wordmark(Modifier.align(Alignment.Center))
    Text(
      "УЛААНБААТАР",
      Modifier.align(Alignment.BottomCenter).padding(bottom = 44.dp),
      color = BasuColor.ink3,
      style = sans(12, FontWeight.Bold).tracked(0.18),
    )
  }
}

@Composable
private fun Wordmark(modifier: Modifier = Modifier) {
  Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
    Text("Basu", color = BasuColor.ink, style = display(64))
    Box(Modifier.width(34.dp).height(2.dp).background(BasuColor.gold, RoundedCornerShape(1.dp)))
  }
}

/**
 * What stands over the shell while it is locked or away: the splash's
 * wordmark and, locked, the one button. It asks once by itself on arrival —
 * asking again on its own after a cancel would bring the prompt straight
 * back over a person who has just said no.
 */
@Composable
fun LockView() {
  val lock = LocalAppLock.current
  val scope = rememberCoroutineScope()
  var asked by remember { mutableStateOf(false) }

  LifecycleResumeEffect(lock.locked) {
    if (lock.locked && !asked) {
      asked = true
      scope.launch { lock.unlock() }
    }
    onPauseOrDispose {}
  }

  Box(Modifier.fillMaxSize().background(BasuColor.bg).plainClick(role = null) {}.testTag("lock")) {
    Wordmark(Modifier.align(Alignment.Center))
    if (lock.locked) {
      // The screen's one thing to do: the crimson capsule.
      Row(
        Modifier
          .align(Alignment.BottomCenter)
          .padding(bottom = 60.dp)
          .glow()
          .background(BasuColor.accent, CircleShape)
          .clip(CircleShape)
          .pressable { scope.launch { lock.unlock() } }
          .height(BasuMetric.buttonHeight)
          .padding(horizontal = 28.dp)
          .testTag("lock.open"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Symbol(
          if (lock.kind == AppLock.Kind.Biometric) Icons.Outlined.Fingerprint else Icons.Outlined.Lock,
          BasuColor.onAccent,
          size = 20.dp,
        )
        Text("${lock.kind.by.replaceFirstChar { it.uppercase() }} нээх", color = BasuColor.onAccent, style = sans(16, FontWeight.Bold))
      }
    }
  }
}

/**
 * The bar: a dark glass capsule floating just above the foot of the screen,
 * four tabs of equal width, each its mark over its name; the chosen one is an
 * off-white pill with dark words on it.
 *
 * It carries the shell and nothing else — the apps are tiles on the launcher,
 * never tabs. The pill slides between tabs and the phone ticks as it lands.
 */
@Composable
fun TabBar(tab: ShellTab, bottom: Dp, select: (ShellTab) -> Unit) {
  val haptics = LocalHapticFeedback.current
  val tabs = ShellTab.entries
  BoxWithConstraints(
    Modifier
      .padding(horizontal = 16.dp)
      .padding(bottom = maxOf(bottom + 6.dp, 14.dp))
      .fillMaxWidth()
      .shadow(18.dp, CircleShape, clip = false, ambientColor = Color.Black, spotColor = Color.Black)
      .background(BasuColor.bar, CircleShape)
      .border(BasuMetric.hairline, BasuColor.barEdge, CircleShape)
      .padding(6.dp),
  ) {
    val each = maxWidth / tabs.size
    val x by animateDpAsState(
      each * tabs.indexOf(tab),
      spring(dampingRatio = 0.82f, stiffness = Spring.StiffnessMediumLow),
      label = "pill",
    )
    Box(Modifier.offset(x = x).width(each).height(56.dp).background(BasuColor.ink, CircleShape))
    Row {
      for (item in tabs) {
        val active = item == tab
        val colour = if (active) BasuColor.onLight else BasuColor.ink3
        Column(
          Modifier
            .weight(1f)
            .height(56.dp)
            .clip(CircleShape)
            .plainClick(role = Role.Tab) {
              if (!active) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
              select(item)
            }
            .semantics {
              selected = active
              contentDescription = item.title
            }
            .testTag("tab.${item.tag}"),
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
        ) {
          ShellGlyph(
            when (item) {
              ShellTab.Home -> ShellMark.Home
              ShellTab.Orders -> ShellMark.Orders
              ShellTab.Wallet -> ShellMark.Wallet
              ShellTab.Profile -> ShellMark.Profile
            },
            colour,
            size = 22.dp,
            lineWidth = if (active) 1.9f else 1.75f,
          )
          FitText(item.title, sans(11, FontWeight.Bold), colour, minScale = 0.8f)
        }
      }
    }
  }
}
