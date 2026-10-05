package mn.basu.app.design

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/**
 * A sheet, the way the iOS app presents one: up from the foot of the screen
 * on `surface2`, twenty-eight of radius, sized to what it says. `full` takes
 * the whole height (the way in); `locked` cannot be swiped or backed away
 * (the push pre-prompt).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BasuSheet(
  onDismiss: () -> Unit,
  full: Boolean = false,
  locked: Boolean = false,
  ground: Color = BasuColor.surface2,
  content: @Composable ColumnScope.() -> Unit,
) {
  val state = rememberModalBottomSheetState(
    skipPartiallyExpanded = true,
    confirmValueChange = { !locked },
  )
  ModalBottomSheet(
    onDismissRequest = { if (!locked) onDismiss() },
    sheetState = state,
    containerColor = ground,
    contentColor = BasuColor.ink,
    scrimColor = Color(0x99000000),
    shape = RoundedCornerShape(topStart = BasuMetric.tile, topEnd = BasuMetric.tile),
    tonalElevation = 0.dp,
    dragHandle = if (locked) null else {
      {
        Box(
          Modifier.padding(top = 8.dp, bottom = 4.dp).width(36.dp).height(5.dp).background(BasuColor.line2, CircleShape),
        )
      }
    },
    contentWindowInsets = { WindowInsets.statusBars },
    properties = ModalBottomSheetProperties(shouldDismissOnBackPress = !locked),
  ) {
    Column(
      Modifier
        .fillMaxWidth()
        .then(if (full) Modifier.fillMaxHeight() else Modifier)
        .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime)),
      content = content,
    )
  }
}

/**
 * An alert: a title, a line, and one or two answers. `destructive` sets the
 * confirming answer in crimson — what it does is not undone.
 */
@Composable
fun BasuAlert(
  title: String,
  message: String? = null,
  confirm: String = "Ойлголоо",
  destructive: Boolean = false,
  cancel: String? = null,
  onConfirm: () -> Unit,
  onDismiss: () -> Unit,
) {
  Dialog(onDismissRequest = onDismiss, properties = DialogProperties()) {
    Column(
      Modifier
        .fillMaxWidth()
        .card(radius = BasuMetric.card, fill = BasuColor.surface2)
        .padding(start = 22.dp, end = 22.dp, top = 22.dp, bottom = 10.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(title, color = BasuColor.ink, style = sans(17, FontWeight.Bold))
      if (!message.isNullOrEmpty()) {
        Text(message, color = BasuColor.ink2, style = sans(14, FontWeight.Medium))
      }
      Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
        if (cancel != null) {
          QuietLink(cancel, Modifier.padding(horizontal = 12.dp), action = onDismiss)
        }
        Box(
          Modifier.padding(start = 12.dp).height(BasuMetric.minTarget).plainClick(onClick = onConfirm),
          contentAlignment = Alignment.Center,
        ) {
          Text(confirm, color = if (destructive) BasuColor.accentInk else BasuColor.ink, style = sans(14, FontWeight.Bold))
        }
      }
    }
  }
}

/**
 * A sheet of the profile's: `surface2`, «Болих» on the left with the title
 * centred in its bar, and the form under it made of the way in's own parts —
 * so adding an address looks like the app that signed you in, not a settings
 * screen from another one. The wallet's amount sheet is one of these too.
 */
@Composable
fun ProfileSheet(
  title: String,
  onDismiss: () -> Unit,
  full: Boolean = false,
  content: @Composable ColumnScope.() -> Unit,
) {
  BasuSheet(onDismiss = onDismiss, full = full) {
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(BasuMetric.minTarget), contentAlignment = Alignment.Center) {
      Text(title, color = BasuColor.ink, style = sans(17, FontWeight.Bold))
      QuietLink("Болих", Modifier.align(Alignment.CenterStart).padding(horizontal = 12.dp), action = onDismiss)
    }
    Column(
      Modifier
        .fillMaxWidth()
        .verticalScroll(rememberScrollState())
        .padding(horizontal = BasuMetric.screenPadding)
        .padding(top = 8.dp, bottom = 28.dp),
      content = content,
    )
  }
}
