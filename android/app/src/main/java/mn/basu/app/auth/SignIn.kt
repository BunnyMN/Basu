package mn.basu.app.auth

import android.content.Context
import android.net.Uri
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.LockReset
import androidx.compose.material.icons.outlined.ManageAccounts
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import mn.basu.app.BuildConfig
import mn.basu.app.R
import mn.basu.app.core.ApiError
import mn.basu.app.core.AppModel
import mn.basu.app.core.AuthMethods
import mn.basu.app.core.Endpoint
import mn.basu.app.core.GoogleReturn
import mn.basu.app.core.Links
import mn.basu.app.core.LocalAppModel
import mn.basu.app.core.LocalPlatform
import mn.basu.app.core.LocalSession
import mn.basu.app.core.PasswordPurpose
import mn.basu.app.core.PhoneNumber
import mn.basu.app.core.Platform
import mn.basu.app.core.Session
import mn.basu.app.core.openInBrowser
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.BasuSheet
import mn.basu.app.design.BasuTextField
import mn.basu.app.design.Chevron
import mn.basu.app.design.CodeInput
import mn.basu.app.design.FitText
import mn.basu.app.design.Note
import mn.basu.app.design.OfflineBanner
import mn.basu.app.design.PasswordField
import mn.basu.app.design.PrimaryButton
import mn.basu.app.design.QuietLink
import mn.basu.app.design.RevealButton
import mn.basu.app.design.Symbol
import mn.basu.app.design.TroubleNote
import mn.basu.app.design.WideButton
import mn.basu.app.design.WideKind
import mn.basu.app.design.card
import mn.basu.app.design.display
import mn.basu.app.design.glass
import mn.basu.app.design.plainClick
import mn.basu.app.design.pressable
import mn.basu.app.design.sans

/**
 * Signing in.
 *
 * Google first, where the server has it: one tap for most people. Then a code
 * by email, which needs nothing but an inbox — the address becomes the account
 * the first time a code sent to it comes back. A password is one tap further:
 * signing in with an address or a phone number, signing up with an address,
 * and getting a forgotten password back — the last two by a code to the
 * inbox, because there is no SMS, and a password nobody can reset is a door
 * that locks for good. There are no invitation codes: whoever is given a role
 * signs in the same way as everybody, and the role finds them.
 *
 * Only the doors the server has open are drawn. Android has no door of
 * Apple's — the server's takes an iPhone's token — so a server that has
 * neither Google nor email set up leaves the password, whose sign-up then
 * falls back to a phone number and whose forgotten password has nowhere to
 * be sent.
 *
 * Google runs in the system's own browser tab, never a web view of ours:
 * Google refuses an embedded view, and it is right to. The server sends the
 * person to Google and back to `basu://auth`, which reaches this screen
 * through `Links.auth` — and is listened to only while this screen is the one
 * that asked: a link to it opened from anywhere else is ignored.
 *
 * The same doors are two things. Signed out, they are the whole app:
 * `RootView` draws them in place of the shell, with no tab bar and nothing to
 * close, and swaps them for the launcher the moment a session exists (`gate`).
 * Signed in, a page inside the app that needs a guest can still ask for them
 * as a sheet.
 *
 * Typing happens with the keyboard over half the screen, so the screen moves
 * with the keyboard rather than hiding things under it: a refusal is said
 * under the field it is about (and felt — the phone buzzes), and while a code
 * is awaited the photograph and the other doors fold away, so the code, what
 * went wrong with it and the button are all above the keys. The fields, the
 * code boxes and the button are in `design/Forms.kt`, shared with the
 * profile's own sheets.
 *
 * A debug build pointed at a developer's own server has one more button,
 * which goes straight to a session the way that server allows. It is hidden
 * in anything shipped, and against the pilot, which has no such door.
 *
 * @param gate The whole screen of a signed-out app rather than a sheet over
 *   something: the wordmark on top, nothing to close, nothing to dismiss once in.
 * @param reason Why a page inside the app asked, said under the title: a sheet
 *   that arrives mid-order should say what it is for and that nothing was lost.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SignInScreen(gate: Boolean = false, reason: String? = null, close: () -> Unit = {}) {
  val session = LocalSession.current
  val model = LocalAppModel.current
  val platform = LocalPlatform.current
  val context = LocalContext.current
  val focusManager = LocalFocusManager.current
  val haptics = LocalHapticFeedback.current
  val scope = rememberCoroutineScope()

  val state = remember { SignInState(session, model, platform, scope, context.applicationContext, gate) }
  state.close = close
  state.focusManager = focusManager
  // A custom tab is launched from the activity, so it sits in the app's own task.
  state.browserContext = context

  /** Whether anything on the screen is being typed in. */
  var typing by remember { mutableStateOf(false) }
  val troubleSpot = remember { BringIntoViewRequester() }

  // Asked once a screen, whatever was remembered: the doors drawn from last
  // time are replaced by today's as soon as the server says.
  LaunchedEffect(Unit) { state.took(session.methods()) }

  // Google's way back, for as long as the screen is up.
  LaunchedEffect(Unit) { Links.auth.collect { state.googleCameBack(it) } }
  // Back from the browser with no answer: the tab was closed, nothing to say.
  LifecycleResumeEffect(Unit) {
    state.resumed()
    onPauseOrDispose { state.paused() }
  }

  // A refusal is felt as well as read: a wrong code empties the boxes, and
  // with the phone in one hand that is easy to miss. A beat later it is
  // scrolled to — the keyboard moves first.
  LaunchedEffect(state.trouble) {
    if (state.trouble == null) return@LaunchedEffect
    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    delay(320)
    runCatching { troubleSpot.bringIntoView() }
  }

  val refusal: @Composable (Spot) -> Unit = { spot ->
    Refusal(state, spot, Modifier.bringIntoViewRequester(troubleSpot))
  }

  Column(
    Modifier
      .fillMaxSize()
      .then(
        // Signed out there is no bar over the gate: the insets are its own to
        // keep, and what scrolls up stops under the clock, on the ground.
        if (gate) {
          Modifier
            .background(BasuColor.bg)
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
        } else {
          Modifier
        },
      ),
  ) {
    if (!gate) SheetBar(if (state.showsAccount) state.title else "", close)

    Column(
      Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Column(
        Modifier
          .widthIn(max = 460.dp)
          .fillMaxWidth()
          .padding(horizontal = BasuMetric.screenPadding)
          .padding(bottom = 28.dp)
          .onFocusChanged { typing = it.hasFocus },
        horizontalAlignment = Alignment.CenterHorizontally,
      ) {
        if (gate) {
          Browse { model.browsing = true }
          // Waiting for a code, the picture is only in the way of it.
          if (!state.codeStep) Hero(first = state.way == Way.Doors, typing = typing, title = state.title)
        } else if (!state.showsAccount) {
          SheetHead(state.title, reason.takeIf { !state.codeStep })
        }
        if (gate && model.offline) {
          OfflineBanner(Modifier.padding(top = 18.dp)) {
            model.retry()
            if (!model.offline) state.methods = session.methods()
          }
        }
        Box(Modifier.padding(top = 18.dp)) {
          when {
            state.showsAccount -> Account(state)
            state.way == Way.Password -> PasswordDoors(state, refusal)
            else -> Doors(state, refusal)
          }
        }
        if (!state.showsAccount) Legal()
        if (BuildConfig.DEBUG && Endpoint.base != Endpoint.PILOT && !state.showsAccount) DeveloperDoor(state)
      }
    }
  }
}

