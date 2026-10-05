package mn.basu.app.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.Symbol
import mn.basu.app.design.WideButton
import mn.basu.app.design.card
import mn.basu.app.design.display
import mn.basu.app.design.sans

/**
 * Where a signed-out visitor meets something that is theirs alone — the
 * wallet, the profile, the orders — the way in is offered, not forced.
 *
 * The app is open to look around. So a browsing visitor sees the launcher and
 * both apps' stalls and menus; the wallet, the orders and the profile say
 * what they are for in a line and open the sign-in sheet with the screen's
 * one crimson button.
 */
@Composable
fun SignInPrompt(
  symbol: ImageVector,
  title: String,
  detail: String,
  modifier: Modifier = Modifier,
  id: String = "signin.prompt",
) {
  var signingIn by remember { mutableStateOf(false) }
  Column(
    modifier.fillMaxWidth().card(radius = BasuMetric.card).padding(20.dp),
    verticalArrangement = Arrangement.spacedBy(18.dp),
  ) {
    Box(
      Modifier.size(52.dp).background(BasuColor.surface3, RoundedCornerShape(BasuMetric.inner)),
      contentAlignment = Alignment.Center,
    ) {
      Symbol(symbol, BasuColor.ink, size = 24.dp)
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(title, Modifier.semantics { heading() }, color = BasuColor.ink, style = display(29))
      Text(detail, color = BasuColor.ink2, style = sans(15, FontWeight.Medium))
    }
    WideButton("Нэвтрэх", Modifier.testTag(id)) { signingIn = true }
  }
  if (signingIn) SignInSheet(onDismiss = { signingIn = false })
}
