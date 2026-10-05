package mn.basu.app.platform

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Lock
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
import androidx.compose.ui.composed
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import mn.basu.app.auth.SignInPrompt
import mn.basu.app.core.Format
import mn.basu.app.core.LocalPlatform
import mn.basu.app.core.LocalSession
import mn.basu.app.core.Movement
import mn.basu.app.core.Platform
import mn.basu.app.core.WalletLine
import mn.basu.app.core.movementWord
import mn.basu.app.design.AuthField
import mn.basu.app.design.Banner
import mn.basu.app.design.BasuAlert
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.BasuSheet
import mn.basu.app.design.FitText
import mn.basu.app.design.Hairline
import mn.basu.app.design.Note
import mn.basu.app.design.PrimaryButton
import mn.basu.app.design.ProfileSheet
import mn.basu.app.design.QuietLink
import mn.basu.app.design.SectionLabel
import mn.basu.app.design.ShellTitle
import mn.basu.app.design.Symbol
import mn.basu.app.design.card
import mn.basu.app.design.display
import mn.basu.app.design.plainClick
import mn.basu.app.design.sans
import mn.basu.app.shell.Refreshable
import mn.basu.app.shell.navBottom

/** Three amounts, not a keypad. Roughly two lunches, a week, and a fortnight. */
private val amounts = listOf(20_000, 50_000, 100_000)

/**
 * The wallet: what is in it, how to put more in, and where the last lot went.
 *
 * One number is the screen; everything under it exists to explain that number.
 * There is no chart and no monthly total on purpose — nobody opens a wallet to
 * see a trend, they open it to find out whether the next thing will work.
 *
 * Putting money in is offered only while it can be done. A server without a
 * payment key refuses every top-up; the first refusal turns the amounts into
 * one plain line (`Platform.topupsOpen`) rather than a row of buttons that all
 * end in the same no.
 */
@Composable
fun WalletView() {
  val session = LocalSession.current
  val platform = LocalPlatform.current
  val scope = rememberCoroutineScope()
  // Money on its way is not dropped because somebody changed tabs: the
  // top-up runs to its end whether or not this screen is still up.
  val paying = remember { CoroutineScope(Dispatchers.Main.immediate) }
  var confirming by remember { mutableStateOf<Int?>(null) }
  var customAmount by remember { mutableStateOf(false) }
  var showing by remember { mutableStateOf<WalletLine?>(null) }

  LaunchedEffect(session.token) { platform.loadWallet() }

  Column(Modifier.fillMaxSize().background(BasuColor.bg)) {
    ShellTitle("Түрийвч")
    Refreshable(onRefresh = { platform.loadWallet() }, modifier = Modifier.fillMaxSize()) {
      Column(
        Modifier
          .fillMaxSize()
          .verticalScroll(rememberScrollState())
          .padding(horizontal = BasuMetric.screenPadding)
          .padding(top = 4.dp, bottom = BasuMetric.tabBarInset + navBottom()),
        verticalArrangement = Arrangement.spacedBy(36.dp),
      ) {
        if (session.isSignedIn) {
          Balance(platform, retry = { scope.launch { platform.loadWallet() } })
          TopUp(platform, confirm = { confirming = it }, other = { customAmount = true })
          Statement(
            platform,
            show = { showing = it },
            more = { scope.launch { platform.loadMoreWallet() } },
          )
        } else {
          // Somebody looking around has no wallet yet: it is the account's.
          SignInPrompt(
            symbol = Icons.Outlined.CreditCard,
            title = "Түрийвч тань энд",
            detail = "Үлдэгдэл, буцаалт, баримт нэг дор.",
            id = "wallet.signin",
            modifier = Modifier.padding(top = 8.dp),
          )
        }
      }
    }
  }

  // An alert rather than a sheet of choices: paying is not a thing to do by
  // tapping beside it.
  confirming?.let { amount ->
    BasuAlert(
      title = "${Format.mnt(amount)} цэнэглэх үү?",
      message = "Мөнгө орж ирсний дараа л үлдэгдэл нэмэгдэнэ.",
      confirm = "QPay-ээр төлөх",
      cancel = "Болих",
      onConfirm = {
        paying.launch { platform.topUp(amount) }
        confirming = null
      },
      onDismiss = { confirming = null },
    )
  }
  if (customAmount) {
    TopUpAmountSheet(onDismiss = { customAmount = false }) { amount ->
      customAmount = false
      confirming = amount
    }
  }
  showing?.let { line ->
    MovementSheet(line, onDismiss = { showing = null })
  }
}

