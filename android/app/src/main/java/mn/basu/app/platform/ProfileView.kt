package mn.basu.app.platform

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.BackHand
import androidx.compose.material.icons.outlined.CardGiftcard
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.LockReset
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Sms
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import coil.annotation.ExperimentalCoilApi
import coil.imageLoader
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import mn.basu.app.BuildConfig
import mn.basu.app.auth.SignInPrompt
import mn.basu.app.core.ApiError
import mn.basu.app.core.AppLock
import mn.basu.app.core.AuthMethods
import mn.basu.app.core.Endpoint
import mn.basu.app.core.Format
import mn.basu.app.core.LocalAppLock
import mn.basu.app.core.LocalAppModel
import mn.basu.app.core.LocalPlatform
import mn.basu.app.core.LocalPush
import mn.basu.app.core.LocalSession
import mn.basu.app.core.Me
import mn.basu.app.core.Session
import mn.basu.app.core.openInBrowser
import mn.basu.app.design.AuthValue
import mn.basu.app.design.Banner
import mn.basu.app.design.BasuAlert
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.BasuTextField
import mn.basu.app.design.Chevron
import mn.basu.app.design.CodeInput
import mn.basu.app.design.FitText
import mn.basu.app.design.Hairline
import mn.basu.app.design.Note
import mn.basu.app.design.PasswordField
import mn.basu.app.design.PrimaryButton
import mn.basu.app.design.ProfileSheet
import mn.basu.app.design.QuietLink
import mn.basu.app.design.RevealButton
import mn.basu.app.design.SectionLabel
import mn.basu.app.design.SeedAvatar
import mn.basu.app.design.ShellTitle
import mn.basu.app.design.Symbol
import mn.basu.app.design.TroubleNote
import mn.basu.app.design.WideButton
import mn.basu.app.design.WideKind
import mn.basu.app.design.card
import mn.basu.app.design.display
import mn.basu.app.design.plainClick
import mn.basu.app.design.sans
import mn.basu.app.shell.navBottom
import kotlin.coroutines.cancellation.CancellationException

/**
 * The address sheet opened from the password row is `EmailFirst`: an account
 * with no address adds one first, and the sheet says that is why.
 */
private enum class Field { Name, Email, EmailFirst, Password }

/**
 * The profile: who you are, who may open Basu on this phone, and what Basu is
 * allowed to send you.
 *
 * There is no light-or-dark choice: Basu is dark on every screen whatever the
 * phone's own setting («Тансаг хар», 2026-10-05).
 *
 * Short on purpose. A profile that grows a field per product stops being one
 * person and becomes four apps sharing a form — table preference here,
 * drop-off address there. Anything only one app cares about belongs to that
 * app.
 *
 * Every switch here does what it says, today. The language row came off for
 * that reason: the app speaks Mongolian only, and a choice of English that
 * changed nothing was a setting in name only. The SMS row goes the same way on
 * a server with no SMS gateway — the pilot has none yet — and comes back by
 * itself when it has one.
 *
 * What cannot be undone is asked in an alert, which always draws «Болих».
 */