/** The way in as a sheet over something: a page inside the app that needs a guest asks for it. */
@Composable
fun SignInSheet(reason: String? = null, onDismiss: () -> Unit) {
  // On the charcoal itself, as the gate is: the cards are the surface.
  BasuSheet(onDismiss = onDismiss, full = true, ground = BasuColor.bg) {
    SignInScreen(reason = reason, close = onDismiss)
  }
}

/** Which face the sheet shows: the doors most people take, or the password. */
private enum class Way { Doors, Password }
private enum class Door { SignIn, SignUp, Forgot }
/** The door waiting on an answer. The wait is shown in that one. */
private enum class Busy { Google, Email, Password }
/** Where a refusal is said: beside the door that was refused. */
private enum class Spot { Social, Email, Password }

/**
 * What catches up after the sheet has gone: the launcher's list and the
 * profile. The sheet's own scope goes with the sheet.
 */
private val afterwards = CoroutineScope(Dispatchers.Main)

/** What the first face says under the wordmark. Winter meat first, because it is what can be bought today; lunch after it. */
private const val TAGLINE = "Өвлийн идшээ гэрээт нийлүүлэгчээс ав, хоолоо урьдчилан захиал."

/** Everything the way in remembers while it is up, and the calls it makes. */
private class SignInState(
  private val session: Session,
  private val model: AppModel,
  private val platform: Platform,
  private val scope: CoroutineScope,
  context: Context,
  private val gate: Boolean,
) {
  var close: () -> Unit = {}
  var focusManager: FocusManager? = null
  var browserContext: Context = context

  var way by mutableStateOf(Way.Doors)
  /**
   * Whether the sheet opened on somebody already signed in. A sign-in made
   * here does not turn the sheet into the account view: it closes with the
   * doors still on it.
   */
  private val arrivedSignedIn = session.isSignedIn
  /**
   * Asked of the server when the sheet opens. Until it answers, what it said
   * last time, so a slow network does not draw the way in a door at a time;
   * null only the first time, when the doors' places are kept instead.
   */
  var methods: AuthMethods? by mutableStateOf(session.rememberedMethods())
  var busy: Busy? by mutableStateOf(null)
  var trouble: String? by mutableStateOf(null)
  var troubleAt by mutableStateOf(Spot.Email)

  // a code by email
  var email by mutableStateOf("")
  var emailCode by mutableStateOf("")
  /** The address the last code went to. Typing another starts over. */
  var codeSentTo: String? by mutableStateOf(null)

  // Google
  /** This screen sent the person to Google and has not heard back. */
  private var awaitingGoogle = false
  /** The browser did come up over the app after that. */
  private var leftForGoogle = false

  // a password
  var door by mutableStateOf(Door.SignIn)
  /** An address or a number: signing in, signing up by email, forgetting. */
  var login by mutableStateOf("")
  var name by mutableStateOf("")
  /** A sign-up's number, when the server has no email. */
  var phone by mutableStateOf("")
  var password by mutableStateOf("")
  var again by mutableStateOf("")
  /** The six digits from the letter that lets a password be chosen. */
  var letterCode by mutableStateOf("")
  /** Where that letter went, as the server says it — masked when a number was typed. Null until one has gone. */
  var letterSentTo: String? by mutableStateOf(null)
  /** The login it went for. Typing another starts over. */
  var letterFor: String? by mutableStateOf(null)
  /** Typed in the open: a password chosen on the web may be in Cyrillic, and is easier checked by eye. */
  var reveal by mutableStateOf(false)
  /** The refusal was "wrong number or password" — which is also what a new number hears. */
  var offerSignUp by mutableStateOf(false)

  val emailFocus = FocusRequester()
  val emailCodeFocus = FocusRequester()
  val nameFocus = FocusRequester()
  val loginFocus = FocusRequester()
  val letterCodeFocus = FocusRequester()
  val phoneFocus = FocusRequester()
  val passwordFocus = FocusRequester()
  val againFocus = FocusRequester()

  init {
    // Remembered as having no door but the password: the password is the sheet.
    methods?.let { if (!it.google && !it.email) way = Way.Password }
  }

  /** What the server says today. A server with no door but the password: the password is the sheet. */
  fun took(open: AuthMethods) {
    methods = open
    if (!open.google && !open.email) way = Way.Password
  }

  /** A code is on its way and the screen is waiting for it. */
  val codeStep: Boolean get() = codeSentTo != null || lettered

  val showsAccount: Boolean get() = arrivedSignedIn && session.isSignedIn

  /**
   * Move the keyboard to a field. A beat later than asked: a field that has
   * only just been drawn cannot take the focus yet.
   */
  fun focus(field: FocusRequester) {
    scope.launch {
      delay(80)
      runCatching { field.requestFocus() }
    }
  }

  fun unfocus() {
    focusManager?.clearFocus()
  }

  // ── a code by email ──────────────────────────────────────────────────

  fun typeEmail(typed: String) {
    email = typed
    // Another address after a code went out is a new start, not a code for
    // the old one.
    codeSentTo?.let { if (Session.address(typed) != it) startOver() }
  }

  fun typeEmailCode(typed: String) {
    val digits = typed.filter(Char::isDigit).take(6)
    if (digits == emailCode) return
    emailCode = digits
    // Six digits is the whole code: pasted or typed, it goes without
    // another tap.
    if (digits.length == 6) scope.launch { checkEmailCode() }
  }

  val emailFooter: String
    get() {
      val sent = codeSentTo
      return if (sent != null) {
        "$sent хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай."
      } else {
        "Хаяг руу тань 6 оронтой код илгээнэ. Анх удаа бол бүртгэл шууд үүснэ."
      }
    }

  val emailReady: Boolean
    get() {
      if (busy != null) return false
      return if (codeSentTo == null) Session.address(email).contains("@") else emailCode.length == 6
    }

  fun startOver() {
    codeSentTo = null
    emailCode = ""
    if (troubleAt == Spot.Email) trouble = null
  }

  // ── a password ───────────────────────────────────────────────────────

  /**
   * Whether signing up, and a forgotten password, go by a code to an inbox.
   * Without email the server can send neither: a sign-up is a number and a
   * password, as it was before there was email, and there is no reset.
   */
  val byEmail: Boolean get() = methods?.email == true

  /** A sign-up or a reset whose letter has gone, waiting for its code. */
  val lettered: Boolean get() = letterFor != null

  fun typeLogin(typed: String) {
    login = typed
    // Another login after a code went out is a new start, not a code for
    // the old one.
    letterFor?.let { if (Session.login(typed) != it) startLetterOver() }
  }

  fun typeLetterCode(typed: String) {
    val digits = typed.filter(Char::isDigit).take(6)
    if (digits == letterCode) return
    letterCode = digits
    if (digits.length != 6) return
    // Six digits is the whole code. With the passwords already there it
    // goes without another tap; without, the keyboard moves on to them.
    when {
      password.isEmpty() -> focus(passwordFocus)
      again.isEmpty() -> focus(againFocus)
      else -> scope.launch { go() }
    }
  }

  /**
   * Another door: what the last one said no longer applies. What was typed
   * stays where it still means the same thing — the login a forgotten
   * password is for, the password a taken number should sign in with.
   */
  fun open(next: Door) {
    door = next
    trouble = null
    offerSignUp = false
    again = ""
    startLetterOver()
    // A forgotten password is replaced, not typed again; and a number typed
    // to sign in is not an address to sign up with.
    if (next == Door.Forgot) password = ""
    if (next == Door.SignUp && byEmail && !login.contains("@")) login = ""
  }

  /** A letter for a login nobody is typing any more is no use. */
  private fun startLetterOver() {
    letterFor = null
    letterSentTo = null
    letterCode = ""
  }

  fun switchTo(next: Way) {
    way = next
    trouble = null
    offerSignUp = false
    unfocus()
  }

  /** Say no, beside the door that was refused. */
  private fun say(words: String, at: Spot) {
    troubleAt = at
    trouble = words
  }

  // ── words ────────────────────────────────────────────────────────────

  val title: String
    get() {
      if (showsAccount) return "Бүртгэл"
      if (way != Way.Password) return "Нэвтрэх"
      return when (door) {
        Door.SignIn -> "Нэвтрэх"
        Door.SignUp -> "Бүртгүүлэх"
        Door.Forgot -> "Нууц үг сэргээх"
      }
    }

  val footer: String
    get() {
      val sent = letterSentTo
      if (lettered && sent != null) {
        val letter = "$sent хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай."
        return if (door == Door.Forgot) "$letter Шинэ нууц үг тавихад бусад төхөөрөмжөөс гарна." else letter
      }
      return when (door) {
        Door.SignIn -> "Кирилл үсэгтэй нууц үгийг нүдэн тэмдгийг дараад бичнэ."
        Door.SignUp ->
          if (byEmail) {
            "Хаяг руу тань 6 оронтой код илгээнэ. Кодоо оруулмагц бүртгэл үүснэ. Нууц үгээ мартвал мөн энэ хаягаар сэргээнэ."
          } else {
            "Утасны дугаар, өөрийн сонгосон нууц үгээр бүртгэл үүснэ. Нууц үгээ хэнд ч бүү хэл."
          }
        Door.Forgot -> "Бүртгэлтэй имэйл эсвэл утасны дугаараа бичнэ үү. Бүртгэлийн имэйл рүү тань код илгээнэ."
      }
    }

  val action: String
    get() = when (door) {
      Door.SignIn -> "Нэвтрэх"
      Door.SignUp -> if (byEmail && !lettered) "Код авах" else "Бүртгүүлэх"
      Door.Forgot -> if (lettered) "Нууц үгээ шинэчлэх" else "Код авах"
    }

  val ready: Boolean
    get() {
      if (busy != null) return false
      val passwords = password.isNotEmpty() && again.isNotEmpty()
      return when (door) {
        Door.SignIn -> Session.looksLikeLogin(login) && password.isNotEmpty()
        Door.SignUp ->
          if (byEmail) login.contains("@") && passwords && (!lettered || letterCode.length == 6)
          else PhoneNumber.looksComplete(phone) && passwords
        Door.Forgot -> if (lettered) letterCode.length == 6 && passwords else Session.looksLikeLogin(login)
      }
    }

  // ── the calls ────────────────────────────────────────────────────────

  /**
   * Whichever door it was, the sheet goes at once, with the doors still on
   * it, and the launcher's list and the profile catch up behind it.
   *
   * The gate has nothing to close and nothing to catch up: the root swaps it
   * for the launcher as soon as the session exists, and the launcher asks for
   * its list on arrival.
   */
  private fun signedIn() {
    if (gate) return
    close()
    afterwards.launch {
      model.refreshLive()
      platform.refresh()
    }
  }

  fun signOut() {
    platform.signOut()
    afterwards.launch { model.refreshLive() }
    close()
  }

  suspend fun askForCode() {
    if (busy != null || !Session.address(email).contains("@")) return
    busy = Busy.Email
    trouble = null
    try {
      session.requestCode(email)
      codeSentTo = Session.address(email)
      emailCode = ""
      focus(emailCodeFocus)
    } catch (error: CancellationException) {
      throw error
    } catch (error: ApiError) {
      say(error.message, Spot.Email)
    } catch (_: Exception) {
      say("Код илгээж чадсангүй. Дахин оролдоно уу.", Spot.Email)
    } finally {
      busy = null
    }
  }

  suspend fun checkEmailCode() {
    val sent = codeSentTo
    if (busy != null || sent == null || emailCode.length != 6) return
    busy = Busy.Email
    trouble = null
    try {
      session.signIn(sent, emailCode)
      signedIn()
    } catch (error: CancellationException) {
      throw error
    } catch (error: ApiError) {
      say(error.message, Spot.Email)
      emailCode = ""
      focus(emailCodeFocus)
    } catch (_: Exception) {
      say("Нэвтэрч чадсангүй. Дахин оролдоно уу.", Spot.Email)
    } finally {
      busy = null
    }
  }

  /**
   * Off to Google in the system's browser tab. The answer is not this call's
   * to wait for: it comes back as a link (`googleCameBack`), or the person
   * closes the tab and the app is simply in front again (`resumed`).
   */
  fun signInWithGoogle() {
    if (busy != null) return
    busy = Busy.Google
    trouble = null
    awaitingGoogle = true
    leftForGoogle = false
    openInBrowser(browserContext, session.googleStart)
    // A phone with no browser to open: nothing came up over the app, so
    // nothing will come back either.
    scope.launch {
      delay(2000)
      if (awaitingGoogle && !leftForGoogle) {
        googleOver()
        say(GoogleReturn.words("SOCIAL_REFUSED"), Spot.Social)
      }
    }
  }

  /** `basu://auth#…`, honoured only when this screen sent the person to Google. */
  fun googleCameBack(uri: Uri) {
    if (!awaitingGoogle) return
    googleOver()
    when (val back = GoogleReturn.parse(uri)) {
      is GoogleReturn.Token -> {
        session.signedInWithGoogle(back.token)
        signedIn()
      }
      // Backed out at Google: nothing happened, nothing to say.
      GoogleReturn.Cancelled -> Unit
      is GoogleReturn.Refused -> say(GoogleReturn.words(back.code), Spot.Social)
    }
  }

  fun paused() {
    if (awaitingGoogle) leftForGoogle = true
  }

  /**
   * In front again. The link, when there is one, arrives just before this
   * and is read just after — so the wait is given a moment before it is
   * taken to mean the tab was closed.
   */
  fun resumed() {
    if (!awaitingGoogle || !leftForGoogle) return
    scope.launch {
      delay(600)
      if (awaitingGoogle) googleOver()
    }
  }

  private fun googleOver() {
    awaitingGoogle = false
    leftForGoogle = false
    if (busy == Busy.Google) busy = null
  }

  suspend fun go() {
    if (!ready) return
    // Checked here rather than left to the server: a mistyped repeat is the
    // one mistake the person can see for themselves. A reset's passwords are
    // typed after its code has gone, so until then there are none to check.
    if (door != Door.SignIn && (door != Door.Forgot || lettered)) {
      if (password.length < 8) {
        say("Нууц үг дор хаяж 8 тэмдэгт байх ёстой.", Spot.Password)
        focus(passwordFocus)
        return
      }
      if (password != again) {
        say("Хоёр нууц үг таарахгүй байна.", Spot.Password)
        focus(againFocus)
        return
      }
    }
    // By email, a code to the inbox first, then the password it is for.
    if (door == Door.Forgot || (door == Door.SignUp && byEmail)) {
      if (lettered) setPassword() else askForLetter()
      return
    }
    busy = Busy.Password
    trouble = null
    offerSignUp = false
    try {
      when (door) {
        Door.SignIn -> session.signInWithPassword(login, password)
        Door.SignUp, Door.Forgot -> session.register(phone, password)
      }
      signedIn()
    } catch (error: CancellationException) {
      throw error
    } catch (error: ApiError) {
      // «Already has an account — sign in»: the door it points at, with the
      // number and password still typed in.
      if (error.code == "PHONE_TAKEN") {
        login = phone
        open(Door.SignIn)
      }
      offerSignUp = door == Door.SignIn && error.code == "BAD_CREDENTIALS"
      say(error.message, Spot.Password)
    } catch (_: Exception) {
      say("Нэвтэрч чадсангүй. Дахин оролдоно уу.", Spot.Password)
    } finally {
      busy = null
    }
  }

  /**
   * A code to the inbox the login names: the address itself for a sign-up,
   * the one on the account for a forgotten password. A number with no
   * address behind it is refused, and the server says what to do instead.
   */
  suspend fun askForLetter() {
    if (busy != null || (door != Door.SignUp && door != Door.Forgot)) return
    busy = Busy.Password
    trouble = null
    offerSignUp = false
    try {
      letterSentTo = session.requestPasswordCode(
        login,
        if (door == Door.Forgot) PasswordPurpose.Reset else PasswordPurpose.SignUp,
      )
      letterFor = Session.login(login)
      letterCode = ""
      focus(letterCodeFocus)
    } catch (error: CancellationException) {
      throw error
    } catch (error: ApiError) {
      say(error.message, Spot.Password)
    } catch (_: Exception) {
      say("Код илгээж чадсангүй. Дахин оролдоно уу.", Spot.Password)
    } finally {
      busy = null
    }
  }

  /**
   * The code and the password: an account made, or a password replaced, and
   * a session either way.
   *
   * Said once over wherever the person lands when it was not quite what they
   * asked for — a sign-up that found an account already on the address — or
   * did more than they saw: a reset signs every other device out.
   */
  private suspend fun setPassword() {
    val sentFor = letterFor
    if (busy != null || sentFor == null || letterCode.length != 6) return
    val forgot = door == Door.Forgot
    val typedName = name.trim()
    busy = Busy.Password
    trouble = null
    try {
      val created = session.setPassword(
        sentFor,
        letterCode,
        password,
        if (forgot || typedName.isEmpty()) null else typedName,
      )
      if (forgot) {
        model.notice = "Нууц үг шинэчлэгдлээ. Бусад төхөөрөмжөөс гаргалаа."
      } else if (!created) {
        model.notice = "Энэ имэйлээр бүртгэл байсан — нууц үгийг нь шинэчилж нэвтэрлээ."
      }
      signedIn()
    } catch (error: CancellationException) {
      throw error
    } catch (error: ApiError) {
      say(error.message, Spot.Password)
      if (error.code == "TOO_SHORT") {
        focus(passwordFocus)
      } else {
        // A wrong, spent or stale code: the field empties for the next one.
        letterCode = ""
        focus(letterCodeFocus)
      }
    } catch (_: Exception) {
      say("Нэвтэрч чадсангүй. Дахин оролдоно уу.", Spot.Password)
    } finally {
      busy = null
    }
  }

  /** A developer's own server: straight in, as whichever number is typed, or the demo guest's. */
  suspend fun demoSignIn() {
    busy = Busy.Password
    try {
      val typed = listOf(login, phone).firstOrNull(PhoneNumber::looksComplete)?.let(PhoneNumber::e164)
      session.demoSignIn(typed ?: "+97699001122")
      signedIn()
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      say(
        (error as? ApiError)?.message ?: "Нэвтэрч чадсангүй.",
        if (way == Way.Password) Spot.Password else Spot.Email,
      )
    } finally {
      busy = null
    }
  }
}

