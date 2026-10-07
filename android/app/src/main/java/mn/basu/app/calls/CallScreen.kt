package mn.basu.app.calls

import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import mn.basu.app.design.BasuColor
import mn.basu.app.design.display
import mn.basu.app.design.plainClick
import mn.basu.app.design.sans
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/**
 * The call, over everything — the same screen the website and iOS draw: the
 * order it is about in gold, the other side's name, how it is going, and
 * round buttons along the bottom. Answering is the off-white one, hanging up
 * the crimson one; no green, as everywhere else. The other side's camera,
 * when it is on, fills the screen behind the words.
 */
@Composable
fun CallScreen() {
  val call = Calls.live ?: return
  // The call is not left by the back gesture: it is hung up, or it goes on.
  BackHandler {}
  val remote = Calls.remoteVideo
  val local = Calls.localVideo

  Box(
    Modifier
      .fillMaxSize()
      .background(Brush.radialGradient(listOf(BasuColor.surface2, BasuColor.deep), radius = 1800f))
      .pointerInput(Unit) {}
      .testTag("call.screen"),
  ) {
    if (call.remoteCamera && remote != null) {
      VideoView(remote, Modifier.fillMaxSize().semantics { contentDescription = "Нөгөө талын камер" })
      Box(
        Modifier.fillMaxSize().background(
          Brush.verticalGradient(
            0f to BasuColor.deep.copy(alpha = 0.6f),
            0.28f to Color.Transparent,
            0.62f to Color.Transparent,
            1f to BasuColor.deep.copy(alpha = 0.8f),
          ),
        ),
      )
    }

    Column(
      Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(horizontal = 24.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Spacer(Modifier.height(56.dp))
      if (call.about.isNotBlank()) {
        Text(call.about.uppercase(), style = sans(12, FontWeight.Bold), color = BasuColor.gold, letterSpacing = 1.4.sp)
        Spacer(Modifier.height(10.dp))
      }
      Text(
        call.peerName,
        style = display(36),
        color = BasuColor.ink,
        textAlign = TextAlign.Center,
        maxLines = 2,
        modifier = Modifier.semantics { heading() },
      )
      Spacer(Modifier.height(10.dp))
      Status(call)
      Spacer(Modifier.weight(1f))

      if (call.cameraOn && local != null) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
          VideoView(
            local,
            Modifier
              .size(width = 96.dp, height = 128.dp)
              .clip(RoundedCornerShape(12.dp))
              .border(1.dp, BasuColor.goldLine, RoundedCornerShape(12.dp))
              .semantics { contentDescription = "Таны камер" },
            mirror = Calls.frontCamera,
          )
        }
        Spacer(Modifier.height(20.dp))
      }

      Buttons(call)
      Spacer(Modifier.height(36.dp))
    }
  }
}

@Composable
private fun Status(call: Calls.Live) {
  var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
  LaunchedEffect(call.phase) {
    while (call.phase == Calls.Phase.Talking) {
      now = SystemClock.elapsedRealtime()
      delay(1_000 - (now - (call.startedAt ?: now)) % 1_000)
    }
  }
  val text = when (val phase = call.phase) {
    Calls.Phase.RingingOut -> if (call.callId == null) "Залгаж байна…" else "Дуугарч байна…"
    Calls.Phase.RingingIn -> "Танд залгаж байна…"
    Calls.Phase.Connecting -> "Холбогдож байна…"
    Calls.Phase.Talking -> {
      val seconds = ((SystemClock.elapsedRealtime().coerceAtLeast(now) - (call.startedAt ?: now)) / 1000).coerceAtLeast(0)
      "%02d:%02d".format(seconds / 60, seconds % 60)
    }
    is Calls.Phase.Ended -> phase.words
  }
  Text(text, style = sans(16, FontWeight.SemiBold), color = BasuColor.ink2, textAlign = TextAlign.Center)
}

@Composable
private fun Buttons(call: Calls.Live) {
  when (call.phase) {
    is Calls.Phase.Ended -> Spacer(Modifier.height(92.dp))
    Calls.Phase.RingingIn -> Row(horizontalArrangement = Arrangement.spacedBy(56.dp)) {
      Round(Icons.Filled.CallEnd, "Татгалзах", tone = Tone.END) { Calls.hangUp() }
      Round(Icons.Filled.Call, "Авах", tone = Tone.ANSWER) { Calls.answer() }
    }
    // Four across a 360dp phone: spread over the width rather than spaced by a fixed gap.
    else -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
      Round(if (call.muted) Icons.Filled.MicOff else Icons.Filled.Mic, if (call.muted) "Дуу нээх" else "Дуу хаах", on = call.muted) { Calls.toggleMute() }
      Round(if (call.cameraOn) Icons.Filled.VideocamOff else Icons.Filled.Videocam, if (call.cameraOn) "Камер унтраах" else "Камер", on = call.cameraOn) {
        Calls.toggleCamera()
      }
      if (call.cameraOn) {
        Round(Icons.Filled.Cameraswitch, "Эргүүлэх") { Calls.flipCamera() }
      } else {
        Round(Icons.Filled.VolumeUp, "Чанга", on = call.speaker) { Calls.toggleSpeaker() }
      }
      Round(Icons.Filled.CallEnd, "Таслах", tone = Tone.END, tag = "call.end") { Calls.hangUp() }
    }
  }
}

private enum class Tone { PLAIN, ANSWER, END }

@Composable
private fun Round(icon: ImageVector, label: String, on: Boolean = false, tone: Tone = Tone.PLAIN, tag: String? = null, action: () -> Unit) {
  val (fill, ink) = when {
    tone == Tone.END -> BasuColor.accent to BasuColor.onAccent
    tone == Tone.ANSWER || on -> BasuColor.ink to BasuColor.onLight
    else -> BasuColor.surface3 to BasuColor.ink
  }
  Column(
    Modifier
      .width(68.dp)
      .plainClick(onClick = action)
      .semantics { contentDescription = label }
      .let { if (tag != null) it.testTag(tag) else it },
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Box(
      Modifier
        .size(64.dp)
        .shadow(if (tone == Tone.END) 14.dp else 0.dp, CircleShape, ambientColor = BasuColor.accent, spotColor = BasuColor.accent)
        .background(fill, CircleShape),
      contentAlignment = Alignment.Center,
    ) {
      Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(26.dp))
    }
    Spacer(Modifier.height(8.dp))
    Text(label, style = sans(12, FontWeight.SemiBold), color = BasuColor.ink2, maxLines = 1)
  }
}

/**
 * A WebRTC video track on a SurfaceView, released when it leaves the screen.
 * The track moves to the same view when it changes (the other side turned
 * the camera off and on): adding a sink twice is adding it once.
 */
@Composable
private fun VideoView(track: VideoTrack, modifier: Modifier, mirror: Boolean = false) {
  val view = remember { arrayOfNulls<SurfaceViewRenderer>(1) }
  AndroidView(
    factory = { context ->
      SurfaceViewRenderer(context).apply {
        init(CallEngine.egl.eglBaseContext, null)
        setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        setEnableHardwareScaler(true)
        view[0] = this
        track.addSink(this)
      }
    },
    update = { it.setMirror(mirror) },
    onRelease = { it.release() },
    modifier = modifier,
  )
  DisposableEffect(track) {
    view[0]?.let(track::addSink)
    onDispose { view[0]?.let { runCatching { track.removeSink(it) } } }
  }
}
