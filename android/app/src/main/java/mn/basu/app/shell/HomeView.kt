package mn.basu.app.shell

import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.google.android.play.core.review.ReviewManagerFactory
import kotlinx.coroutines.delay
import mn.basu.app.BuildConfig
import mn.basu.app.auth.SignInSheet
import mn.basu.app.core.Format
import mn.basu.app.core.LocalAppModel
import mn.basu.app.core.LocalPlatform
import mn.basu.app.core.LocalSession
import mn.basu.app.core.ReviewMoment
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.FitText
import mn.basu.app.design.OfflineBanner
import mn.basu.app.design.Porcelain
import mn.basu.app.design.ShellGlyph
import mn.basu.app.design.ShellMark
import mn.basu.app.design.card
import mn.basu.app.design.display
import mn.basu.app.design.plainClick
import mn.basu.app.design.pressable
import mn.basu.app.design.sans
import mn.basu.app.design.tracked
import java.time.Instant

/**
 * The launcher.
 *
 * It owns no domain logic: a hello, the apps as tiles, and whatever of the
 * guest's is running. «Тансаг хар» lays it out as the owner's prototype does:
 * the day and a greeting in the display face, Идэш as the big tile because it
 * is the season's, Хоол — and Нийлүүлэгч for the few who are one — beside
 * each other under it, each picture untouched in its porcelain square; then
 * the orders that are running, one card each.
 *
 * The tiles never rearrange themselves, and their order is editorial.
 */
@Composable
fun HomeView(open: (Destination) -> Unit, showOrders: () -> Unit) {
  val model = LocalAppModel.current
  val session = LocalSession.current
  val platform = LocalPlatform.current
  val context = LocalContext.current
  var signingIn by remember { mutableStateOf(false) }

  // Everything on the launcher, in the catalogue's order: what everybody has,
  // then what this guest has that others do not.
  val apps = AppCatalogue.shipped + listOfNotNull(AppCatalogue.supplier.takeIf { model.supplier != null })
  // The season's app takes the big tile; the rest sit two to a row under it.
  val big = apps.firstOrNull { it.id == AppCatalogue.idesh.id }
  val small = apps.filter { it.id != big?.id }
  val live = liveItems()

  LaunchedEffect(session.token) {
    model.refreshLive()
    platform.refresh()
  }

  // Back on the launcher after something went right: a moment to settle
  // first, so the ask is not the first thing that happens on arrival.
  LaunchedEffect(Unit) {
    val prefs = context.getSharedPreferences("basu", android.content.Context.MODE_PRIVATE)
    if (!ReviewMoment.due(prefs, BuildConfig.VERSION_NAME)) return@LaunchedEffect
    delay(2000)
    if (!ReviewMoment.due(prefs, BuildConfig.VERSION_NAME)) return@LaunchedEffect
    ReviewMoment.markAsked(prefs, BuildConfig.VERSION_NAME)
    val activity = context as? Activity ?: return@LaunchedEffect
    runCatching {
      val manager = ReviewManagerFactory.create(context)
      manager.requestReviewFlow().addOnSuccessListener { manager.launchReviewFlow(activity, it) }
    }
  }

  Refreshable(
    onRefresh = {
      model.refreshLive()
      platform.refresh()
    },
    modifier = Modifier.fillMaxSize().background(BasuColor.bg),
  ) {
    Column(
      Modifier
        .fillMaxSize()
        .verticalScroll(rememberScrollState())
        .windowInsetsPadding(WindowInsets.statusBars)
        .padding(horizontal = 16.dp)
        .padding(top = 12.dp, bottom = BasuMetric.tabBarInset + navBottom()),
    ) {
      Header(signedIn = session.isSignedIn, unread = platform.unread, inbox = { open(Destination.Inbox) }, signIn = { signingIn = true })

      if (model.offline) {
        OfflineBanner(Modifier.padding(top = 20.dp)) { model.retry() }
      }

      Column(Modifier.padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (big != null) BigTile(big) { open(big.destination) }
        // Two to a row; one left over spans the row rather than leaving a hole.
        for (pair in small.chunked(2)) {
          Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            for (app in pair) {
              SmallTile(app, wide = pair.size == 1, modifier = Modifier.weight(1f)) { open(app.destination) }
            }
          }
        }
      }

      if (live.isNotEmpty()) {
        // A label and «Бүгд», then one card per order.
        Column(Modifier.padding(top = 36.dp).testTag("live.card"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
          Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
              "ИДЭВХТЭЙ ЗАХИАЛГА",
              Modifier.weight(1f).semantics { heading() },
              color = BasuColor.ink3,
              style = sans(13, FontWeight.Bold).tracked(0.14),
            )
            Text(
              "Бүгд",
              Modifier
                .plainClick(onClick = showOrders)
                .padding(start = 16.dp, top = 6.dp, bottom = 6.dp)
                .semantics { contentDescription = "Бүх захиалга" }
                .testTag("home.orders"),
              color = BasuColor.ink2,
              style = sans(14, FontWeight.Bold),
            )
          }
          for (item in live) {
            OrderCard(item, Modifier.pressable { item.destination?.let(open) })
          }
        }
      }
    }
  }

  if (signingIn) SignInSheet(onDismiss = { signingIn = false })
}

@Composable
internal fun navBottom() = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

/**
 * Both verticals, in one list, by the moment that matters. A sheep due
 * Tuesday sits under today's lunch; the section does not know which app
 * either came from.
 */
@Composable
internal fun liveItems(): List<LiveItem> {
  val model = LocalAppModel.current
  val count = model.live.size + model.liveIdesh.size
  return (model.live.map { it.asLiveItem(expanded = count == 1) } + model.liveIdesh.map { it.asLiveItem() }).sortedBy { it.time }
}