/**
 * One number, then only what explains it. A failed fetch omits the number
 * rather than showing a zero — a wallet that says 0₮ when it means «I do not
 * know» is the one thing here that could make somebody top up twice.
 */
@Composable
private fun Balance(platform: Platform, retry: () -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    SectionLabel("Үлдэгдэл", colour = BasuColor.gold)
    if (platform.balanceKnown) {
      FitText(
        Format.mnt(platform.wallet.balanceMnt),
        display(72),
        BasuColor.ink,
        Modifier.testTag("wallet.balance"),
        minScale = 0.5f,
      )
    } else {
      Row(
        Modifier.heightIn(min = 72.dp).plainClick(onClick = retry).testTag("wallet.retry"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        Text("Үлдэгдэл уншигдсангүй", color = BasuColor.ink2, style = sans(16, FontWeight.SemiBold))
        Text(
          "Дахин",
          color = BasuColor.ink,
          style = sans(16, FontWeight.SemiBold).copy(textDecoration = TextDecoration.Underline),
        )
      }
    }
    // The second line is a promise only while money can come in.
    Text(
      if (platform.topupsOpen) "Захиалгын төлбөр эндээс хасагдана. Дутвал QPay-ээр."
      else "Захиалгын төлбөр эндээс хасагдана.",
      color = BasuColor.ink2,
      style = sans(15, FontWeight.Medium),
    )
  }
}

@Composable
private fun TopUp(platform: Platform, confirm: (Int) -> Unit, other: () -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    SectionLabel("Цэнэглэх")
    if (platform.topupsOpen) {
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (amount in amounts) {
          // Holding an amount still opens the fourth way; «Өөр дүн» says it out loud.
          Chip(
            Modifier.weight(1f).testTag("wallet.topup.$amount"),
            enabled = !platform.toppingUp,
            onLongClick = other,
            onClick = { confirm(amount) },
          ) {
            FitText(Format.mnt(amount), display(19), BasuColor.ink, minScale = 0.7f)
          }
        }
        // The fourth way, for the person who needs 37 000₮ and would
        // otherwise top up twice. It used to be a long press nobody found.
        Chip(
          Modifier.weight(1f).testTag("wallet.topup.other"),
          enabled = !platform.toppingUp,
          onClick = other,
        ) {
          FitText("Өөр дүн", sans(14, FontWeight.Bold), BasuColor.ink, minScale = 0.7f)
        }
      }
      platform.trouble?.let { Banner(it) }
    } else {
      // Said once, plainly, with nothing promised: no buttons that all
      // end in the same refusal, and no «soon».
      Row(
        Modifier
          .fillMaxWidth()
          .card()
          .padding(horizontal = 18.dp, vertical = 16.dp)
          .semantics(mergeDescendants = true) {}
          .testTag("wallet.topup.closed"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Symbol(Icons.Outlined.Lock, BasuColor.ink3, size = 18.dp)
        Text("Цэнэглэлт одоогоор хаалттай.", color = BasuColor.ink2, style = sans(15, FontWeight.SemiBold))
      }
    }
  }
}