// ── the head ───────────────────────────────────────────────────────────

/** The sheet's bar: «Хаах» on the left, and the title in it only over the account. */
@Composable
private fun SheetBar(title: String, close: () -> Unit) {
  Box(
    Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(BasuMetric.minTarget),
    contentAlignment = Alignment.Center,
  ) {
    if (title.isNotEmpty()) {
      Text(title, Modifier.semantics { heading() }, color = BasuColor.ink, style = sans(17, FontWeight.Bold))
    }
    QuietLink("Хаах", Modifier.align(Alignment.CenterStart).padding(horizontal = 12.dp), action = close)
  }
}

/**
 * The gate's head: a photograph of what Basu is for, the wordmark on it in
 * white, and one line that says it — the web's front page in miniature. Past
 * the first face, and while anything is typed, the picture folds to a band so
 * the fields and the keyboard both fit, and the line becomes the door that is
 * open.
 *
 * The words decide the height and the picture fills behind them, not the
 * other way round: at the largest text sizes the line needs more than the
 * photograph's own height, and it grows the head rather than spilling off it.
 *
 * The buuz are Tuguldur Baatar's, from Unsplash (free for commercial use;
 * credited with the web's photographs in src/web/brand/meat/CREDITS.txt).
 */
@Composable
private fun Hero(first: Boolean, typing: Boolean, title: String) {
  val small = !first || typing
  val shape = RoundedCornerShape(BasuMetric.card)
  val height by animateDpAsState(
    if (small) BasuMetric.authPhoto * 0.55f else BasuMetric.authPhoto,
    tween(280),
    label = "hero",
  )
  val mark by animateFloatAsState(if (small) 36f else 56f, tween(280), label = "wordmark")
  val words = if (first) TAGLINE else title
  Box(
    Modifier
      .padding(top = 8.dp)
      .fillMaxWidth()
      .defaultMinSize(minHeight = height)
      .clip(shape)
      .border(BasuMetric.hairline, BasuColor.line, shape)
      .semantics(mergeDescendants = true) { heading() }
      .testTag("signin.gate"),
    contentAlignment = Alignment.BottomStart,
  ) {
    Image(
      painterResource(R.drawable.sign_in_photo),
      contentDescription = null,
      modifier = Modifier.matchParentSize(),
      contentScale = ContentScale.Crop,
      // The web's warm grade for a pale photograph: more colour, more
      // contrast — the meat lit, the rest dark.
      colorFilter = remember { ColorFilter.colorMatrix(warmGrade(saturation = 1.2f, contrast = 1.12f)) },
    )
    // The photograph settles into the charcoal at its foot, so the words
    // stand on the ground rather than on a grey smudge.
    Box(
      Modifier.matchParentSize().background(
        Brush.verticalGradient(
          0.2f to BasuColor.bg.copy(alpha = 0f),
          0.62f to BasuColor.bg.copy(alpha = 0.7f),
          1f to BasuColor.bg.copy(alpha = 0.96f),
        ),
      ),
    )
    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text("Basu", color = BasuColor.ink, style = display(56).copy(fontSize = mark.sp))
      Text(
        words,
        color = BasuColor.ink2,
        style = if (first) sans(15, FontWeight.SemiBold) else sans(17, FontWeight.Bold),
      )
    }
  }
}

