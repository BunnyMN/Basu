package mn.basu.app.platform

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import mn.basu.app.core.Format
import mn.basu.app.core.InboxMessage
import mn.basu.app.core.LocalPlatform
import mn.basu.app.design.Banner
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.Hairline
import mn.basu.app.design.ShellNav
import mn.basu.app.design.SourceLabel
import mn.basu.app.design.card
import mn.basu.app.design.display
import mn.basu.app.design.plainClick
import mn.basu.app.design.sans
import mn.basu.app.design.tracked
import mn.basu.app.shell.AppCatalogue
import mn.basu.app.shell.Destination
import mn.basu.app.shell.Refreshable
import mn.basu.app.shell.navBottom
import kotlin.math.roundToInt

/**
 * Everything Basu has said to this guest, from every app, in one list.
 *
 * A push is not the notification. A push that arrives in a pocket is gone; the
 * thing it was about — your table is held, your money came back — is not. This is
 * that record, and the push is only one way of pointing at it.
 *
 * Unread is a crimson dot before the source, a heavier title and a raised
 * wash on the row; the wash alone was too faint. There is no mark-all-read:
 * opening a message reads it, and swiping one away deletes it.
 *
 * Nothing is asked here. Notifications are asked for after the first order
 * (see `PushRegistrar`), when there is something to be told about — not over
 * an empty list.
 *
 * `open` is where a message points. A notification about an order that cannot
 * be opened is a notification that made somebody go and find it themselves.
 */
