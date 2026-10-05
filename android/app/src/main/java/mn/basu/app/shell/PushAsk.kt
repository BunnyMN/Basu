package mn.basu.app.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.BasuSheet
import mn.basu.app.design.PrimaryButton
import mn.basu.app.design.Symbol
import mn.basu.app.design.display
import mn.basu.app.design.sans

/** Who the question is for: a guest's order, or a supplier's counter. */
enum class PushAudience { Guest, Supplier }

/**
 * The shell's own words before the phone's: what the notifications will be
 * about, in Mongolian, at the moment there is something to be told about.
 * Its one button leads to Android's dialog, where the yes or the no is given;
 * there is no other way out of it, and it cannot be swiped away.
 */
@Composable
fun PushAsk(audience: PushAudience, proceed: () -> Unit) {
  BasuSheet(onDismiss = {}, locked = true) {
    Column(
      Modifier.fillMaxWidth().padding(horizontal = BasuMetric.screenPadding).padding(top = 32.dp, bottom = 16.dp),
      verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
      Box(
        Modifier.size(52.dp).background(BasuColor.surface3, RoundedCornerShape(BasuMetric.inner)),
        contentAlignment = Alignment.Center,
      ) {
        Symbol(Icons.Outlined.NotificationsActive, BasuColor.ink, size = 24.dp)
      }
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
          if (audience == PushAudience.Supplier) "Шинэ захиалгыг утсандаа аваарай" else "Захиалгын явцыг утсандаа аваарай",
          Modifier.semantics { heading() },
          color = BasuColor.ink,
          style = display(36),
        )
        Text(
          if (audience == PushAudience.Supplier) "Захиалга орж ирмэгц утсанд тань мэдэгдэнэ." else "Бэлэн болох, замд гарахад нь мэдэгдэнэ.",
          color = BasuColor.ink2,
          style = sans(16, FontWeight.Medium),
        )
        // What happens next, said before it does: the phone's own question.
        Text("Дараа нь утас тань зөвшөөрөл асууна.", color = BasuColor.ink3, style = sans(13, FontWeight.Medium))
      }
      PrimaryButton("Үргэлжлүүлэх", enabled = true, busy = false, modifier = Modifier.testTag("push.continue"), action = proceed)
    }
  }
}