/** A colour matrix that saturates and then adds contrast, about the middle grey. */
private fun warmGrade(saturation: Float, contrast: Float): ColorMatrix {
  val matrix = ColorMatrix().apply { setToSaturation(saturation) }
  val values = matrix.values
  val lift = (1f - contrast) * 127.5f
  for (row in 0 until 3) {
    for (column in 0 until 3) values[row * 5 + column] *= contrast
    values[row * 5 + 4] = lift
  }
  return matrix
}

/**
 * «Бүртгэлгүйгээр үзэх», at the top where it is seen before anything is
 * typed: looking needs no account; ordering, the wallet and the profile do.
 */
@Composable
private fun Browse(action: () -> Unit) {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
    Row(
      Modifier
        .pressable(onClick = action)
        .glass(CircleShape)
        .clip(CircleShape)
        .defaultMinSize(minHeight = BasuMetric.minTarget)
        .padding(horizontal = 16.dp)
        .testTag("signin.browse"),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      // One line at every size: grown past this it broke mid-word.
      FitText("Бүртгэлгүйгээр үзэх", sans(14, FontWeight.Bold), BasuColor.ink, minScale = 0.8f)
      Symbol(Icons.AutoMirrored.Outlined.ArrowForward, BasuColor.ink, size = 16.dp)
    }
  }
}

