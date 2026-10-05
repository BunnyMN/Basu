package mn.basu.app.design

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * A card: the surface, a hairline, twenty-two of radius, and the shadow that
 * lifts it off the ground — with a breath of light along its top edge, the
 * way a lacquered thing catches the room.
 */
fun Modifier.card(
  radius: Dp = BasuMetric.card,
  fill: Brush = SolidColor(BasuColor.surface),
  stroke: Color = BasuColor.line,
): Modifier {
  val shape = RoundedCornerShape(radius)
  return this
    .shadow(14.dp, shape, clip = false, ambientColor = Color.Black, spotColor = Color.Black)
    .background(fill, shape)
    .border(BasuMetric.hairline, stroke, shape)
    .drawWithContent {
      drawContent()
      // `inset 0 1px 0 rgba(255,244,236,.05)`
      val r = radius.toPx()
      drawRoundRect(
        brush = Brush.verticalGradient(
          0f to Color(0x0DFFF4EC),
          1f to Color.Transparent,
          startY = 0f,
          endY = size.height * 0.12f,
        ),
        topLeft = Offset(0.5f, 0.5f),
        size = Size(size.width - 1f, size.height - 1f),
        cornerRadius = CornerRadius(r, r),
        style = Stroke(1.dp.toPx()),
      )
    }
}

/** A card with a plain colour for its fill. */
fun Modifier.card(radius: Dp = BasuMetric.card, fill: Color, stroke: Color = BasuColor.line): Modifier =
  card(radius, SolidColor(fill), stroke)

/** The sunken variant: a well inside a card. */
fun Modifier.well(radius: Dp = BasuMetric.inner): Modifier {
  val shape = RoundedCornerShape(radius)
  return background(BasuColor.sunk, shape).border(BasuMetric.hairline, BasuColor.line, shape)
}

/** Glass: a chip on a photograph, the way back over a page. */
fun Modifier.glass(shape: Shape): Modifier =
  background(BasuColor.glass, shape).border(BasuMetric.hairline, BasuColor.glassEdge, shape)

/** `--glow`: the crimson button's own light, and nothing else's. */
fun Modifier.glow(on: Boolean = true, shape: Shape = RoundedCornerShape(50)): Modifier =
  if (on) shadow(14.dp, shape, clip = false, ambientColor = BasuColor.accent, spotColor = BasuColor.accent) else this

/**
 * Shrinks a touch under the thumb: the only answer a tap gets before the
 * server's. No ripple — the iOS app has none, and the two are one product.
 */
fun Modifier.pressable(
  enabled: Boolean = true,
  role: Role? = Role.Button,
  onClickLabel: String? = null,
  onClick: () -> Unit,
): Modifier = composed {
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
    .clickable(source, indication = null, enabled = enabled, role = role, onClickLabel = onClickLabel, onClick = onClick)
}

/** A tap with no answer of its own at all: a plain row, a text link. */
fun Modifier.plainClick(enabled: Boolean = true, role: Role? = Role.Button, onClick: () -> Unit): Modifier = composed {
  clickable(remember { MutableInteractionSource() }, indication = null, enabled = enabled, role = role, onClick = onClick)
}

fun Modifier.clipRound(radius: Dp): Modifier = clip(RoundedCornerShape(radius))