@Composable
fun ProfileView() {
  val platform = LocalPlatform.current
  val session = LocalSession.current
  val model = LocalAppModel.current
  val push = LocalPush.current
  val scope = rememberCoroutineScope()

  var editing by remember { mutableStateOf<Field?>(null) }
  var closing by remember { mutableStateOf(false) }
  // The server's no to closing, in its own words: money still in the wallet,
  // an order still running.
  var closeRefusal by remember { mutableStateOf<String?>(null) }
  var signingOutOthers by remember { mutableStateOf(false) }
  // What the last password change did, said under the card it was made from.
  var passwordNote by remember { mutableStateOf<String?>(null) }
  // The ways the server can reach somebody: no gateway, no SMS switch.
  var methods by remember { mutableStateOf<AuthMethods?>(null) }

  LaunchedEffect(session.token) {
    platform.refresh()
    platform.loadPreferences()
    platform.loadSessions()
  }
  LaunchedEffect(session.token) {
    methods = session.methods()
  }
  // Back from the phone's Settings, where the answer may have changed.
  LifecycleResumeEffect(Unit) {
    push.look()
    onPauseOrDispose {}
  }

  Column(Modifier.fillMaxSize().background(BasuColor.bg)) {
    ShellTitle("Профайл")
    Column(
      Modifier
        .fillMaxSize()
        .verticalScroll(rememberScrollState())
        .padding(horizontal = BasuMetric.screenPadding)
        .padding(top = 4.dp, bottom = BasuMetric.tabBarInset + navBottom()),
      verticalArrangement = Arrangement.spacedBy(32.dp),
    ) {
      if (session.isSignedIn) {
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
          Identity(addName = { editing = Field.Name })
          // Said where it is seen on arrival, not at the foot of the page
          // under the tab bar.
          platform.trouble?.let { Banner(it, Modifier.testTag("profile.trouble")) }
        }
        Fields(passwordNote = passwordNote, edit = { editing = it })
        Settings()
        Notifications(methods)
        DevicesSection(confirmOthers = { signingOutOthers = true })
        Help()
        // Reversible, so not crimson: an outlined capsule, the way out.
        WideButton("Гарах", Modifier.testTag("profile.signout"), kind = WideKind.Quiet) {
          platform.signOut()
          scope.launch {
            model.refreshLive()
            platform.refresh()
          }
        }
        CloseAccount { closing = true }
      } else {
        // Looking around (see `RootView`): the way in, and what is this
        // phone's rather than the account's — the help.
        SignInPrompt(
          symbol = Icons.Outlined.AccountCircle,
          title = "Нэвтэрч захиалаарай",
          detail = "Google эсвэл имэйлээр нэг алхамд.",
          modifier = Modifier.padding(top = 8.dp),
          id = "profile.signin",
        )
        Help()
      }
    }
  }

  when (editing) {
    Field.Name -> ProfileEditSheet(onDismiss = { editing = null })
    Field.Email -> EmailAttachSheet(onDismiss = { editing = null })
    Field.EmailFirst -> EmailAttachSheet(onDismiss = { editing = null }, forPassword = true)
    Field.Password -> PasswordChangeSheet(
      onDismiss = { editing = null },
      // Every other device is signed out by a new password; saying how many
      // is what tells somebody who changed it after a lost phone that it
      // worked.
      changed = { revoked, first ->
        val done = if (first) "Нууц үг тохирууллаа." else "Нууц үг солигдлоо."
        passwordNote = if (revoked > 0) "$done Бусад $revoked төхөөрөмжөөс гаргалаа." else done
      },
    )
    null -> {}
  }

  if (signingOutOthers) {
    BasuAlert(
      title = "Бусад бүх төхөөрөмжөөс гарах уу?",
      message = "Энэ утас нэвтэрсэн хэвээр үлдэнэ.",
      confirm = "Гаргах",
      destructive = true,
      cancel = "Болих",
      onConfirm = {
        signingOutOthers = false
        scope.launch { platform.signOutOtherDevices() }
      },
      onDismiss = { signingOutOthers = false },
    )
  }
  if (closing) {
    BasuAlert(
      title = "Бүртгэлээ бүрмөсөн хаах уу?",
      message = "Нэр, утас, мэдэгдэл устана. Хийсэн гүйлгээ, татварын баримт хуулийн дагуу үлдэнэ. Буцаах боломжгүй.",
      confirm = "Бүртгэлээ устгах",
      destructive = true,
      cancel = "Болих",
      onConfirm = {
        closing = false
        scope.launch { closeRefusal = platform.closeAccount() }
      },
      onDismiss = { closing = false },
    )
  }
  // A refusal — money still in the wallet, an order still running — comes
  // back as an alert of its own: a banner here sat under the tab bar, out of
  // sight.
  closeRefusal?.let { refusal ->
    BasuAlert(
      title = "Бүртгэлийг хааж чадсангүй",
      message = refusal,
      confirm = "Ойлголоо",
      onConfirm = { closeRefusal = null },
      onDismiss = { closeRefusal = null },
    )
  }
}

// ── who ─────────────────────────────────────────────────────────────────

@Composable
private fun Identity(addName: () -> Unit) {
  val platform = LocalPlatform.current
  val session = LocalSession.current
  val me = platform.me
  Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
    SeedAvatar(me?.avatarSeed ?: "00000000", size = BasuMetric.avatarProfile)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Headline(addName)
      // Figures tabular, so a number reads in its groups.
      val phone = me?.phone ?: if (me == null) session.phone else null
      val email = me?.email ?: session.email
      if (phone != null) {
        Text(
          spaced(phone),
          color = BasuColor.ink2,
          style = sans(15, FontWeight.SemiBold).copy(fontFeatureSettings = "tnum"),
        )
      } else if (email != null) {
        Text(
          email,
          color = BasuColor.ink2,
          style = sans(15, FontWeight.SemiBold),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
      if (me != null) {
        Text("Basu-д ${Format.since(me.memberSince)} хойш", color = BasuColor.ink3, style = sans(13, FontWeight.Medium))
      }
    }
  }
}

/**
 * The name — or, for an account that has none yet, the way to give one,
 * where the name goes. Every new account used to be headed «Нэргүй» in 24
 * points, which reads as a fault rather than a field nobody has filled.
 */
@Composable
private fun Headline(addName: () -> Unit) {
  val me = LocalPlatform.current.me
  val name = me?.displayName?.trim()
  if (!name.isNullOrEmpty()) {
    Text(name, color = BasuColor.ink, style = display(29))
  } else if (me != null) {
    Row(
      Modifier.plainClick(onClick = addName).testTag("profile.addName"),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text("Нэрээ оруулах", color = BasuColor.ink, style = display(29))
      Chevron(BasuColor.ink3, size = 14.dp, lineWidth = 2.2f)
    }
  } else {
    // Still on its way: the shape of a name, not a word that is wrong.
    Text(
      "Батаа Болд",
      Modifier.background(BasuColor.surface3, RoundedCornerShape(BasuMetric.small)).clearAndSetSemantics {},
      color = Color.Transparent,
      style = display(29),
    )
  }
}

/** `+97699001122` → `+976 9900 1122`. A phone number is read in groups. */
private fun spaced(phone: String): String {
  if (!phone.startsWith("+976") || phone.length != 12) return phone
  val digits = phone.drop(4)
  return "+976 ${digits.take(4)} ${digits.takeLast(4)}"
}

// ── what ────────────────────────────────────────────────────────────────