/** An amount to tap: an outlined capsule, which shrinks a touch under the thumb. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Chip(
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  onLongClick: (() -> Unit)? = null,
  onClick: () -> Unit,
  content: @Composable () -> Unit,
) {
  Box(
    modifier
      .composed {
        val source = remember { MutableInteractionSource() }
        val pressed by source.collectIsPressedAsState()
        val scale by animateFloatAsState(if (pressed) 0.98f else 1f, tween(120), label = "press")
        val alpha by animateFloatAsState(if (pressed) 0.88f else 1f, tween(120), label = "pressAlpha")
        this
          .graphicsLayer {
            scaleX = scale
            scaleY = scale
            this.alpha = alpha
          }
          .combinedClickable(
            interactionSource = source,
            indication = null,
            enabled = enabled,
            role = Role.Button,
            onLongClickLabel = if (onLongClick != null) "Өөр дүн" else null,
            onLongClick = onLongClick,
            onClick = onClick,
          )
      }
      .heightIn(min = 52.dp)
      .background(BasuColor.surface, CircleShape)
      .border(BasuMetric.hairline, BasuColor.line2, CircleShape)
      .padding(horizontal = 6.dp),
    contentAlignment = Alignment.Center,
  ) {
    content()
  }
}

/**
 * The movements as a table's rows on one card: who or what, which app and
 * order, and the money in the display face on the right.
 */
@Composable
private fun Statement(platform: Platform, show: (WalletLine) -> Unit, more: () -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    SectionLabel("Гүйлгээ")

    if (platform.wallet.lines.isEmpty()) {
      Text(
        "Гүйлгээ алга.",
        Modifier.fillMaxWidth().card().padding(horizontal = 18.dp, vertical = 22.dp),
        color = BasuColor.ink2,
        style = sans(15, FontWeight.Medium),
      )
    } else {
      Column(Modifier.fillMaxWidth().card()) {
        platform.wallet.lines.forEachIndexed { index, line ->
          if (index > 0) Hairline()
          StatementRow(line, Modifier.plainClick { show(line) })
        }

        if (platform.wallet.next != null) {
          Hairline()
          Box(
            Modifier
              .fillMaxWidth()
              .heightIn(min = 56.dp)
              .plainClick(enabled = !platform.loadingMore, onClick = more)
              .testTag("wallet.more"),
            contentAlignment = Alignment.Center,
          ) {
            Text(
              if (platform.loadingMore) "Уншиж байна…" else "Цааш үзэх",
              color = BasuColor.ink,
              style = sans(14, FontWeight.Bold),
            )
          }
        }
      }
    }
  }
}

/** Any amount, for the person the three buttons do not fit. */
@Composable
fun TopUpAmountSheet(onDismiss: () -> Unit, pick: (Int) -> Unit) {
  var text by remember { mutableStateOf("") }
  var typing by remember { mutableStateOf(false) }
  val focus = remember { FocusRequester() }
  val amount = text.filter(Char::isDigit).toIntOrNull()?.takeIf { it in 1_000..2_000_000 }

  ProfileSheet(title = "Цэнэглэх дүн", onDismiss = onDismiss) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
      AuthField(Icons.Outlined.CreditCard, typing, tap = { runCatching { focus.requestFocus() } }) {
        Row(
          Modifier.weight(1f),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (text.isEmpty()) {
              Text("Дүн", color = BasuColor.ink3, style = display(26), maxLines = 1)
            }
            BasicTextField(
              value = text,
              onValueChange = { text = it },
              modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focus)
                .onFocusChanged { typing = it.isFocused }
                .semantics { contentDescription = "Дүн" }
                .testTag("wallet.amount.field"),
              singleLine = true,
              textStyle = display(26).copy(color = BasuColor.ink),
              cursorBrush = SolidColor(BasuColor.ink),
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
            )
          }
          Text("₮", Modifier.clearAndSetSemantics {}, color = BasuColor.ink3, style = display(26))
        }
      }
      Note("1,000₮-с 2,000,000₮ хооронд.")
      PrimaryButton("Үргэлжлүүлэх", enabled = amount != null, busy = false, modifier = Modifier.testTag("wallet.amount.go")) {
        amount?.let(pick)
      }
    }
  }
  LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

/**
 * One movement, and its tax receipt.
 *
 * The receipt is the reason this screen exists. In Mongolia it is not a nicety:
 * somebody claiming lunch back needs the ДДТД and the lottery number, and making
 * them find the order it came from to get at it is making them know how the
 * software is built.
 */