/**
 * A sheet over a page: no photograph, the title large and on the ground —
 * and, when a page asked, why.
 */
@Composable
private fun SheetHead(title: String, reason: String?) {
  Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(title, Modifier.semantics { heading() }, color = BasuColor.ink, style = display(44))
    if (reason != null) {
      Text(reason, Modifier.testTag("signin.reason"), color = BasuColor.ink2, style = sans(15, FontWeight.Medium))
    }
  }
}

/** The two pages every way in is under, one tap from the door. */
@Composable
private fun Legal() {
  val context = LocalContext.current
  Row(
    Modifier.padding(top = 16.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    LegalLink("Үйлчилгээний нөхцөл") { openInBrowser(context, Uri.parse("${Endpoint.base}/terms")) }
    Text("·", color = BasuColor.ink3, style = sans(13, FontWeight.SemiBold))
    LegalLink("Нууцлалын бодлого") { openInBrowser(context, Uri.parse("${Endpoint.base}/privacy")) }
  }
}

@Composable
private fun LegalLink(title: String, action: () -> Unit) {
  Box(
    Modifier.defaultMinSize(minHeight = BasuMetric.minTarget).plainClick(onClick = action),
    contentAlignment = Alignment.Center,
  ) {
    Text(title, color = BasuColor.ink3, style = sans(13, FontWeight.SemiBold))
  }
}

// ── signed in ──────────────────────────────────────────────────────────

@Composable
private fun Account(state: SignInState) {
  val session = LocalSession.current
  val platform = LocalPlatform.current
  Column(
    Modifier.fillMaxWidth().card(radius = BasuMetric.card).padding(20.dp),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    val phone = platform.me?.phone ?: session.phone
    val email = platform.me?.email ?: session.email
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      if (phone != null) {
        Text("Утас", color = BasuColor.ink3, style = sans(13))
        Text(phone, color = BasuColor.ink, style = sans(16, FontWeight.SemiBold).copy(fontFeatureSettings = "tnum"))
      } else if (email != null) {
        Text("Имэйл", color = BasuColor.ink3, style = sans(13))
        Text(email, color = BasuColor.ink, style = sans(16))
      }
    }
    WideButton("Гарах", kind = WideKind.Quiet) { state.signOut() }
    Text(
      "Гарсан ч захиалга тань хэвээр. Дахин нэвтэрвэл гарч ирнэ.",
      color = BasuColor.ink3,
      style = sans(12).copy(fontSize = 12.5.sp),
    )
  }
}