@Composable
private fun Fields(passwordNote: String?, edit: (Field) -> Unit) {
  val me = LocalPlatform.current.me
  Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
    SectionLabel("Бүртгэл")
    Column(Modifier.fillMaxWidth().card()) {
      Row(
        Modifier
          .fillMaxWidth()
          .testTag("profile.name")
          .plainClick { edit(Field.Name) }
          .padding(horizontal = 16.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        RowLabel("Нэр", Icons.Outlined.Person)
        // The row's own word keeps its width; the name gives way.
        Box(Modifier.weight(1f).padding(start = 8.dp), contentAlignment = Alignment.CenterEnd) {
          FitText(
            me?.displayName ?: "—",
            sans(15, FontWeight.Medium),
            if (me?.displayName == null) BasuColor.ink3 else BasuColor.ink,
            minScale = 0.6f,
          )
        }
        Chevron(BasuColor.ink3, size = 13.dp)
      }

      // A server that does not say whether there is a password has neither
      // the changing of one nor the address to get one back with: rather
      // than two rows that fail when tapped, none.
      val hasPassword = me?.hasPassword
      if (me != null && hasPassword != null) {
        Hairline()
        EmailRow(me) { edit(Field.Email) }
        Hairline()
        PasswordRow(hasPassword = hasPassword, hasEmail = me.email != null, edit = edit)
      }
    }

    if (passwordNote != null) {
      Row(
        Modifier.semantics(mergeDescendants = true) {}.testTag("profile.password.note"),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        Symbol(Icons.Outlined.Check, BasuColor.ready, Modifier.padding(top = 2.dp), size = 12.dp)
        Text(passwordNote, color = BasuColor.ink2, style = sans(12))
      }
    }
  }
}

/**
 * The address on the account, or the way to add one.
 *
 * Without one, a forgotten password is a locked door: there is no SMS, and
 * the code that replaces a password goes to an inbox. The row says so, since
 * nobody adds an address for its own sake.
 */
