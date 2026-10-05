package mn.basu.app.design

import androidx.annotation.DrawableRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import mn.basu.app.R

/** The supplied renders, by the names the iOS app and the catalogue use. */
@DrawableRes
fun art(name: String): Int = when (name) {
  "food-tile" -> R.drawable.food_tile
  "supplier-tile" -> R.drawable.supplier_tile
  else -> R.drawable.idesh_tile
}

/** The 1dp rule that separates rows inside a list. Always `line`, always 1dp. */
@Composable
fun Hairline(modifier: Modifier = Modifier) {
  Box(modifier.fillMaxWidth().height(BasuMetric.hairline).background(BasuColor.line))
}

/**
 * A system symbol's stand-in: where the iOS app shows an SF Symbol, this
 * shows the nearest outlined Material one, at the same size and colour.
 */
@Composable
fun Symbol(icon: ImageVector, tint: Color, modifier: Modifier = Modifier, size: Dp = 18.dp) {
  Icon(icon, contentDescription = null, tint = tint, modifier = modifier.size(size))
}

/**
 * One line that gives a little of its size rather than breaking or being cut
 * (`lineLimit(1)` with `minimumScaleFactor`).
 */
@Composable
fun FitText(
  text: String,
  style: TextStyle,
  color: Color,
  modifier: Modifier = Modifier,
  minScale: Float = 0.6f,
) {
  var scale by remember(text) { mutableStateOf(1f) }
  Text(
    text,
    modifier = modifier,
    color = color,
    style = style.copy(fontSize = (style.fontSize.value * scale).sp),
    maxLines = 1,
    softWrap = false,
    overflow = TextOverflow.Clip,
    onTextLayout = { if (it.hasVisualOverflow && scale > minScale) scale = (scale - 0.05f).coerceAtLeast(minScale) },
  )
}

/** The small uppercase label above a section: 12, bold, tracked wide, in `ink3`. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, colour: Color = BasuColor.ink3) {
  Text(
    text.uppercase(),
    modifier = modifier.semantics { heading() },
    color = colour,
    style = sans(12, FontWeight.Bold).tracked(0.14),
  )
}

/** The tracked label that names which app a row came from: «ИДЭШ», «ХООЛ». */
@Composable
fun SourceLabel(text: String, modifier: Modifier = Modifier, size: Int = 12, colour: Color = BasuColor.ink3) {
  Text(text, modifier = modifier, color = colour, style = sans(size, FontWeight.Bold).tracked(0.14))
}

enum class WideKind { Primary, Quiet, Danger }

/**
 * The buttons of a sheet's foot.
 *
 * - `Primary`: the crimson capsule, white words, its own glow.
 * - `Quiet`: an outlined capsule — the way past, the second choice.
 * - `Danger`: crimson words and nothing else.
 */