@Composable
fun MovementSheet(line: WalletLine, onDismiss: () -> Unit) {
  val platform = LocalPlatform.current
  var movement by remember(line.id) { mutableStateOf<Movement?>(null) }
  var loading by remember(line.id) { mutableStateOf(true) }
  val shown = line.shown

  LaunchedEffect(line.id) {
    movement = platform.movement(line.id)
    loading = false
  }

  BasuSheet(onDismiss = onDismiss) {
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(BasuMetric.minTarget), contentAlignment = Alignment.Center) {
      Text("Гүйлгээ", color = BasuColor.ink, style = sans(17, FontWeight.Bold))
      QuietLink("Хаах", Modifier.align(Alignment.CenterEnd).padding(horizontal = 12.dp), action = onDismiss)
    }
    Column(
      Modifier
        .fillMaxWidth()
        .verticalScroll(rememberScrollState())
        .padding(horizontal = 20.dp)
        .padding(top = 8.dp, bottom = 28.dp),
      verticalArrangement = Arrangement.spacedBy(28.dp),
    ) {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SectionLabel(line.title, colour = BasuColor.gold)
        FitText(Format.signedMnt(line.amountMnt), display(56), BasuColor.ink, minScale = 0.5f)
        Text(
          if (shown.title == line.title) shown.detail else "${shown.title} · ${shown.detail}",
          color = BasuColor.ink2,
          style = sans(15, FontWeight.Medium),
        )
      }

      Column(Modifier.fillMaxWidth().card()) {
        Detail("Огноо", Format.date(line.at))
        Hairline()
        Detail("Цаг", Format.hhmm(line.at), figures = true)
        shown.number?.let { number ->
          Hairline()
          Detail("Захиалгын дугаар", "№$number", figures = true)
        }
      }

      Receipt(line, movement?.receipt, loading)
    }
  }
}

@Composable
private fun Receipt(line: WalletLine, receipt: Movement.Receipt?, loading: Boolean) {
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    SectionLabel("Е-баримт")
    if (receipt != null) {
      SelectionContainer {
        Column(
          Modifier.fillMaxWidth().card().padding(18.dp).testTag("movement.receipt"),
          verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          receipt.lottery?.let { lottery ->
            Row {
              Text(
                "Сугалааны дугаар",
                Modifier.alignByBaseline(),
                color = BasuColor.ink2,
                style = sans(15, FontWeight.Medium),
              )
              Spacer(Modifier.weight(1f))
              Text(
                lottery,
                Modifier.alignByBaseline().padding(start = 8.dp),
                color = BasuColor.ink,
                style = display(22),
              )
            }
          }
          Text(
            receipt.qr,
            color = BasuColor.ink3,
            style = sans(12, FontWeight.Medium).copy(fontFeatureSettings = "tnum"),
          )
        }
      }
    } else {
      // Said out loud. A blank space where a receipt should be is the same
      // picture as "we lost it", and one of those is true.
      Text(
        when {
          loading -> "Уншиж байна…"
          line.kind == "topup" -> "Цэнэглэлтэд баримт гардаггүй — баримтыг худалдсан ресторан, нийлүүлэгч гаргана."
          else -> "Баримт хараахан гараагүй байна. Захиалга хаагдмагц энд гарч ирнэ."
        },
        color = BasuColor.ink2,
        style = sans(14, FontWeight.Medium).copy(lineHeight = (14 * 1.32 + 3).sp),
      )
    }
  }
}

@Composable
private fun Detail(label: String, value: String, figures: Boolean = false) {
  Row(
    Modifier
      .fillMaxWidth()
      .heightIn(min = 56.dp)
      .padding(horizontal = 18.dp)
      .semantics(mergeDescendants = true) {},
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(label, color = BasuColor.ink2, style = sans(15, FontWeight.Medium))
    Spacer(Modifier.weight(1f))
    Text(
      value,
      Modifier.padding(start = 12.dp),
      color = BasuColor.ink,
      style = if (figures) display(20) else sans(15, FontWeight.SemiBold).copy(fontFeatureSettings = "tnum"),
    )
  }
}

/**
 * One movement, as a table's row: who or what it was with, which app and
 * order, and the money in the display face with the day under it.
 */