// ── the doors ──────────────────────────────────────────────────────────

@Composable
private fun Doors(state: SignInState, refusal: @Composable (Spot) -> Unit) {
  val methods = state.methods
  val waiting = state.codeSentTo != null
  Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
    Column(
      Modifier.fillMaxWidth().card(radius = BasuMetric.card).animateContentSize(tween(280)).padding(18.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      // Waiting for a code, the other doors fold into one row under the
      // card: a big button above a code nobody asked it about is what
      // pushed the code under the keyboard.
      if (!waiting) {
        if (methods?.google == true) {
          GoogleButton(
            busy = state.busy == Busy.Google,
            enabled = state.busy == null,
            modifier = Modifier.testTag("signin.google"),
          ) { state.signInWithGoogle() }
        }
        refusal(Spot.Social)
      }

      if (methods?.email == true) {
        if (!waiting && methods.google) OrLine("эсвэл имэйлээр", Modifier.padding(vertical = 4.dp))
        EmailDoor(state, refusal)
      } else if (methods == null) {
        // The first time, before the server has said which doors it has:
        // their places, so the card does not grow under the thumb.
        DoorsPlaceholder()
      }
    }

    if (waiting) {
      WayButton(
        title = "Өөр аргаар нэвтрэх",
        detail = if (methods?.google == true) "Google эсвэл нууц үгээр" else "Нууц үгээр",
        symbol = Icons.AutoMirrored.Outlined.Undo,
        modifier = Modifier.testTag("signin.otherWays"),
      ) {
        state.unfocus()
        state.startOver()
      }
    } else {
      WayButton(
        title = "Нууц үгээр нэвтрэх, бүртгүүлэх",
        detail = "Имэйл эсвэл утас, нууц үгээр",
        symbol = Icons.Outlined.Key,
        modifier = Modifier.testTag("signin.passwordWay"),
      ) { state.switchTo(Way.Password) }
    }
  }
}

@Composable
private fun EmailDoor(state: SignInState, refusal: @Composable (Spot) -> Unit) {
  val scope = rememberCoroutineScope()
  val waiting = state.codeSentTo != null
  BasuTextField(
    value = state.email,
    onValueChange = state::typeEmail,
    placeholder = "Имэйл хаяг",
    symbol = Icons.Outlined.Email,
    focus = state.emailFocus,
    keyboardType = KeyboardType.Email,
    imeAction = ImeAction.Send,
    onImeAction = { scope.launch { state.askForCode() } },
    // While another door waits, this one does not take a tap.
    enabled = state.busy == null || waiting,
    tag = "signin.email",
  )

  if (waiting) {
    CodeInput(state.emailCode, state::typeEmailCode, focus = state.emailCodeFocus, tag = "signin.emailCode")
  }

  // Right under the field it is about, above the small print.
  refusal(Spot.Email)

  Note(state.emailFooter)

  PrimaryButton(
    title = if (waiting) "Нэвтрэх" else "Код авах",
    enabled = state.emailReady,
    busy = state.busy == Busy.Email,
    modifier = Modifier.testTag("signin.emailGo"),
  ) {
    scope.launch { if (state.codeSentTo == null) state.askForCode() else state.checkEmailCode() }
  }

  if (waiting) {
    Row(Modifier.fillMaxWidth().tuck(8.dp), verticalAlignment = Alignment.CenterVertically) {
      QuietLink("Код дахин авах", Modifier.testTag("signin.resend")) { scope.launch { state.askForCode() } }
      Spacer(Modifier.weight(1f))
      QuietLink("Хаяг солих") {
        state.startOver()
        state.focus(state.emailFocus)
      }
    }
  }
}

// ── a password ─────────────────────────────────────────────────────────

