package mn.basu.app.design

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The shell's drawn marks — the tab bar's four, the bell, the arrow on a tile
 * and the magnifier. Every one is described in a 24×24 box and scaled into
 * whatever it is given: stroke 1.75, round caps and joins, one colour, no
 * fills. The same coordinates as the iOS app's `Glyphs.swift`.
 */
enum class ShellMark { Home, Orders, Wallet, Profile, Bell, Arrow, Magnifier }

private class Box(val s: Float) {
  fun x(v: Float) = v * s
  fun p(x: Float, y: Float) = Offset(x * s, y * s)
}

private fun Path.run(b: Box, vararg points: Pair<Float, Float>) {
  moveTo(b.x(points[0].first), b.x(points[0].second))
  for (i in 1 until points.size) lineTo(b.x(points[i].first), b.x(points[i].second))
}

private fun Path.circle(b: Box, x: Float, y: Float, r: Float) {
  addOval(Rect(b.p(x - r, y - r), b.p(x + r, y + r)))
}

private fun Path.quad(b: Box, cx: Float, cy: Float, x: Float, y: Float) =
  quadraticTo(b.x(cx), b.x(cy), b.x(x), b.x(y))

private fun Path.cubic(b: Box, x1: Float, y1: Float, x2: Float, y2: Float, x: Float, y: Float) =
  cubicTo(b.x(x1), b.x(y1), b.x(x2), b.x(y2), b.x(x), b.x(y))

private fun shellPath(mark: ShellMark, b: Box): Path = Path().apply {
  when (mark) {
    ShellMark.Home -> {
      // A house with its door: the roof's ridge, the walls, a doorway cut in.
      moveTo(b.x(4f), b.x(10.5f))
      lineTo(b.x(12f), b.x(4f))
      lineTo(b.x(20f), b.x(10.5f))
      lineTo(b.x(20f), b.x(19f))
      quad(b, 20f, 20f, 19f, 20f)
      lineTo(b.x(14.5f), b.x(20f))
      lineTo(b.x(14.5f), b.x(14.5f))
      lineTo(b.x(9.5f), b.x(14.5f))
      lineTo(b.x(9.5f), b.x(20f))
      lineTo(b.x(5f), b.x(20f))
      quad(b, 4f, 20f, 4f, 19f)
      close()
    }
    ShellMark.Orders -> {
      // A receipt, torn along its foot, with two lines on it.
      run(b, 6f to 3.5f, 18f to 3.5f, 18f to 21f, 15f to 19f, 12f to 21f, 9f to 19f, 6f to 21f, 6f to 3.5f)
      close()
      run(b, 9f to 8.5f, 15f to 8.5f)
      run(b, 9f to 12.5f, 15f to 12.5f)
    }
    ShellMark.Wallet -> {
      moveTo(b.x(4f), b.x(7.5f))
      quad(b, 4f, 5f, 6.5f, 5f)
      lineTo(b.x(18f), b.x(5f))
      lineTo(b.x(18f), b.x(8f))
      moveTo(b.x(4f), b.x(7.5f))
      lineTo(b.x(4f), b.x(18f))
      quad(b, 4f, 20f, 6f, 20f)
      lineTo(b.x(20f), b.x(20f))
      lineTo(b.x(20f), b.x(9f))
      lineTo(b.x(6.5f), b.x(9f))
      quad(b, 4f, 9f, 4f, 7.5f)
      circle(b, 16.5f, 14.5f, 1.2f)
    }
    ShellMark.Profile -> {
      circle(b, 12f, 8.5f, 4f)
      moveTo(b.x(4.5f), b.x(20.5f))
      cubic(b, 5.8f, 16.9f, 8.6f, 15f, 12f, 15f)
      cubic(b, 15.4f, 15f, 18.2f, 16.9f, 19.5f, 20.5f)
    }
    ShellMark.Bell -> {
      moveTo(b.x(6f), b.x(16f))
      lineTo(b.x(6f), b.x(11f))
      arcTo(Rect(b.p(6f, 5f), b.p(18f, 17f)), 180f, 180f, false)
      lineTo(b.x(18f), b.x(16f))
      lineTo(b.x(19.5f), b.x(18f))
      lineTo(b.x(4.5f), b.x(18f))
      close()
      moveTo(b.x(10f), b.x(20.5f))
      quad(b, 12f, 22.6f, 14f, 20.5f)
    }
    ShellMark.Arrow -> {
      run(b, 5f to 12f, 19f to 12f)
      run(b, 13f to 6f, 19f to 12f, 13f to 18f)
    }
    ShellMark.Magnifier -> {
      circle(b, 11f, 11f, 6.5f)
      run(b, 16f to 16f, 20.5f to 20.5f)
    }
  }
}

@Composable
fun ShellGlyph(
  mark: ShellMark,
  tint: Color,
  modifier: Modifier = Modifier,
  size: Dp = 24.dp,
  lineWidth: Float = 1.75f,
) {
  Canvas(modifier.size(size)) {
    val b = Box(this.size.minDimension / 24f)
    drawPath(
      shellPath(mark, b),
      tint,
      style = Stroke(lineWidth.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round),
    )
  }
}

enum class ChevronDirection { Back, Forward }

/** The chevron, pointing whichever way it is asked to. */
@Composable
fun Chevron(
  tint: Color,
  modifier: Modifier = Modifier,
  direction: ChevronDirection = ChevronDirection.Forward,
  size: Dp = 13.dp,
  lineWidth: Float = 2f,
) {
  Canvas(modifier.size(size)) {
    val b = Box(this.size.minDimension / 24f)
    val path = Path().apply {
      if (direction == ChevronDirection.Back) run(b, 15f to 5f, 8f to 12f, 15f to 19f)
      else run(b, 9f to 5f, 16f to 12f, 9f to 19f)
    }
    drawPath(path, tint, style = Stroke(lineWidth.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
  }
}