@Composable
fun StatementRow(line: WalletLine, modifier: Modifier = Modifier) {
  val shown = line.shown
  Row(
    modifier
      .fillMaxWidth()
      .heightIn(min = 72.dp)
      .testTag("wallet.line.${line.kind}")
      // Said in words: the row combined read out «№», «·» and «₮» one by one.
      .clearAndSetSemantics { contentDescription = spoken(line, shown) }
      .padding(horizontal = 18.dp, vertical = 14.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      // Who it was with leads — «Улаанбаатар махны төв» says more than
      // «Захиалга», which every other line also says.
      Text(shown.title, color = BasuColor.ink, style = sans(16, FontWeight.Bold))
      Text(shown.subline, color = BasuColor.ink3, style = sans(13, FontWeight.SemiBold))
    }
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
      // Money in and money out are told apart by the sign, not by a
      // colour: there is no green here.
      Text(
        Format.signedMnt(line.amountMnt),
        color = BasuColor.ink,
        style = display(22),
        maxLines = 1,
        softWrap = false,
      )
      Text(
        Format.`when`(line.at),
        color = BasuColor.ink3,
        style = sans(12, FontWeight.SemiBold).copy(fontFeatureSettings = "tnum"),
        maxLines = 1,
      )
    }
  }
}

private fun spoken(line: WalletLine, shown: WalletShown): String {
  val money = Format.moneySpoken(line.amountMnt) + if (line.amountMnt < 0) " хасагдсан" else " орсон"
  return listOfNotNull(
    shown.title,
    Format.spoken(shown.detail),
    shown.number?.let { "захиалга $it" },
    money,
    Format.whenSpoken(line.at),
  ).filter { it.isNotEmpty() }.joinToString(", ")
}

/**
 * A movement the way the statement says it: who or what it was with, which
 * app it came from, and the order's number.
 *
 * The vertical writes all three into the memo — «Идэш · Улаанбаатар махны
 * төв №7001» — so the shell can say them without knowing what an идэш is. The
 * ledger's own word («Захиалга») is the row's title only when there is
 * nothing more particular to say; a refund keeps «Буцаалт» first, since
 * which way the money went is the point of it.
 */
data class WalletShown(val title: String, val detail: String, val number: String?) {
  /** «Идэш · №7001» — the words, then the number in tabular figures. */
  val subline: AnnotatedString
    get() = buildAnnotatedString {
      append(detail)
      if (number != null) {
        if (detail.isNotEmpty()) append(" · ")
        withStyle(SpanStyle(fontFeatureSettings = "tnum")) { append("№$number") }
      }
    }
}

val WalletLine.shown: WalletShown get() = walletShown(kind, memo)

private val orderNumber = Regex("№[\\s\\p{Z}]*\\p{Nd}+")

/** Spaces and tabs, not line ends — what the iOS `.whitespaces` trims. */
private fun String.trimSpaces(): String = trim { it == '\t' || Character.getType(it) == Character.SPACE_SEPARATOR.toInt() }

fun walletShown(kind: String, memo: String?): WalletShown {
  val word = movementWord(kind)
  if (kind == "topup") return WalletShown(word, "QPay", null)
  val text = memo?.trimSpaces()
  if (text.isNullOrEmpty()) return WalletShown(word, "Basu", null)
  var number: String? = null
  val parts = text.split("·").map { it.trimSpaces() }.toMutableList()
  for (index in parts.indices) {
    val found = orderNumber.find(parts[index]) ?: continue
    number = found.value.filter(Char::isDigit)
    parts[index] = parts[index].removeRange(found.range).trimSpaces()
  }
  parts.removeAll { it.isEmpty() }
  val app = parts.firstOrNull() ?: return WalletShown(word, "Basu", number)
  val rest = parts.drop(1)
  if (kind == "refund") {
    return WalletShown(word, (listOf(app) + rest.filter { it != word }).joinToString(" · "), number)
  }
  val what = rest.firstOrNull() ?: return WalletShown(word, app, number)
  return WalletShown(what, (listOf(app) + rest.drop(1)).joinToString(" · "), number)
}