@Composable
private fun EmailRow(me: Me, add: () -> Unit) {
  val email = me.email
  if (email != null) {
    Row(
      Modifier
        .fillMaxWidth()
        .semantics(mergeDescendants = true) {}
        .testTag("profile.email")
        .padding(horizontal = 16.dp, vertical = 14.dp),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      RowLabel("Имэйл", Icons.Outlined.AlternateEmail)
      Box(Modifier.weight(1f).padding(start = 8.dp), contentAlignment = Alignment.CenterEnd) {
        Text(
          email,
          color = BasuColor.ink,
          style = sans(15, FontWeight.Medium),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
  } else {
    Row(
      Modifier
        .fillMaxWidth()
        .testTag("profile.email")
        .plainClick(onClick = add)
        .padding(horizontal = 16.dp, vertical = 14.dp),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      RowLabel(
        "Имэйл холбох",
        Icons.Outlined.AlternateEmail,
        Modifier.weight(1f).padding(end = 8.dp),
        detail = "Нууц үгээ мартвал энэ хаягаар сэргээнэ",
      )
      Chevron(BasuColor.ink3, size = 13.dp)
    }
  }
}

/**
 * The password: changed, or set for the first time. A first password is set
 * with a code sent to the address on the account, so an account with no
 * address adds one first — the row says so, and opens that sheet instead,
 * which says it again at its top.
 */
@Composable
private fun PasswordRow(hasPassword: Boolean, hasEmail: Boolean, edit: (Field) -> Unit) {
  val needsAddress = !hasPassword && !hasEmail
  Row(
    Modifier
      .fillMaxWidth()
      .testTag("profile.password")
      .plainClick { edit(if (needsAddress) Field.EmailFirst else Field.Password) }
      .padding(horizontal = 16.dp, vertical = 14.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    RowLabel(
      if (hasPassword) "Нууц үг солих" else "Нууц үг тохируулах",
      Icons.Outlined.Key,
      Modifier.weight(1f).padding(end = 8.dp),
      detail = when {
        hasPassword -> null
        needsAddress -> "Эхлээд имэйлээ холбоно уу — тохируулах код тэр хаяг руу очно"
        else -> "Имэйл эсвэл утас, нууц үгээр нэвтрэхийн тулд"
      },
    )
    Chevron(BasuColor.ink3, size = 13.dp)
  }
}

// ── this phone ──────────────────────────────────────────────────────────

/**
 * Who may open Basu on this phone — about this phone, not the account, and
 * kept on it. (How Basu looks is no longer a choice: it is dark.)
 */
@Composable
private fun Settings() {
  val lock = LocalAppLock.current
  val kind = lock.kind
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    SectionLabel("Тохиргоо")
    Column(Modifier.fillMaxWidth().card()) {
      if (kind == AppLock.Kind.None) {
        RowLabel(
          "Апп түгжих",
          Icons.Outlined.Lock,
          Modifier
            .fillMaxWidth()
            .testTag("settings.lock")
            .alpha(0.6f)
            .padding(horizontal = 16.dp, vertical = 13.dp),
          detail = "Утсандаа нууц код тавьсны дараа асаана",
        )
      } else {
        SwitchRow(
          // A row's name starts with a capital; `by` is written for mid-sentence.
          "${kind.by.replaceFirstChar { it.uppercase() }} түгжих",
          if (kind == AppLock.Kind.Biometric) Icons.Outlined.Fingerprint else Icons.Outlined.Lock,
          detail = "Нээх бүрд таныг мөн эсэхийг шалгана",
          isOn = lock.enabled,
          id = "settings.lock",
        ) { lock.turn(it) }
      }
    }

    val minutes = AppLock.GRACE_MS / 60_000
    Text(
      "Түгжээтэй үед $minutes минутаас удаан гарвал ${kind.by} нээнэ.",
      color = BasuColor.ink3,
      style = sans(13, FontWeight.Medium),
    )
  }
}

// ── what we may send ────────────────────────────────────────────────────

@Composable
private fun Notifications(methods: AuthMethods?) {
  val platform = LocalPlatform.current
  val push = LocalPush.current
  Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
    SectionLabel("Мэдэгдэл")
    Column(Modifier.fillMaxWidth().card().clip(RoundedCornerShape(BasuMetric.card))) {
      if (!push.allowed) {
        PermissionRow(denied = !push.undetermined)
        Hairline()
      }
      SwitchRow(
        "Апп-аар",
        Icons.Outlined.Notifications,
        detail = "Захиалга, түрийвчийн мэдээ шууд утсанд",
        isOn = platform.preferences.push,
        id = "profile.pref.push",
      ) { platform.setPreference(push = it) }
      // Only where SMS can actually be sent. A switch that is on and does
      // nothing is the one kind this screen does not have.
      if (methods?.sms == true) {
        Hairline()
        SwitchRow(
          "SMS-ээр",
          Icons.Outlined.Sms,
          detail = "Апп-аар хүрэхгүй үед мессежээр",
          isOn = platform.preferences.sms,
          id = "profile.pref.sms",
        ) { platform.setPreference(sms = it) }
      }
      Hairline()
      SwitchRow(
        "Урамшуулал",
        Icons.Outlined.CardGiftcard,
        detail = "Шинэ үйлчилгээ, хямдралын тухай",
        isOn = platform.preferences.marketing,
        id = "profile.pref.marketing",
      ) { platform.setPreference(marketing = it) }
    }

    // Being honest about what cannot be switched off is the difference
    // between a setting and a lie.
    Text("Захиалгын явцын мэдэгдэл үргэлж ирнэ.", color = BasuColor.ink3, style = sans(13, FontWeight.Medium))
  }
}

/**
 * The phone's own answer comes before Basu's switches: with notifications
 * refused in Android, «Апп-аар» on changes nothing, and saying so is kinder
 * than a switch that silently does not work.
 */
@Composable
private fun PermissionRow(denied: Boolean) {
  val push = LocalPush.current
  val scope = rememberCoroutineScope()
  Row(
    Modifier
      .fillMaxWidth()
      .background(BasuColor.surface2)
      .padding(horizontal = 16.dp, vertical = 13.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    RowLabel(
      if (denied) "Утасны тохиргоонд хаалттай" else "Зөвшөөрөл өгөөгүй",
      Icons.Outlined.NotificationsOff,
      Modifier.weight(1f).padding(end = 8.dp),
      detail = "Мэдэгдэл утсанд ирэхгүй байна",
      tint = BasuColor.hold,
    )
    Box(
      Modifier
        .defaultMinSize(minHeight = BasuMetric.minTarget)
        .testTag("profile.permission")
        .plainClick {
          if (denied) push.openSettings() else scope.launch { push.askIfNeeded() }
        },
      contentAlignment = Alignment.Center,
    ) {
      Box(
        Modifier
          .defaultMinSize(minHeight = 36.dp)
          .background(BasuColor.ink, CircleShape)
          .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
      ) {
        Text(if (denied) "Нээх" else "Зөвшөөрөх", color = BasuColor.onLight, style = sans(14, FontWeight.Bold), maxLines = 1)
      }
    }
  }
}

/** A row that is a switch: the whole row toggles, and is the switch to TalkBack. */
@Composable
private fun SwitchRow(
  name: String,
  symbol: ImageVector,
  detail: String? = null,
  isOn: Boolean,
  id: String,
  set: suspend (Boolean) -> Unit,
) {
  val scope = rememberCoroutineScope()
  val haptics = LocalHapticFeedback.current
  Row(
    Modifier
      .fillMaxWidth()
      .testTag(id)
      .toggleable(
        value = isOn,
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
        role = Role.Switch,
      ) { on ->
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        scope.launch { set(on) }
      }
      .semantics { stateDescription = if (isOn) "асаалттай" else "унтраалттай" }
      .padding(horizontal = 16.dp, vertical = 13.dp),
    horizontalArrangement = Arrangement.spacedBy(14.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    RowLabel(name, symbol, Modifier.weight(1f).padding(end = 8.dp), detail = detail)
    BasuSwitch(isOn)
  }
}

// ── the footer everything else lives in ─────────────────────────────────

/**
 * The terms and the privacy policy are the pages the server serves itself —
 * the same ones the web links to — so they open wherever the app is talking
 * to.
 */
@Composable
private fun Help() {
  val context = LocalContext.current
  Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
    SectionLabel("Тусламж")
    Column(Modifier.fillMaxWidth().card()) {
      LinkRow("Холбоо барих", Icons.Outlined.Email) {
        try {
          context.startActivity(
            Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:basuappmn@gmail.com")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
        } catch (_: Exception) {
          // A phone with no mail app has nowhere to send this.
        }
      }
      Hairline()
      LinkRow("Үйлчилгээний нөхцөл", Icons.Outlined.Description) {
        openInBrowser(context, Uri.parse(Endpoint.base + "/terms"))
      }
      Hairline()
      LinkRow("Нууцлалын бодлого", Icons.Outlined.BackHand) {
        openInBrowser(context, Uri.parse(Endpoint.base + "/privacy"))
      }
      Hairline()
      ClearCache()
    }

    // The version, because the first thing anybody is asked when they report
    // something is which build they are on, and nobody knows.
    SelectionContainer {
      Text(
        "Basu ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
        color = BasuColor.ink3,
        style = sans(12, FontWeight.SemiBold).copy(fontFeatureSettings = "tnum"),
      )
    }
  }
}

@Composable
private fun LinkRow(title: String, symbol: ImageVector, open: () -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .plainClick(onClick = open)
      .padding(horizontal = 16.dp, vertical = 14.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    RowLabel(title, symbol, Modifier.weight(1f).padding(end = 8.dp))
    Chevron(BasuColor.ink3, size = 13.dp)
  }
}

/**
 * The apps inside Basu are web pages, and a page kept from last week can show
 * last week's picture. This throws the kept copies away — only copies: nobody
 * is signed out, and nothing of theirs is lost.
 */
@Composable
private fun ClearCache() {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  var cacheCleared by remember { mutableStateOf(false) }
  Row(
    Modifier
      .fillMaxWidth()
      .testTag("settings.cache")
      .plainClick {
        scope.launch {
          clearKeptCopies(context)
          cacheCleared = true
          delay(3000)
          cacheCleared = false
        }
      }
      .padding(horizontal = 16.dp, vertical = 14.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    RowLabel(
      "Кэш цэвэрлэх",
      Icons.Outlined.Refresh,
      Modifier.weight(1f).padding(end = 8.dp),
      detail = if (cacheCleared) "Цэвэрлэлээ" else "Хуудас хуучин эсвэл буруу харагдвал",
    )
    AnimatedVisibility(cacheCleared, enter = fadeIn(tween(200)), exit = fadeOut(tween(200))) {
      Symbol(Icons.Outlined.Check, BasuColor.ready, size = 16.dp)
    }
  }
}

/** The web view's kept pages and the pictures' — the cache only: cookies and what a page stored stay. */
@OptIn(ExperimentalCoilApi::class)
private fun clearKeptCopies(context: Context) {
  runCatching {
    val web = WebView(context)
    web.clearCache(true)
    web.destroy()
  }
  runCatching {
    val loader = context.imageLoader
    loader.memoryCache?.clear()
    loader.diskCache?.clear()
  }
}

/**
 * Leaving, for good.
 *
 * An app that makes accounts has to let somebody close theirs from inside it
 * — not by email, not by ringing anybody. Set apart from «Гарах» and worded so
 * the two cannot be confused, because one of them is reversible and the other
 * is not; and the button that does it says «устгах», never «Хаах», which
 * everywhere else in the app is the word that closes a sheet.
 */
@Composable
private fun CloseAccount(ask: () -> Unit) {
  Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
    // Crimson words and nothing else: the alert asks before anything goes.
    Box(
      Modifier
        .defaultMinSize(minHeight = BasuMetric.minTarget)
        .testTag("profile.close")
        .plainClick(onClick = ask)
        .padding(horizontal = 12.dp),
      contentAlignment = Alignment.Center,
    ) {
      Text("Бүртгэл хаах", color = BasuColor.accentInk, style = sans(14, FontWeight.SemiBold))
    }
  }
}

/**
 * A row's leading half: the mark, the name, and a line under it when the
 * name alone would leave somebody guessing what the row does.
 */
@Composable
fun RowLabel(
  title: String,
  symbol: ImageVector,
  modifier: Modifier = Modifier,
  detail: String? = null,
  tint: Color = BasuColor.ink2,
) {
  Row(modifier, horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
    Box(Modifier.widthIn(min = 24.dp), contentAlignment = Alignment.Center) {
      Symbol(symbol, tint, size = 20.dp)
    }
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
      Text(title, color = BasuColor.ink, style = sans(16, FontWeight.SemiBold))
      if (detail != null) {
        Text(detail, color = BasuColor.ink3, style = sans(13, FontWeight.Medium))
      }
    }
  }
}

/**
 * The switch, to the design's metrics: a 51 × 31 track at radius 16 — the ink
 * when on, with a charcoal knob; `surface3` when off, with a knob in `ink3`.
 * No green: on is the brightest thing on the row, which is all on has to be.
 *
 * Drawn rather than borrowed because the system toggle is tinted. The row it
 * sits in is the control — the whole row toggles, and is the switch to
 * TalkBack.
 */
@Composable
fun BasuSwitch(isOn: Boolean, modifier: Modifier = Modifier) {
  val track = RoundedCornerShape(16.dp)
  val slide by animateDpAsState(if (isOn) 20.dp else 0.dp, tween(180), label = "switch")
  Box(
    modifier
      .size(width = 51.dp, height = 31.dp)
      .background(if (isOn) BasuColor.ink else BasuColor.surface3, track)
      .border(BasuMetric.hairline, if (isOn) Color.Transparent else BasuColor.line2, track)
      .clearAndSetSemantics {},
    contentAlignment = Alignment.CenterStart,
  ) {
    Box(
      Modifier
        .padding(2.dp)
        .offset(x = slide)
        .size(27.dp)
        .shadow(1.5.dp, CircleShape)
        .background(if (isOn) BasuColor.onLight else BasuColor.ink3, CircleShape),
    )
  }
}

/** Takes `by` off the top and the foot of what it is on: a thumb's target that sits closer to its neighbours. */
private fun Modifier.tighten(by: Dp): Modifier = layout { measurable, constraints ->
  val placeable = measurable.measure(constraints)
  val cut = by.roundToPx()
  layout(placeable.width, (placeable.height - cut * 2).coerceAtLeast(0)) { placeable.place(0, -cut) }
}

/** Focus asked for something that may only just have been drawn. */
private suspend fun FocusRequester.askSoon() {
  withFrameNanos {}
  runCatching { requestFocus() }
}

/**
 * The one field being changed, on its own.
 *
 * A row that turns into a text field in place is a row that moves under the
 * thumb and loses what was typed on the next refresh. A sheet has a button
 * that says what it does, which is what «I have finished» looks like.
 */
@Composable
fun ProfileEditSheet(onDismiss: () -> Unit) {
  val platform = LocalPlatform.current
  val scope = rememberCoroutineScope()
  var name by remember { mutableStateOf(platform.me?.displayName ?: "") }
  var busy by remember { mutableStateOf(false) }
  var trouble by remember { mutableStateOf<String?>(null) }

  val ready = !busy && name.trim().isNotEmpty()

  fun save() {
    if (!ready) return
    scope.launch {
      busy = true
      trouble = null
      try {
        if (platform.save(displayName = name.trim(), locale = null)) {
          onDismiss()
        } else {
          trouble = platform.trouble ?: "Хадгалж чадсангүй. Дахин оролдоно уу."
        }
      } finally {
        busy = false
      }
    }
  }

  ProfileSheet(title = "Нэр", onDismiss = onDismiss) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
      BasuTextField(
        value = name,
        onValueChange = { name = it },
        placeholder = "Таныг юу гэж дуудах вэ?",
        symbol = Icons.Outlined.Person,
        capitalization = KeyboardCapitalization.Words,
        imeAction = ImeAction.Done,
        onImeAction = { save() },
        tag = "profile.name.field",
      )
      trouble?.let { TroubleNote(it, id = "profile.name.trouble") }
      Note("Захиалга дээр энэ нэр харагдана — ресторан, нийлүүлэгч таныг ингэж танина.")
      PrimaryButton("Хадгалах", enabled = ready, busy = busy, modifier = Modifier.testTag("profile.name.save")) { save() }
    }
  }
}

/**
 * An address, for an account that has none: the way back when a password is
 * forgotten, since the code that replaces one goes to an inbox.
 *
 * A code goes to the address first, so an address is never somebody else's.
 * An account with a password types it too — a session can be stolen, and a
 * stolen one must not be able to give itself a way back in. One without a
 * password has nothing to type: the server asks it to have signed in a moment
 * ago, and says so in its refusal when it has not.
 *
 * `forPassword`: opened from «Нууц үг тохируулах» — the address comes before
 * the password, and the sheet says so rather than leaving somebody wondering
 * why they asked for one thing and got another.
 */
@Composable
fun EmailAttachSheet(onDismiss: () -> Unit, forPassword: Boolean = false) {
  val platform = LocalPlatform.current
  val scope = rememberCoroutineScope()
  var email by remember { mutableStateOf("") }
  var password by remember { mutableStateOf("") }
  var reveal by remember { mutableStateOf(false) }
  var code by remember { mutableStateOf("") }
  // The address the code went to. Typing another starts over.
  var sentTo by remember { mutableStateOf<String?>(null) }
  var busy by remember { mutableStateOf(false) }
  var trouble by remember { mutableStateOf<String?>(null) }
  val passwordFocus = remember { FocusRequester() }
  val codeFocus = remember { FocusRequester() }

  val needsPassword = platform.me?.hasPassword == true
  val sent = sentTo

  val footer = if (sent != null) {
    "$sent хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай."
  } else {
    val why = "Нууц үгээ мартвал энэ хаяг руу код ирж, шинэ нууц үг тавина. Хаяг таных гэдгийг батлах 6 оронтой код илгээнэ."
    if (needsPassword) "$why Бүртгэл таных гэдгийг нууц үгээр баталгаажуулна." else why
  }

  val ready = when {
    busy -> false
    sent != null -> code.length == 6
    else -> Session.address(email).contains("@") && (!needsPassword || password.isNotEmpty())
  }

  suspend fun send() {
    if (busy || !Session.address(email).contains("@") || (needsPassword && password.isEmpty())) return
    busy = true
    trouble = null
    try {
      platform.requestEmailCode(email, if (needsPassword) password else null)
      sentTo = Session.address(email)
      code = ""
      codeFocus.askSoon()
    } catch (error: ApiError) {
      trouble = error.message
      if (error.code == "WRONG_PASSWORD") runCatching { passwordFocus.requestFocus() }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      trouble = "Код илгээж чадсангүй. Дахин оролдоно уу."
    } finally {
      busy = false
    }
  }

  suspend fun confirm() {
    val to = sentTo
    if (busy || to == null || code.length != 6) return
    busy = true
    trouble = null
    try {
      platform.attachEmail(to, code)
      onDismiss()
    } catch (error: ApiError) {
      trouble = error.message
      code = ""
      runCatching { codeFocus.requestFocus() }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      trouble = "Холбож чадсангүй. Дахин оролдоно уу."
    } finally {
      busy = false
    }
  }

  ProfileSheet(title = "Имэйл холбох", onDismiss = onDismiss, full = true) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
      if (forPassword) {
        Row(
          Modifier
            .fillMaxWidth()
            .background(BasuColor.surface, RoundedCornerShape(BasuMetric.inner))
            .padding(14.dp)
            .semantics(mergeDescendants = true) {}
            .testTag("profile.email.why"),
          horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
          Symbol(Icons.Outlined.Key, BasuColor.gold, size = 18.dp)
          Text(
            "Нууц үг тохируулахын өмнө имэйлээ холбоно уу — тохируулах код тэр хаяг руу очно.",
            Modifier.weight(1f),
            color = BasuColor.ink,
            style = sans(14),
          )
        }
      }

      Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        BasuTextField(
          value = email,
          onValueChange = { typed ->
            email = typed
            // Another address after a code went out is a new start, not a
            // code for the old one.
            if (sentTo != null && Session.address(typed) != sentTo) {
              sentTo = null
              code = ""
            }
          },
          placeholder = "Имэйл хаяг",
          symbol = Icons.Outlined.Email,
          keyboardType = KeyboardType.Email,
          imeAction = if (needsPassword) ImeAction.Next else ImeAction.Send,
          onImeAction = {
            if (needsPassword) runCatching { passwordFocus.requestFocus() } else scope.launch { send() }
          },
          tag = "profile.email.field",
        )

        if (needsPassword) {
          PasswordField(
            title = "Одоогийн нууц үг",
            text = password,
            onChange = { password = it },
            reveal = reveal,
            symbol = Icons.Outlined.Lock,
            focus = passwordFocus,
            imeAction = ImeAction.Send,
            onImeAction = { scope.launch { send() } },
            tag = "profile.email.password",
            trailing = { RevealButton(reveal) { reveal = !reveal } },
          )
        }

        if (sent != null) {
          CodeInput(
            code = code,
            onChange = { digits ->
              code = digits
              // Six digits is the whole code: it goes without another tap.
              if (digits.length == 6) scope.launch { confirm() }
            },
            focus = codeFocus,
            tag = "profile.email.code",
          )
        }

        trouble?.let { TroubleNote(it, id = "profile.email.trouble") }

        Note(footer)

        PrimaryButton(
          if (sent == null) "Код авах" else "Холбох",
          enabled = ready,
          busy = busy,
          modifier = Modifier.testTag("profile.email.go"),
        ) {
          scope.launch { if (sentTo == null) send() else confirm() }
        }

        if (sent != null) {
          QuietLink("Код дахин авах", Modifier.align(Alignment.CenterHorizontally).tighten(8.dp)) {
            scope.launch { send() }
          }
        }
      }
    }
  }
}

