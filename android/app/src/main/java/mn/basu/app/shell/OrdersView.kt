package mn.basu.app.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import mn.basu.app.auth.SignInPrompt
import mn.basu.app.core.LocalAppModel
import mn.basu.app.core.LocalSession
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.OfflineBanner
import mn.basu.app.design.SectionLabel
import mn.basu.app.design.ShellTitle
import mn.basu.app.design.WideButton
import mn.basu.app.design.display
import mn.basu.app.design.pressable
import mn.basu.app.design.sans

/**
 * «Захиалга»: every order of the guest's the shell knows about, from both
 * apps, as the launcher's own cards — what is still on its way first, then
 * what is over.
 *
 * It reads what the launcher reads, so the two never disagree; a card opens
 * the order inside its own app, where the rest of its story is.
 */
@Composable
fun OrdersView(open: (Destination) -> Unit) {
  val model = LocalAppModel.current
  val session = LocalSession.current
  // Asked for since the screen opened: until then an empty list is "not
  // yet", not "nothing".
  var loaded by remember { mutableStateOf(false) }
  val items = liveItems()
  val running = items.filter { !it.finished }
  val over = items.filter { it.finished }

  LaunchedEffect(session.token) {
    model.refreshLive()
    loaded = true
  }

  Column(Modifier.fillMaxSize().background(BasuColor.bg)) {
    ShellTitle("Захиалга")
    Refreshable(onRefresh = { model.refreshLive() }, modifier = Modifier.fillMaxSize()) {
      Column(
        Modifier
          .fillMaxSize()
          .verticalScroll(rememberScrollState())
          .padding(horizontal = 16.dp)
          .padding(top = 4.dp, bottom = BasuMetric.tabBarInset + navBottom()),
        verticalArrangement = Arrangement.spacedBy(36.dp),
      ) {
        when {
          !session.isSignedIn -> SignInPrompt(
            symbol = Icons.Outlined.ReceiptLong,
            title = "Захиалгаа энд харна",
            detail = "Нэвтэрмэгц захиалга тань энд гарна.",
            id = "orders.signin",
            modifier = Modifier.padding(top = 8.dp),
          )
          model.offline && items.isEmpty() -> OfflineBanner { model.retry() }
          items.isEmpty() -> if (loaded) Empty(open) else Skeleton()
          else -> {
            if (running.isNotEmpty()) Section("Идэвхтэй", running, open)
            if (over.isNotEmpty()) Section("Дууссан", over, open)
          }
        }
      }
    }
  }
}

@Composable
private fun Section(label: String, items: List<LiveItem>, open: (Destination) -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    SectionLabel(label, Modifier.padding(horizontal = 4.dp))
    for (item in items) {
      OrderCard(item, Modifier.pressable { item.destination?.let(open) })
    }
  }
}

/** One line and one button: nothing is running, and here is where to start. */
@Composable
private fun Empty(open: (Destination) -> Unit) {
  Column(Modifier.padding(top = 8.dp)) {
    Text("Захиалга алга", Modifier.testTag("orders.empty"), color = BasuColor.ink, style = display(36))
    Text(
      "Идэш эсвэл хоолоо эндээс захиална.",
      Modifier.padding(top = 12.dp, bottom = 20.dp),
      color = BasuColor.ink2,
      style = sans(16, FontWeight.Medium),
    )
    WideButton("Идэш сонгох", Modifier.testTag("orders.start")) { open(AppCatalogue.idesh.destination) }
  }
}

/** Two cards in the shape of what is coming. */
@Composable
private fun Skeleton() {
  Column(Modifier.semantics { contentDescription = "Уншиж байна" }, verticalArrangement = Arrangement.spacedBy(12.dp)) {
    repeat(2) {
      Box(Modifier.fillMaxWidth().height(94.dp).background(BasuColor.surface, RoundedCornerShape(BasuMetric.card)))
    }
  }
}
