package mn.basu.app.shell

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch
import mn.basu.app.design.BasuColor

/** Pull down to ask again: the spinner in the ink on a raised surface, clear of the clock. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Refreshable(onRefresh: suspend () -> Unit, modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
  var refreshing by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  val state = rememberPullToRefreshState()
  PullToRefreshBox(
    isRefreshing = refreshing,
    onRefresh = {
      scope.launch {
        refreshing = true
        try {
          onRefresh()
        } finally {
          refreshing = false
        }
      }
    },
    modifier = modifier,
    state = state,
    indicator = {
      PullToRefreshDefaults.Indicator(
        state = state,
        isRefreshing = refreshing,
        modifier = Modifier.align(Alignment.TopCenter).windowInsetsPadding(WindowInsets.statusBars),
        containerColor = BasuColor.surface2,
        color = BasuColor.ink,
      )
    },
    content = content,
  )
}