@Composable
fun WideButton(
  title: String,
  modifier: Modifier = Modifier,
  kind: WideKind = WideKind.Primary,
  enabled: Boolean = true,
  action: () -> Unit,
) {
  val capsule = CircleShape
  val foreground = when (kind) {
    WideKind.Primary -> BasuColor.onAccent
    WideKind.Quiet -> BasuColor.ink
    WideKind.Danger -> BasuColor.accentInk
  }
  Box(
    modifier
      .fillMaxWidth()
      .alpha(if (enabled) 1f else 0.45f)
      .then(
        when (kind) {
          WideKind.Primary -> Modifier.glow(enabled).background(BasuColor.accent, capsule)
          WideKind.Quiet -> Modifier.border(BasuMetric.hairline, BasuColor.line2, capsule)
          WideKind.Danger -> Modifier
        },
      )
      .clip(capsule)
      .pressable(enabled = enabled, onClick = action)
      .defaultMinSize(minHeight = if (kind == WideKind.Danger) BasuMetric.minTarget else BasuMetric.buttonHeight)
      .padding(horizontal = 16.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(title, color = foreground, style = sans(16, FontWeight.Bold), textAlign = TextAlign.Center)
  }
}

/**
 * The one thing a card is for: a crimson capsule with its own glow, and the
 * wait shown in place of the words.
 */
@Composable
fun PrimaryButton(
  title: String,
  enabled: Boolean,
  busy: Boolean,
  modifier: Modifier = Modifier,
  action: () -> Unit,
) {
  val live = enabled || busy
  Box(
    modifier
      .fillMaxWidth()
      .alpha(if (live) 1f else 0.45f)
      .glow(live)
      .background(BasuColor.accent, CircleShape)
      .clip(CircleShape)
      .pressable(enabled = enabled && !busy, onClick = action)
      .defaultMinSize(minHeight = BasuMetric.buttonHeight)
      .padding(horizontal = 20.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    if (busy) {
      CircularProgressIndicator(Modifier.size(22.dp), color = BasuColor.onAccent, strokeWidth = 2.dp)
    } else {
      Text(title, color = BasuColor.onAccent, style = sans(16, FontWeight.Bold), textAlign = TextAlign.Center)
    }
  }
}

/** A supplied render as an app tile, full-bleed at the tile's radius. */
@Composable
fun RasterTile(name: String, size: Dp, modifier: Modifier = Modifier, radius: Dp = size * 18 / 92) {
  Image(
    painterResource(art(name)),
    contentDescription = null,
    modifier = modifier.size(size).clip(RoundedCornerShape(radius)),
    contentScale = ContentScale.Crop,
  )
}

/**
 * A tile's picture in its porcelain square: the supplied render, untouched,
 * with a white hairline at six per cent and a deep shadow so it sits on the
 * charcoal rather than being pasted on it.
 */
@Composable
fun Porcelain(name: String, modifier: Modifier = Modifier, size: Dp = 72.dp, radius: Dp = BasuMetric.iconTile) {
  val shape = RoundedCornerShape(radius)
  Box(
    modifier
      .shadow(12.dp, shape, clip = false, ambientColor = Color.Black, spotColor = Color.Black)
      .border(BasuMetric.hairline, Color(0x0FFFFFFF), shape),
  ) {
    RasterTile(name, size, radius = radius)
  }
}

/**
 * Status, said the way every Basu screen says it: four segments, filled up to
 * the step the order is on — the step being lived now in crimson, the ones
 * behind it in the ink, the ones ahead empty.
 */
@Composable
fun Meter(step: Int, modifier: Modifier = Modifier, total: Int = 4, height: Dp = 4.dp) {
  Row(modifier.fillMaxWidth().clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
    repeat(total) { index ->
      val colour = when {
        index < step - 1 -> BasuColor.ink
        index == step - 1 -> BasuColor.accent
        else -> BasuColor.surface3
      }
      Box(Modifier.weight(1f).height(height).background(colour, RoundedCornerShape(50)))
    }
  }
}

/**
 * The server is not answering — said out loud rather than left as an empty
 * screen, and in the guest's words: a lost connection, the internet to check.
 */
@Composable
fun OfflineBanner(modifier: Modifier = Modifier, retry: suspend () -> Unit) {
  var trying by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  Row(
    modifier
      .fillMaxWidth()
      .card(radius = BasuMetric.card)
      .padding(horizontal = 16.dp, vertical = 14.dp)
      .testTag("offline.banner"),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Symbol(Icons.Outlined.WifiOff, BasuColor.gold, size = 20.dp)
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
      Text("Холболт тасарлаа", color = BasuColor.ink, style = sans(15, FontWeight.Bold))
      Text("Интернэтээ шалгаад дахин оролдоно уу.", color = BasuColor.ink2, style = sans(13, FontWeight.Medium))
    }
    Box(
      Modifier
        .defaultMinSize(minWidth = 72.dp, minHeight = 36.dp)
        .border(BasuMetric.hairline, BasuColor.line2, CircleShape)
        .clip(CircleShape)
        .plainClick(enabled = !trying) {
          scope.launch {
            trying = true
            retry()
            trying = false
          }
        }
        .padding(horizontal = 16.dp)
        .testTag("offline.retry"),
      contentAlignment = Alignment.Center,
    ) {
      if (trying) {
        CircularProgressIndicator(Modifier.size(16.dp), color = BasuColor.ink, strokeWidth = 2.dp)
      } else {
        Text("Дахин", color = BasuColor.ink, style = sans(14, FontWeight.Bold), maxLines = 1)
      }
    }
  }
}

/** A line of trouble, said in Mongolian, in the place it happened. */
@Composable
fun Banner(message: String, modifier: Modifier = Modifier) {
  val shape = RoundedCornerShape(BasuMetric.inner)
  Row(
    modifier
      .fillMaxWidth()
      .background(BasuColor.stopSoft, shape)
      .border(BasuMetric.hairline, BasuColor.stopLine, shape)
      .padding(14.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Symbol(Icons.Outlined.ErrorOutline, BasuColor.accentInk, size = 18.dp)
    Text(message, Modifier.weight(1f), color = BasuColor.accentInk, style = sans(14, FontWeight.Medium))
  }
}

/**
 * The title a tab root carries: the display face at 44, on the ground. The
 * orders, the wallet and the profile are roots — there is nothing to go back
 * to, so there is no back link.
 */
@Composable
fun ShellTitle(text: String, modifier: Modifier = Modifier) {
  Box(
    modifier
      .fillMaxWidth()
      .background(BasuColor.bg)
      .windowInsetsPadding(WindowInsets.statusBars)
      .padding(start = BasuMetric.screenPadding, end = BasuMetric.screenPadding, top = 12.dp, bottom = 20.dp),
  ) {
    FitText(text, display(44), BasuColor.ink, Modifier.semantics { heading() }, minScale = 0.7f)
  }
}

/**
 * The bar of a pushed shell screen: the way back as a round glass button on
 * the left, the title centred on the screen.
 */
@Composable
fun ShellNav(title: String, modifier: Modifier = Modifier, back: () -> Unit) {
  Box(
    modifier
      .fillMaxWidth()
      .background(BasuColor.bg)
      .windowInsetsPadding(WindowInsets.statusBars)
      .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 12.dp)
      .defaultMinSize(minHeight = BasuMetric.minTarget),
    contentAlignment = Alignment.Center,
  ) {
    Text(title, Modifier.semantics { heading() }, color = BasuColor.ink, style = sans(17, FontWeight.Bold))
    Box(
      Modifier
        .align(Alignment.CenterStart)
        .size(BasuMetric.minTarget)
        .glass(CircleShape)
        .clip(CircleShape)
        .pressable(onClick = back)
        .semantics { contentDescription = "Basu нүүр" }
        .testTag("shell.back"),
      contentAlignment = Alignment.Center,
    ) {
      Chevron(BasuColor.ink, direction = ChevronDirection.Back, size = 18.dp)
    }
  }
}

/**
 * A profile picture nobody had to upload: sixteen cells on a 4×4 grid, filled
 * from the eight hex characters identity issues with the account. The right
 * half mirrors the left.
 *
 * - a value divisible by three leaves its cell empty
 * - odd values are circles, even values are squares with a 1dp radius
 * - eight and over take `ink`, below eight takes `ink2`
 * - the *first* value of thirteen or more takes the accent — at most one per mark
 */
@Composable
fun SeedAvatar(seed: String, modifier: Modifier = Modifier, size: Dp = 30.dp) {
  val cells = remember(seed) { seedCells(seed) }
  val inset = size * 0.12f
  val gap = size * 0.09f
  val cell = ((size - inset * 2 - gap * 3) / 4).coerceAtLeast(1.dp)
  Column(
    modifier.size(size).well(radius = size * 0.28f).padding(inset).clearAndSetSemantics {},
    verticalArrangement = Arrangement.spacedBy(gap),
  ) {
    repeat(4) { row ->
      Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
        repeat(4) { column ->
          val item = cells[row * 4 + column]
          Box(
            Modifier.size(cell).then(
              if (item.colour == null) Modifier
              else Modifier.background(item.colour, if (item.round) CircleShape else RoundedCornerShape(1.dp)),
            ),
          )
        }
      }
    }
  }
}

data class SeedCell(val colour: Color?, val round: Boolean)

/** Pure: the mark has to be identical on every device and every release. */
fun seedCells(seed: String): List<SeedCell> {
  val characters = seed.take(8)
  var accentUsed = false
  fun cell(index: Int): SeedCell {
    val value = characters.getOrNull(index)?.digitToIntOrNull(16)
    if (value == null || value % 3 == 0) return SeedCell(null, false)
    var colour = if (value >= 8) BasuColor.ink else BasuColor.ink2
    if (value >= 13 && !accentUsed) {
      colour = BasuColor.accent
      accentUsed = true
    }
    return SeedCell(colour, value % 2 == 1)
  }
  val out = mutableListOf<SeedCell>()
  for (row in 0 until 4) {
    val a = cell(row * 2)
    val b = cell(row * 2 + 1)
    out += listOf(a, b, b, a)
  }
  return out
}

@Composable
fun Gap(height: Dp = 0.dp, width: Dp = 0.dp) {
  Spacer(Modifier.height(height).width(width))
}