@Composable
private fun PasswordDoors(state: SignInState, refusal: @Composable (Spot) -> Unit) {
  val scope = rememberCoroutineScope()
  val door = state.door
  val lettered = state.lettered
  Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
    if (door == Door.SignIn || door == Door.SignUp) DoorSwitch(door) { state.open(it) }

    Column(
      Modifier.fillMaxWidth().card(radius = BasuMetric.card).animateContentSize(tween(280)).padding(18.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      if (door == Door.SignUp && !state.byEmail) {
        PhoneField(state)
      } else {
        if (door == Door.SignUp) NameField(state)
        LoginField(state)
        if (lettered) {
          CodeInput(
            state.letterCode,
            state::typeLetterCode,
            focus = state.letterCodeFocus,
            tag = if (door == Door.Forgot) "signin.resetCode" else "signin.signUpCode",
          )
        }
      }
      // A reset's new password is asked for once the code is on its way —
      // before that there is nothing to set it with.
      if (door != Door.Forgot || lettered) PasswordFields(state)

      refusal(Spot.Password)
      Note(state.footer)

      PrimaryButton(
        title = state.action,
        enabled = state.ready,
        busy = state.busy == Busy.Password,
        modifier = Modifier.testTag("signin.go"),
      ) { scope.launch { state.go() } }

      if (door == Door.SignIn && state.byEmail) {
        QuietLink("Нууц үгээ мартсан?", Modifier.fillMaxWidth().tuck(8.dp).testTag("signin.forgot")) {
          state.open(Door.Forgot)
        }
      } else if (lettered) {
        QuietLink("Код дахин авах", Modifier.fillMaxWidth().tuck(8.dp).testTag("signin.resendLetter")) {
          scope.launch { state.askForLetter() }
        }
      }
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      if (door == Door.Forgot) {
        WayButton(
          title = "Нэвтрэх рүү буцах",
          symbol = Icons.AutoMirrored.Outlined.Undo,
          modifier = Modifier.testTag("signin.back"),
        ) { state.open(Door.SignIn) }
      }
      val methods = state.methods
      if (methods != null && (methods.google || methods.email)) {
        WayButton(
          title = when {
            methods.google && methods.email -> "Google эсвэл имэйлээр нэвтрэх"
            methods.google -> "Google-ээр нэвтрэх"
            else -> "Имэйлээр нэвтрэх"
          },
          symbol = Icons.Outlined.ManageAccounts,
          modifier = Modifier.testTag("signin.doorsWay"),
        ) { state.switchTo(Way.Doors) }
      }
    }
  }
}

@Composable
private fun NameField(state: SignInState) {
  BasuTextField(
    value = state.name,
    onValueChange = { state.name = it },
    placeholder = "Нэр",
    symbol = Icons.Outlined.Person,
    focus = state.nameFocus,
    capitalization = KeyboardCapitalization.Words,
    imeAction = ImeAction.Next,
    onImeAction = { state.focus(state.loginFocus) },
    tag = "signin.name",
  )
}

/**
 * An address or a number, in one field. Which it is, is whether it has an @
 * in it — the server tells them apart the same way. Signing up by email it is
 * an address only.
 *
 * The email keyboard, because the @ and the dot are the hard part to reach
 * and digits are one key away.
 */
@Composable
private fun LoginField(state: SignInState) {
  val scope = rememberCoroutineScope()
  val signUp = state.door == Door.SignUp
  val forgot = state.door == Door.Forgot
  BasuTextField(
    value = state.login,
    onValueChange = state::typeLogin,
    placeholder = if (signUp) "Имэйл хаяг" else "Имэйл эсвэл утас",
    symbol = if (signUp) Icons.Outlined.Email else Icons.Outlined.AlternateEmail,
    focus = state.loginFocus,
    keyboardType = KeyboardType.Email,
    imeAction = if (forgot && !state.lettered) ImeAction.Send else ImeAction.Next,
    onImeAction = {
      if (forgot) {
        if (state.lettered) state.focus(state.letterCodeFocus) else scope.launch { state.go() }
      } else {
        state.focus(state.passwordFocus)
      }
    },
    tag = "signin.login",
  )
}

@Composable
private fun PhoneField(state: SignInState) {
  BasuTextField(
    value = state.phone,
    onValueChange = { state.phone = it },
    placeholder = "Утасны дугаар · 8811 2233",
    symbol = Icons.Outlined.Phone,
    focus = state.phoneFocus,
    keyboardType = KeyboardType.Phone,
    imeAction = ImeAction.Next,
    onImeAction = { state.focus(state.passwordFocus) },
    tag = "signin.phone",
  )
}

@Composable
private fun PasswordFields(state: SignInState) {
  val scope = rememberCoroutineScope()
  val signIn = state.door == Door.SignIn
  PasswordField(
    title = if (signIn) "Нууц үг" else "Шинэ нууц үг · 8+ тэмдэгт",
    text = state.password,
    onChange = { state.password = it },
    reveal = state.reveal,
    symbol = Icons.Outlined.Lock,
    focus = state.passwordFocus,
    imeAction = if (signIn) ImeAction.Go else ImeAction.Next,
    onImeAction = { if (signIn) scope.launch { state.go() } else state.focus(state.againFocus) },
    tag = "signin.password",
    trailing = {
      Box(Modifier.testTag("signin.reveal")) { RevealButton(state.reveal) { state.reveal = !state.reveal } }
    },
  )
  if (!signIn) {
    PasswordField(
      title = "Нууц үгээ давтах",
      text = state.again,
      onChange = { state.again = it },
      reveal = state.reveal,
      symbol = Icons.Outlined.LockReset,
      focus = state.againFocus,
      imeAction = ImeAction.Go,
      onImeAction = { scope.launch { state.go() } },
      tag = "signin.again",
    )
  }
}

/** A refusal, where it belongs — and nowhere else. */
@Composable
private fun Refusal(state: SignInState, spot: Spot, modifier: Modifier = Modifier) {
  val trouble = state.trouble
  if (trouble == null || state.troubleAt != spot) return
  TroubleNote(
    trouble,
    modifier,
    extra = if (state.offerSignUp && spot == Spot.Password) {
      {
        Box(
          Modifier
            .defaultMinSize(minHeight = 32.dp)
            .plainClick { state.open(Door.SignUp) }
            .testTag("signin.offerSignUp"),
          contentAlignment = Alignment.CenterStart,
        ) {
          Text("Шинэ хэрэглэгч бол бүртгүүлэх", color = BasuColor.ink, style = sans(14, FontWeight.SemiBold))
        }
      }
    } else {
      null
    },
  )
}

