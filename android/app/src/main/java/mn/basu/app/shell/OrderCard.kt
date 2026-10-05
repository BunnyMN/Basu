package mn.basu.app.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import mn.basu.app.core.Format
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.FitText
import mn.basu.app.design.Hairline
import mn.basu.app.design.Meter
import mn.basu.app.design.RasterTile
import mn.basu.app.design.art
import mn.basu.app.design.card
import mn.basu.app.design.display
import mn.basu.app.design.sans
import mn.basu.app.design.tracked

/**
 * One order, as a card: a picture of what it is, what it is, the state in one
 * word with a meter of four under it, and — behind a hairline on the right —
 * the day or the time in the display face over what it is the time of, in gold.
 *
 * The same card on the launcher and under «Захиалга», for a lunch and for a
 * sheep alike. A cancelled order keeps its word, in crimson, and loses the
 * meter; there is nothing left to measure.
 */
@Composable
fun OrderCard(item: LiveItem, modifier: Modifier = Modifier) {
  Column(
    modifier
      .fillMaxWidth()
      .card(radius = BasuMetric.card)
      .clip(RoundedCornerShape(BasuMetric.card))
      .padding(14.dp)
      .clearAndSetSemantics { contentDescription = item.spoken }
      .testTag("live.${item.id}"),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Row(
      Modifier.height(IntrinsicSize.Min),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      Thumbnail(item)
      Column(Modifier.weight(1f)) {
        Text(item.headline, color = BasuColor.ink, style = sans(17, FontWeight.Bold), maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(
          item.word,
          Modifier.padding(top = 6.dp),
          color = when (item.tone) {
            LiveItem.Tone.Plain -> BasuColor.ink2
            LiveItem.Tone.Stop -> BasuColor.accentInk
            LiveItem.Tone.Hold -> BasuColor.gold
          },
          style = sans(14, FontWeight.SemiBold),
        )
        if (item.step > 0) Meter(item.step, Modifier.padding(top = 10.dp))
      }
      // `10/14 · АВАХ` behind a hairline, at the card's full height.
      Row(Modifier.fillMaxHeight(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(BasuMetric.hairline).fillMaxHeight().background(BasuColor.line))
        Column(
          Modifier.padding(start = 12.dp).widthIn(min = 70.dp),
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          FitText(item.whenText, display(32), BasuColor.ink)
          Text(item.timeLabel, color = BasuColor.gold, style = sans(11, FontWeight.Bold).tracked(0.16), maxLines = 1)
        }
      }
    }
    // The fire time, when a lunch is the only thing running: the product is
    // that the kitchen starts as the guest sets off.
    item.extra?.let { (label, time) ->
      Hairline()
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), color = BasuColor.ink3, style = sans(13, FontWeight.SemiBold))
        Text(Format.hhmm(time), color = BasuColor.ink, style = display(20))
      }
    }
  }
}

/**
 * The order's picture: the animal's photograph when the order names one,
 * otherwise the app's own tile, at 64 and fourteen of radius.
 */
@Composable
private fun Thumbnail(item: LiveItem) {
  val shape = RoundedCornerShape(14.dp)
  Box(Modifier.size(64.dp).clip(shape).border(BasuMetric.hairline, Color(0x0FFFFFFF), shape)) {
    if (item.photo != null) {
      AsyncImage(
        model = item.photo,
        contentDescription = null,
        modifier = Modifier.size(64.dp),
        contentScale = ContentScale.Crop,
        placeholder = painterResource(art(item.art)),
        error = painterResource(art(item.art)),
      )
    } else {
      RasterTile(item.art, 64.dp, radius = 0.dp)
    }
  }
}