/**
 * A password: changed knowing the old one, or chosen for the first time by an
 * account made by email, Google or Apple, which has none to know.
 *
 * The first is never set on this phone's word alone. A session is only
 * something somebody holds, and one left signed in somewhere would give its
 * holder a password of their own and sign the owner out everywhere with it.
 * So it is two steps, like the address sheet: a code to the address on the
 * account — the server sends it nowhere else — then the code and the new
 * password.
 *
 * Every other session ends — whoever knew the old password is out — and this
 * phone stays signed in. The profile says how many went (`changed`: how many
 * other devices were signed out, and whether it was the first).
 */
@Composable
fun PasswordChangeSheet(onDismiss: () -> Unit, changed: (revoked: Int, first: Boolean) -> Unit) {
  val platform = LocalPlatform.current
  val scope = rememberCoroutineScope()
  var current by remember { mutableStateOf("") }
  var code by remember { mutableStateOf("") }
  var next by remember { mutableStateOf("") }
  var again by remember { mutableStateOf("") }
  // Where the first password's code went. Until it has gone there is nothing
  // to set a first password with.
  var sentTo by remember { mutableStateOf<String?>(null) }
  var reveal by remember { mutableStateOf(false) }
  var busy by remember { mutableStateOf(false) }
  var trouble by remember { mutableStateOf<String?>(null) }
  val currentFocus = remember { FocusRequester() }
  val codeFocus = remember { FocusRequester() }
  val nextFocus = remember { FocusRequester() }
  val againFocus = remember { FocusRequester() }

  val hasPassword = platform.me?.hasPassword == true
  val sent = sentTo
  // A first password whose code has not gone yet.
  val waiting = !hasPassword && sent == null
  val title = if (hasPassword) "Нууц үг солих" else "Нууц үг тохируулах"

  val cyrillic = "Кирилл үсэгтэй нууц үгийг нүдэн тэмдгийг дараад бичнэ."
  val footer = when {
    hasPassword -> "Солимогц бусад төхөөрөмж дээрх нэвтрэлт хаагдана, энэ утас нэвтэрсэн хэвээр үлдэнэ. $cyrillic"
    sent != null -> "$sent хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай. $cyrillic"
    else -> "Таныг мөн гэдгийг батлах 6 оронтой код бүртгэлийн тань имэйл рүү очно. Дараа нь имэйл эсвэл утас, энэ нууц үгээрээ нэвтэрч болно."
  }

  val passwords = next.isNotEmpty() && again.isNotEmpty()
  val ready = when {
    busy -> false
    waiting -> true
    hasPassword -> passwords && current.isNotEmpty()
    else -> passwords && code.length == 6
  }

  /** The first password's code, to the address on the account. */
  suspend fun send() {
    if (busy || hasPassword) return
    busy = true
    trouble = null
    try {
      sentTo = platform.requestPasswordCode()
      code = ""
      codeFocus.askSoon()
    } catch (error: ApiError) {
      trouble = error.message
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      trouble = "Код илгээж чадсангүй. Дахин оролдоно уу."
    } finally {
      busy = false
    }
  }

  suspend fun save() {
    if (!ready || waiting) return
    // Checked here rather than left to the server: a mistyped repeat is the
    // one mistake the person can see for themselves.
    if (next.length < 8) {
      trouble = "Нууц үг дор хаяж 8 тэмдэгт байх ёстой."
      runCatching { nextFocus.requestFocus() }
      return
    }
    if (next != again) {
      trouble = "Хоёр нууц үг таарахгүй байна."
      runCatching { againFocus.requestFocus() }
      return
    }
    val first = !hasPassword
    busy = true
    trouble = null
    try {
      val revoked = platform.changePassword(
        current = if (first) null else current,
        next = next,
        code = if (first) code else null,
      )
      changed(revoked, first)
      onDismiss()
    } catch (error: ApiError) {
      trouble = error.message
      if (error.code == "WRONG_PASSWORD") {
        runCatching { currentFocus.requestFocus() }
      } else if (error.code in listOf("INVALID_CODE", "EXPIRED", "RATE_LIMITED")) {
        // A wrong, spent or stale code: the field empties for the next one.
        code = ""
        runCatching { codeFocus.requestFocus() }
      }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      trouble = "Нууц үг сольж чадсангүй. Дахин оролдоно уу."
    } finally {
      busy = false
    }
  }

  // The eye sits on the first password, whichever that is, and shows all three.
  val eye: @Composable () -> Unit = {
    Box(Modifier.testTag("profile.password.reveal")) {
      RevealButton(reveal) { reveal = !reveal }
    }
  }

  val nextField: @Composable (Boolean) -> Unit = { withEye ->
    PasswordField(
      title = "Шинэ нууц үг · 8+ тэмдэгт",
      text = next,
      onChange = { next = it },
      reveal = reveal,
      symbol = Icons.Outlined.Lock,
      focus = nextFocus,
      imeAction = ImeAction.Next,
      onImeAction = { runCatching { againFocus.requestFocus() } },
      tag = "profile.password.next",
      trailing = if (withEye) eye else null,
    )
  }

  val againField: @Composable () -> Unit = {
    PasswordField(
      title = "Нууц үгээ давтах",
      text = again,
      onChange = { again = it },
      reveal = reveal,
      symbol = Icons.Outlined.LockReset,
      focus = againFocus,
      imeAction = ImeAction.Go,
      onImeAction = { scope.launch { save() } },
      tag = "profile.password.again",
    )
  }

  ProfileSheet(title = title, onDismiss = onDismiss, full = true) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
      if (hasPassword) {
        PasswordField(
          title = "Одоогийн нууц үг",
          text = current,
          onChange = { current = it },
          reveal = reveal,
          symbol = Icons.Outlined.Lock,
          focus = currentFocus,
          imeAction = ImeAction.Next,
          onImeAction = { runCatching { nextFocus.requestFocus() } },
          tag = "profile.password.current",
          trailing = eye,
        )
        nextField(false)
        againField()
      } else if (sent != null) {
        CodeInput(
          code = code,
          onChange = { digits ->
            val grew = digits.length > code.length
            code = digits
            // Six digits is the whole code: the keyboard moves on to the password.
            if (grew && digits.length == 6 && next.isEmpty()) runCatching { nextFocus.requestFocus() }
          },
          focus = codeFocus,
          tag = "profile.password.code",
        )
        nextField(true)
        againField()
      } else {
        // Nothing to type yet: the code goes to the address on the account.
        AuthValue(Icons.Outlined.Email, "Код очих хаяг", platform.me?.email ?: "—", Modifier.testTag("profile.password.to"))
      }

      trouble?.let { TroubleNote(it, id = "profile.password.trouble") }

      Note(footer)

      PrimaryButton(
        if (waiting) "Код авах" else title,
        enabled = ready,
        busy = busy,
        modifier = Modifier.testTag("profile.password.go"),
      ) {
        scope.launch { if (waiting) send() else save() }
      }

      if (!hasPassword && sent != null) {
        QuietLink("Код дахин авах", Modifier.align(Alignment.CenterHorizontally).tighten(8.dp)) {
          scope.launch { send() }
        }
      }
    }
  }
}