/** One more door, on a developer's own server only. */
@Composable
private fun DeveloperDoor(state: SignInState) {
  val scope = rememberCoroutineScope()
  Column(
    Modifier.padding(top = 18.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text(
      "Хөгжүүлэгчийн сервер: шууд нэвтрэх",
      Modifier.plainClick { scope.launch { state.demoSignIn() } }.testTag("signin.demo"),
      color = BasuColor.ink,
      style = sans(13, FontWeight.Medium),
    )
    Text(
      "Зөвхөн debug build, зөвхөн хөгжүүлэгчийн өөрийн сервер дээр.",
      color = BasuColor.ink3,
      style = sans(11).copy(fontSize = 11.5.sp),
      textAlign = TextAlign.Center,
    )
  }
}

// ── the way in's parts ─────────────────────────────────────────────────

/**
 * Google's button as its guidelines draw it for a dark ground: the
 * four-colour mark on the surface, a hairline, the words — a capsule the
 * height of a field, and its own wait.
 */
@Composable
private fun GoogleButton(busy: Boolean, enabled: Boolean, modifier: Modifier = Modifier, action: () -> Unit) {
  Box(
    modifier
      .fillMaxWidth()
      .pressable(enabled = enabled, onClick = action)
      .background(BasuColor.surface, CircleShape)
      .border(BasuMetric.hairline, BasuColor.line2, CircleShape)
      .clip(CircleShape)
      .defaultMinSize(minHeight = BasuMetric.controlHeight)
      .padding(horizontal = 16.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    if (busy) {
      CircularProgressIndicator(Modifier.size(22.dp), color = BasuColor.ink, strokeWidth = 2.dp)
    } else {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Image(painterResource(R.drawable.google_g), contentDescription = null, modifier = Modifier.size(18.dp))
        Text(
          "Google-ээр нэвтрэх",
          color = BasuColor.ink,
          style = sans(17, FontWeight.SemiBold),
          textAlign = TextAlign.Center,
        )
      }
    }
  }
}

/**
 * Where Google's door and the email door go, before the server has said it
 * has them — only ever the first time; after that the doors it had last time
 * are drawn. Shapes, not words: nothing here can be pressed.
 */
@Composable
private fun DoorsPlaceholder() {
  Column(
    Modifier
      .fillMaxWidth()
      .clearAndSetSemantics { contentDescription = "Уншиж байна" }
      .testTag("signin.doorsLoading"),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Box(Modifier.fillMaxWidth().height(BasuMetric.controlHeight).background(BasuColor.surface3, CircleShape))
    Box(Modifier.padding(vertical = 12.dp).fillMaxWidth().height(BasuMetric.hairline).background(BasuColor.line))
    Box(
      Modifier
        .fillMaxWidth()
        .height(BasuMetric.controlHeight)
        .background(BasuColor.surface3, RoundedCornerShape(BasuMetric.control)),
    )
    Box(
      Modifier.fillMaxWidth().height(BasuMetric.buttonHeight).background(BasuColor.surface3.copy(alpha = 0.6f), CircleShape),
    )
  }
}

/** A rule, a word, a rule — between the one-tap door and the typed one. */
@Composable
private fun OrLine(words: String, modifier: Modifier = Modifier) {
  Row(
    modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Box(Modifier.weight(1f).height(BasuMetric.hairline).background(BasuColor.line))
    Text(words, color = BasuColor.ink3, style = sans(13, FontWeight.SemiBold), maxLines = 1, softWrap = false)
    Box(Modifier.weight(1f).height(BasuMetric.hairline).background(BasuColor.line))
  }
}

/** Another way in, off the card: a mark, the words, and where it leads. */
@Composable
private fun WayButton(
  title: String,
  symbol: ImageVector,
  modifier: Modifier = Modifier,
  detail: String? = null,
  action: () -> Unit,
) {
  Row(
    modifier
      .fillMaxWidth()
      .pressable(onClick = action)
      .card(radius = BasuMetric.card)
      .padding(horizontal = 18.dp, vertical = 16.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Box(Modifier.widthIn(min = 22.dp), contentAlignment = Alignment.Center) {
      Symbol(symbol, BasuColor.ink2, size = 20.dp)
    }
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
      Text(title, color = BasuColor.ink, style = sans(15, FontWeight.Bold))
      if (detail != null) Text(detail, color = BasuColor.ink3, style = sans(13, FontWeight.Medium))
    }
    Chevron(BasuColor.ink3, size = 12.dp)
  }
}

/**
 * «Нэвтрэх | Бүртгүүлэх»: two halves of one capsule; the chosen one is the
 * off-white pill with dark words on it, and it slides from one to the other.
 */
@Composable
private fun DoorSwitch(door: Door, open: (Door) -> Unit) {
  val haptics = LocalHapticFeedback.current
  BoxWithConstraints(
    Modifier
      .fillMaxWidth()
      .background(BasuColor.surface, CircleShape)
      .border(BasuMetric.hairline, BasuColor.line, CircleShape)
      .padding(4.dp),
  ) {
    val half = (maxWidth - 4.dp) / 2
    val x by animateDpAsState(if (door == Door.SignUp) half + 4.dp else 0.dp, tween(250), label = "pill")
    Box(Modifier.offset(x = x).width(half).height(46.dp).background(BasuColor.ink, CircleShape))
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
      listOf(
        Triple(Door.SignIn, "Нэвтрэх", "signin.door.signIn"),
        Triple(Door.SignUp, "Бүртгүүлэх", "signin.door.signUp"),
      ).forEach { (which, title, id) ->
        val chosen = door == which
        Box(
          Modifier
            .weight(1f)
            .height(46.dp)
            .clip(CircleShape)
            .plainClick {
              if (!chosen) {
                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                open(which)
              }
            }
            .semantics { selected = chosen }
            .testTag(id),
          contentAlignment = Alignment.Center,
        ) {
          Text(title, color = if (chosen) BasuColor.onLight else BasuColor.ink2, style = sans(15, FontWeight.Bold))
        }
      }
    }
  }
}

/**
 * Takes less room than it measures, above and below — the quiet links under
 * a button keep a thumb's height to tap while sitting closer to the card's
 * edge (SwiftUI's negative padding).
 */
private fun Modifier.tuck(by: Dp): Modifier = layout { measurable, constraints ->
  val placeable = measurable.measure(constraints)
  val cut = by.roundToPx()
  layout(placeable.width, (placeable.height - cut * 2).coerceAtLeast(0)) { placeable.place(0, -cut) }
}