@Composable
fun InboxView(back: () -> Unit, open: (Destination) -> Unit) {
  val platform = LocalPlatform.current
  // Reading and deleting are told to the server whether or not this screen
  // is still up: opening a message leaves it at once.
  val telling = remember { CoroutineScope(Dispatchers.Main.immediate) }
  // The one row whose Устгах is showing. Opening another closes it.
  var swiped by remember { mutableStateOf<String?>(null) }
  // Whether the list has been asked for since the screen opened. Until it
  // has, an empty list means "not yet", not "nothing".
  var loaded by remember { mutableStateOf(false) }

  LaunchedEffect(Unit) {
    platform.loadInbox()
    loaded = true
  }

  // Pushed over the launcher: a tap on the bar's bare ground stops here.
  Column(Modifier.fillMaxSize().background(BasuColor.bg).pointerInput(Unit) {}) {
    ShellNav(title = "Мэдэгдэл", back = back)
    Refreshable(onRefresh = { platform.loadInbox() }, modifier = Modifier.fillMaxSize()) {
      Column(
        Modifier
          .fillMaxSize()
          .verticalScroll(rememberScrollState())
          .padding(horizontal = 16.dp)
          .padding(top = 4.dp, bottom = BasuMetric.tabBarInset + navBottom()),
      ) {
        val messages = platform.inbox.messages
        val trouble = platform.trouble
        if (messages.isEmpty()) {
          if (!loaded) {
            Skeleton()
          } else if (trouble != null) {
            // Not «nothing here» when the list never came: that is a
            // different thing to be told.
            Banner(trouble, Modifier.padding(top = 8.dp).testTag("inbox.trouble"))
          } else {
            Empty()
          }
        } else {
          // One card, the rows on it divided by hairlines; the card clips, so
          // the wash and the swipe never bleed past its corners.
          Column(Modifier.fillMaxWidth().card().clip(RoundedCornerShape(BasuMetric.card))) {
            messages.forEachIndexed { index, message ->
              key(message.id) {
                if (index > 0) Hairline()
                SwipeToDelete(
                  open = swiped == message.id,
                  onOpen = { swiped = if (it) message.id else if (swiped == message.id) null else swiped },
                  delete = { telling.launch { platform.delete(message) } },
                ) {
                  MessageRow(
                    message,
                    Modifier.plainClick {
                      telling.launch { platform.markRead(message) }
                      message.destination?.let(open)
                    },
                  )
                }
              }
            }

            // The list comes a page at a time, newest first. The row below
            // the last message asks for the next one; it is gone when there is
            // no more.
            if (platform.inbox.next != null) {
              Hairline()
              Box(
                Modifier
                  .fillMaxWidth()
                  .heightIn(min = 56.dp)
                  .plainClick(enabled = !platform.loadingMoreInbox) { telling.launch { platform.loadMoreInbox() } }
                  .testTag("inbox.more"),
                contentAlignment = Alignment.Center,
              ) {
                Text(
                  if (platform.loadingMoreInbox) "Уншиж байна…" else "Цааш үзэх",
                  color = BasuColor.ink,
                  style = sans(14, FontWeight.Bold),
                )
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Two lines on the ground. No illustration, no card, no button — there is
 * nothing here to act on.
 */
@Composable
private fun Empty() {
  Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
    Text("Мэдэгдэл алга", Modifier.testTag("inbox.empty"), color = BasuColor.ink, style = display(36))
    Text("Захиалгын явц энд, утсанд тань ирнэ.", color = BasuColor.ink2, style = sans(15, FontWeight.Medium))
  }
}

/**
 * Three rows in the shape of what is coming, so the list does not arrive
 * as a jump — and so «Мэдэгдэл алга» is never said before it is known.
 */
@Composable
private fun Skeleton() {
  Column(
    Modifier
      .fillMaxWidth()
      .card()
      .testTag("inbox.loading")
      .clearAndSetSemantics { contentDescription = "Уншиж байна" },
  ) {
    repeat(3) { index ->
      if (index > 0) Hairline()
      // A message's own measures, with bars where its words will be.
      Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Bar(46.dp, 12.dp)
          Spacer(Modifier.weight(1f))
          Bar(34.dp, 12.dp)
        }
        Bar(150.dp, 18.dp)
        Box(Modifier.fillMaxWidth().height(14.dp).background(BasuColor.surface3, RoundedCornerShape(4.dp)))
        Bar(190.dp, 14.dp)
      }
    }
  }
}

@Composable
private fun Bar(width: androidx.compose.ui.unit.Dp, height: androidx.compose.ui.unit.Dp) {
  Box(Modifier.width(width).height(height).background(BasuColor.surface3, RoundedCornerShape(4.dp)))
}

/**
 * One message: which app it came from, when, and what it said. Where to look
 * for it is said only when it is not this phone — an SMS.
 */
@Composable
fun MessageRow(message: InboxMessage, modifier: Modifier = Modifier) {
  Column(
    modifier
      .fillMaxWidth()
      .background(if (message.read) Color.Transparent else BasuColor.surface2)
      .testTag("inbox.${message.template}")
      // Said in words: combined, the row read out «№» and «·» one by one, and
      // a day as a fraction.
      .clearAndSetSemantics {
        contentDescription = spoken(message)
        stateDescription = if (message.read) "уншсан" else "уншаагүй"
      }
      .padding(horizontal = 18.dp, vertical = 16.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(
        Modifier.weight(1f),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        if (!message.read) {
          Box(Modifier.size(8.dp).background(BasuColor.accent, CircleShape))
        }
        SourceLabel(message.source, colour = if (message.read) BasuColor.ink3 else BasuColor.gold)
        if (message.channel == "sms") ChannelChip(message.channel)
      }
      Text(
        Format.`when`(message.at),
        color = BasuColor.ink3,
        style = sans(12, FontWeight.SemiBold).copy(fontFeatureSettings = "tnum"),
        maxLines = 1,
      )
    }
    Text(
      message.title ?: "Basu",
      color = if (message.read) BasuColor.ink2 else BasuColor.ink,
      style = sans(16, if (message.read) FontWeight.SemiBold else FontWeight.Bold),
    )
    Text(
      message.body,
      color = if (message.read) BasuColor.ink3 else BasuColor.ink2,
      style = sans(14, FontWeight.Medium).copy(lineHeight = (14 * 1.32 + 2).sp),
    )
  }
}

private fun spoken(message: InboxMessage): String = listOfNotNull(
  message.source.lowercase().replaceFirstChar { it.uppercase() },
  if (message.channel == "sms") "SMS" else null,
  Format.whenSpoken(message.at),
  Format.spoken(message.title ?: "Basu"),
  Format.spoken(message.body),
).joinToString(", ")

/**
 * `SMS`: where to go and look for a message that did not come to the app,
 * which is not the same question as which app sent it.
 */
@Composable
fun ChannelChip(channel: String, modifier: Modifier = Modifier) {
  Text(
    if (channel == "sms") "SMS" else "АПП",
    modifier
      .border(BasuMetric.hairline, BasuColor.line2, RoundedCornerShape(BasuMetric.chip))
      .padding(horizontal = 6.dp, vertical = 2.dp),
    color = BasuColor.ink2,
    style = sans(11, FontWeight.Bold).tracked(0.1),
  )
}

/**
 * Swipe left to reveal Устгах: an 88dp crimson button pinned to the row's
 * right edge. The row slides over it and stays open until it is tapped, swiped
 * back, or another row opens.
 *
 * The row moves; it does not also shrink. Padded as well as moved, its words
 * were cut at the left and an 88-point gap of bare ground opened between it
 * and the button.
 *
 * TalkBack does not swipe. The delete is also a custom action on the row, so
 * the gesture is a shortcut and never the only way.
 */
@Composable
fun SwipeToDelete(
  open: Boolean,
  onOpen: (Boolean) -> Unit,
  delete: () -> Unit,
  content: @Composable () -> Unit,
) {
  val width = with(LocalDensity.current) { BasuMetric.swipeAction.toPx() }
  val scope = rememberCoroutineScope()
  val offset = remember { Animatable(0f) }
  val settle = tween<Float>(200, easing = LinearOutSlowInEasing)
  val revealed = open || offset.value != 0f

  // Another row opening closes this one.
  LaunchedEffect(open) { offset.animateTo(if (open) -width else 0f, settle) }

  Box(
    Modifier
      .fillMaxWidth()
      .clipToBounds()
      // Over the button as well as the row: once a finger has moved sideways
      // this is a swipe — the row must not also take it as a tap, and a swipe
      // back that starts on Устгах closes the row rather than deleting it.
      .draggable(
        orientation = Orientation.Horizontal,
        state = rememberDraggableState { delta ->
          scope.launch { offset.snapTo((offset.value + delta).coerceIn(-width, 0f)) }
        },
        onDragStopped = {
          val opened = offset.value < -width / 2
          onOpen(opened)
          offset.animateTo(if (opened) -width else 0f, settle)
        },
      )
      .semantics {
        customActions = listOf(
          CustomAccessibilityAction("Устгах") {
            delete()
            true
          },
        )
      },
  ) {
    // Only there while it can be seen, so a closed row needs no opaque
    // back to hide it behind.
    if (revealed) {
      Box(Modifier.matchParentSize(), contentAlignment = Alignment.CenterEnd) {
        Box(
          Modifier
            .width(BasuMetric.swipeAction)
            .fillMaxHeight()
            .background(BasuColor.accent)
            .plainClick(onClick = delete)
            .then(if (open) Modifier else Modifier.clearAndSetSemantics {})
            .testTag("inbox.delete"),
          contentAlignment = Alignment.Center,
        ) {
          Text("Устгах", color = BasuColor.onAccent, style = sans(14, FontWeight.Medium))
        }
      }
    }

    Box(
      Modifier
        .offset { IntOffset(offset.value.roundToInt(), 0) }
        .background(if (revealed) BasuColor.surface else Color.Transparent),
    ) {
      content()
    }
  }
}

/**
 * Which app the message is about, in the launcher's own vocabulary. A
 * supplier hears about their own counter, not the guest's app.
 */
val InboxMessage.source: String
  get() = when {
    template.startsWith("supplier.") -> "НИЙЛҮҮЛЭГЧ"
    subject == "order" -> "ХООЛ"
    subject == "idesh" -> "ИДЭШ"
    else -> "BASU"
  }

/**
 * What tapping it opens, when it is about something that can be opened:
 * the order, or — when the message does not say which — the app it came
 * from, whose own list starts with the person's orders. The platform's own
 * messages — a welcome, a receipt — go nowhere.
 */
val InboxMessage.destination: Destination?
  get() {
    // A new order at the supplier's counter opens the counter: the order is
    // a guest's, and their page would not open it for the supplier.
    if (template.startsWith("supplier.")) return AppCatalogue.supplier.destination
    val app = when (subject) {
      "order" -> AppCatalogue.food
      "idesh" -> AppCatalogue.idesh
      else -> return null
    }
    return subjectId?.let { app.destination(order = it) } ?: app.destination
  }