/**
 * The day, small, over a greeting in the display face; the bell on the right.
 * Somebody only looking around has no bell to ring, so the way in stands
 * where it would be.
 */
@Composable
private fun Header(signedIn: Boolean, unread: Int, inbox: () -> Unit, signIn: () -> Unit) {
  val now by produceState(Instant.now()) {
    while (true) {
      delay(60_000 - System.currentTimeMillis() % 60_000)
      value = Instant.now()
    }
  }
  Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text("${Format.weekday(now)}, ${Format.dayWords(now)}", color = BasuColor.ink3, style = sans(14, FontWeight.SemiBold))
      // One line, always: beside «Нэвтрэх» it gives a little of its size
      // rather than breaking «Өдрийн / мэнд» over two.
      FitText(Format.greeting(now), display(44), BasuColor.ink, Modifier.semantics { heading() })
    }
    if (signedIn) {
      // A round button on the surface; something unread is a crimson dot on
      // its shoulder, ringed in the surface so it reads as on top.
      Box(
        Modifier
          .padding(top = 4.dp)
          .size(BasuMetric.minTarget)
          .background(BasuColor.surface, CircleShape)
          .border(BasuMetric.hairline, BasuColor.line, CircleShape)
          .clip(CircleShape)
          .pressable(onClick = inbox)
          .semantics {
            contentDescription = "Мэдэгдэл"
            stateDescription = if (unread > 0) "$unread уншаагүй" else "уншаагүй алга"
          }
          .testTag("home.inbox"),
        contentAlignment = Alignment.Center,
      ) {
        ShellGlyph(ShellMark.Bell, BasuColor.ink, size = BasuMetric.bell)
        if (unread > 0) {
          Box(
            Modifier
              .align(Alignment.TopEnd)
              .offset(x = (-8).dp, y = 8.dp)
              .background(BasuColor.surface, CircleShape)
              .padding(2.dp)
              .size(8.dp)
              .background(BasuColor.accent, CircleShape),
          )
        }
      }
    } else {
      Box(
        Modifier
          .padding(top = 4.dp)
          .defaultMinSize(minHeight = BasuMetric.minTarget)
          .background(BasuColor.surface, CircleShape)
          .border(BasuMetric.hairline, BasuColor.line2, CircleShape)
          .clip(CircleShape)
          .pressable(onClick = signIn)
          .padding(horizontal = 18.dp)
          .testTag("home.account"),
        contentAlignment = Alignment.Center,
      ) {
        Text("Нэвтрэх", color = BasuColor.ink, style = sans(15, FontWeight.Bold), maxLines = 1)
      }
    }
  }
}

/**
 * The season's app, as the big tile: a gold overline, the name in the display
 * face at 64, one line of what it is, and its picture at 132 on the right.
 */
@Composable
private fun BigTile(app: LauncherApp, action: () -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .defaultMinSize(minHeight = 204.dp)
      .card(radius = BasuMetric.tile, fill = BasuColor.tileGround, stroke = BasuColor.tileEdge)
      .clip(RoundedCornerShape(BasuMetric.tile))
      .pressable(onClick = action)
      .padding(start = 24.dp, end = 22.dp, top = 26.dp, bottom = 26.dp)
      .clearAndSetSemantics { contentDescription = "${app.name}, ${app.tag}" }
      .testTag("app.${app.name}"),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Column(Modifier.weight(1f)) {
      Text("ЭНЭ УЛИРАЛ", color = BasuColor.gold, style = sans(11, FontWeight.Bold).tracked(0.18))
      FitText(app.name, display(64), BasuColor.ink, Modifier.padding(top = 8.dp))
      Text(app.line, Modifier.padding(top = 10.dp).widthIn(max = 170.dp), color = BasuColor.ink2, style = sans(15, FontWeight.SemiBold))
    }
    Porcelain(app.art, size = 132.dp, radius = BasuMetric.iconTileLarge)
  }
}

/**
 * An app beside another: its picture at 72 in the corner, an arrow opposite,
 * the name in the display face and a line under it at the foot. Alone on its
 * row it lies on its side — picture, words, arrow — rather than leave half a
 * row empty.
 */
@Composable
private fun SmallTile(app: LauncherApp, wide: Boolean, modifier: Modifier = Modifier, action: () -> Unit) {
  val frame = modifier
    .card(radius = BasuMetric.tile, fill = BasuColor.tileGround, stroke = BasuColor.tileEdge)
    .clip(RoundedCornerShape(BasuMetric.tile))
    .pressable(onClick = action)
    .clearAndSetSemantics { contentDescription = "${app.name}, ${app.tag}" }
    .testTag("app.${app.name}")
  val name = @Composable { FitText(app.name, display(28), BasuColor.ink) }
  val line = @Composable {
    Text(app.line, color = BasuColor.ink2, style = sans(13, FontWeight.SemiBold), maxLines = 2, overflow = TextOverflow.Ellipsis)
  }
  if (wide) {
    Row(
      frame.defaultMinSize(minHeight = 108.dp).padding(18.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      Porcelain(app.art, size = 72.dp)
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        name()
        line()
      }
      ShellGlyph(ShellMark.Arrow, BasuColor.ink3, size = 20.dp)
    }
  } else {
    Column(frame.height(190.dp).padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 18.dp)) {
      Row(Modifier.fillMaxWidth()) {
        Porcelain(app.art, size = 72.dp)
        Spacer(Modifier.weight(1f))
        ShellGlyph(ShellMark.Arrow, BasuColor.ink3, size = 20.dp)
      }
      Spacer(Modifier.weight(1f).defaultMinSize(minHeight = 16.dp))
      name()
      Box(Modifier.padding(top = 8.dp)) { line() }
    }
  }
}
