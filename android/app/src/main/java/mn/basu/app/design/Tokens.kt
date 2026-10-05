package mn.basu.app.design

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import mn.basu.app.R

/**
 * Every colour, font and metric the design uses. Nothing outside this file is
 * a legal value.
 *
 * «Тансаг хар»: one theme, and it is dark. Basu is dark on every surface
 * whatever the phone's own setting, so each token is one value — the same
 * tokens as the web's app.css (`--bg`, `--surface`, `--ink`, `--accent`,
 * `--gold`…) and the iOS app's `DesignTokens.swift`, with the same hex.
 */
object BasuColor {
  // ── the ground and what stands on it: warm charcoal, never #000 ──────
  val bg = Color(0xFF100D0C)
  val surface = Color(0xFF1C1716)
  val surface2 = Color(0xFF251F1D)
  val surface3 = Color(0xFF2F2826)
  /** The deepest band: a well inside a card, the plate under an avatar. */
  val deep = Color(0xFF0C0A09)
  val sunk = deep

  // ── lines ─────────────────────────────────────────────────────────────
  val line = Color(0xFF2E2725)
  val line2 = Color(0xFF3E3532)

  // ── ink ───────────────────────────────────────────────────────────────
  val ink = Color(0xFFF6F0E8)
  val ink2 = Color(0xFFC4BAB0)
  val ink3 = Color(0xFF998E85)
  /** Text on an off-white button or pill. */
  val onLight = Color(0xFF140F0E)

  // ── crimson: the customer's one primary action per screen ────────────
  val accent = Color(0xFFD21F3C)
  val accentPress = Color(0xFFB5172F)
  /** Crimson as text on the dark: an error, something late, a cancel or a delete. */
  val accentInk = Color(0xFFF2566B)
  val onAccent = Color(0xFFFFFFFF)

  // ── gold: hairlines, step numbers, tiny labels like «АВАХ» ───────────
  val gold = Color(0xFFC9A96E)
  val goldLine = Color(0x80C9A96E)

  /** The 2dp ring around whatever is being typed in. */
  val focus = ink

  // ── glass: the tab bar, a chip on a photo, the way back ─────────────
  // Android draws no blur behind it, so the glass is a little more solid
  // than the iOS one (0.62 over a blur there).
  val glass = Color(0xD9100D0C)
  val glassEdge = Color(0x1FFFFFFF)
  val bar = Color(0xF2201A19)
  val barEdge = Color(0x14FFF4EC)

  // ── what a state means: no green, no orange, no yellow ───────────────
  val ready = ink
  val hold = gold
  val stop = accentInk
  val onStop = onAccent
  val holdSoft = surface
  val holdLine = line2
  val stopSoft = surface
  val stopLine = Color(0x73F2566B)

  val tileShadow = Color(0x8C000000)
  val barShadow = Color(0xCC000000)

  /** The tile's ground: lit from the upper left, settling into the surface. */
  val tileGround: Brush
    get() = Brush.linearGradient(
      0f to Color(0xFF2A2321),
      1f to Color(0xFF1D1817),
      start = androidx.compose.ui.geometry.Offset(0f, 0f),
      end = androidx.compose.ui.geometry.Offset.Infinite,
    )
  val tileEdge = Color(0x0FFFF4EC)
}

/**
 * Manrope for every word; Noto Sans Display Condensed for what is big or
 * counted — headings, money, times, days, order codes. Both carry Ө ө Ү ү,
 * ₮ and №, and both have tabular figures.
 */
object BasuFont {
  val sans = FontFamily(
    Font(R.font.manrope_regular, FontWeight.Normal),
    Font(R.font.manrope_medium, FontWeight.Medium),
    Font(R.font.manrope_semibold, FontWeight.SemiBold),
    Font(R.font.manrope_bold, FontWeight.Bold),
  )
  val display = FontFamily(
    Font(R.font.noto_display_condensed_bold, FontWeight.Bold),
    Font(R.font.noto_display_condensed_extrabold, FontWeight.ExtraBold),
  )
}

private val trim = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)

/** Words. `.heavy` on iOS is Manrope Bold; so is anything past Bold here. */
fun sans(size: Int, weight: FontWeight = FontWeight.Normal): TextStyle = TextStyle(
  fontFamily = BasuFont.sans,
  fontWeight = if (weight.weight > 700) FontWeight.Bold else weight,
  fontSize = size.sp,
  lineHeight = 1.32.em,
  lineHeightStyle = trim,
  platformStyle = PlatformTextStyle(includeFontPadding = false),
)

/**
 * The condensed display face, tabular: 800 (the default) for headings, money,
 * times and codes; 700 (`FontWeight.Bold`) for the smaller headings.
 */
fun display(size: Int, weight: FontWeight = FontWeight.ExtraBold): TextStyle = TextStyle(
  fontFamily = BasuFont.display,
  fontWeight = if (weight.weight >= 800) FontWeight.ExtraBold else FontWeight.Bold,
  fontSize = size.sp,
  lineHeight = 1.12.em,
  lineHeightStyle = trim,
  fontFeatureSettings = "tnum",
  platformStyle = PlatformTextStyle(includeFontPadding = false),
)

/** Tracking in ems, the way the design specifies it: `.tracked(0.14)`. */
fun TextStyle.tracked(em: Double): TextStyle = copy(letterSpacing = em.em)

object BasuMetric {
  // Radii: 8 · 12 menu rows · 16 chips and inner boxes · 22 cards and
  // photos · 28 tiles and sheets · a capsule for buttons, filters and the bar.
  val small = 8.dp
  val row = 12.dp
  val inner = 16.dp
  val card = 22.dp
  val tile = 28.dp
  val iconTile = 18.dp
  val iconTileLarge = 30.dp
  val button = 22.dp
  val chip = 8.dp

  val screenPadding = 20.dp
  /** Bottom content inset, clear of the floating bar (68 tall, 30 up). */
  val tabBarInset = 124.dp
  val hairline = 1.dp
  val minTarget = 44.dp

  val glyph = 34.dp
  val bell = 22.dp
  val avatarLauncher = 30.dp
  val avatarProfile = 56.dp
  /** A field: one height and one corner everywhere a thing is typed. */
  val control = 16.dp
  val controlHeight = 52.dp
  /** The one primary button of a screen: a crimson capsule this tall. */
  val buttonHeight = 56.dp
  val authCard = 28.dp
  val authPhoto = 240.dp
  val swipeAction = 88.dp
}
