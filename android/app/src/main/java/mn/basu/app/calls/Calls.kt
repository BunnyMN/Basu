package mn.basu.app.calls

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.os.Build
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import mn.basu.app.core.Api
import mn.basu.app.core.ApiError
import org.webrtc.VideoTrack

/**
 * Calls about an order, on Android — the twin of iOS's CallCenter.
 *
 * Outgoing calls start from the order page (`shell.call` → ServiceView's
 * bridge). Incoming ones ring while the app is open: the shell asks the
 * server «is anything ringing me?» and is held until something is. A phone
 * with the app closed is not rung yet — that needs Firebase, which this
 * build does not have — so a missed ring stays in the inbox as «Аваагүй
 * дуудлага». The call keeps talking with the app in the background through
 * a foreground service (CallService), as Android asks of anything using the
 * microphone out of sight.
 *
 * One call at a time. Everything runs on the main thread.
 */
object Calls {
  enum class Role { CALLER, CALLEE }

  sealed interface Phase {
    data object RingingOut : Phase
    data object RingingIn : Phase
    data object Connecting : Phase
    data object Talking : Phase
    data class Ended(val words: String) : Phase
  }

  /** The one call, as the screen draws it. */
  data class Live(
    val key: Long,
    val role: Role,
    val subject: String,
    val subjectId: String,
    val peerName: String,
    val about: String,
    val phase: Phase,
    val callId: String? = null,
    val offer: String? = null,
    val startedAt: Long? = null,
    val muted: Boolean = false,
    val cameraOn: Boolean = false,
    val speaker: Boolean = false,
    val remoteCamera: Boolean = false,
  )

  var live: Live? by mutableStateOf(null)
    private set
  var remoteVideo: VideoTrack? by mutableStateOf(null)
    private set
  var localVideo: VideoTrack? by mutableStateOf(null)
    private set

  /** The screen: a call this phone made, or one it is answering or has answered. */
  val presenting: Boolean get() = live != null

  /** Asks Android for permissions, set by MainActivity (it owns the launcher). */
  var request: (suspend (Array<String>) -> Boolean)? = null

  private lateinit var context: Context
  private lateinit var api: Api
  private var tokenOf: () -> String? = { null }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var engine: CallEngine? = null
  private var following: Job? = null
  private var listening: Job? = null
  private var ringtone: Ringtone? = null
  private var ringback: ToneGenerator? = null
  private var savedMode: Int? = null

  fun attach(context: Context, api: Api, token: () -> String?) {
    this.context = context.applicationContext
    this.api = api
    tokenOf = token
    // Rung only while the app is open: listening stops when it goes out of sight.
    ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
      override fun onStart(owner: LifecycleOwner) = listen()
      override fun onStop(owner: LifecycleOwner) {
        listening?.cancel()
      }
    })
  }

  // ── ringing out ──────────────────────────────────────────────────

  fun ringOut(subject: String, subjectId: String, peerName: String) {
    if (live != null || tokenOf() == null) return
    val key = SystemClock.elapsedRealtime()
    live = Live(key, Role.CALLER, subject, subjectId, peerName, about = "", phase = Phase.RingingOut)
    scope.launch {
      try {
        if (!ensure(Manifest.permission.RECORD_AUDIO)) return@launch teardown("Микрофонд хандах зөвшөөрөл алга. Тохиргооноос зөвшөөрнө үү.")
        val token = tokenOf() ?: return@launch teardown("")
        audioOn()
        val engine = CallEngine.create(context, api.iceServers(token)) ?: return@launch end("Залгаж чадсангүй.")
        adopt(engine)
        val offer = engine.offer()
        if (live?.key != key) return@launch engine.close()
        val started = api.startCall(subject, subjectId, offer, token)
        if (live?.key != key) {
          runCatching { api.endCall(started.id, token) }
          return@launch
        }
        live = live?.copy(callId = started.id, about = started.about)
        ringback = runCatching { ToneGenerator(AudioManager.STREAM_VOICE_CALL, 70).apply { startTone(ToneGenerator.TONE_SUP_RINGTONE) } }.getOrNull()
        CallService.start(context, camera = false)
        follow(started.id)
      } catch (error: CancellationException) {
        throw error
      } catch (error: ApiError) {
        end(error.message)
      } catch (error: Exception) {
        end("Залгаж чадсангүй.")
      }
    }
  }

  // ── ringing in ───────────────────────────────────────────────────

  private fun listen() {
    if (listening?.isActive == true) return
    listening = scope.launch {
      var known = emptyList<String>()
      val seen = mutableSetOf<String>()
      while (isActive) {
        val token = tokenOf()
        if (token == null) {
          delay(5_000)
          continue
        }
        try {
          val calls = api.ringing(known, wait = 10, token = token)
          known = calls.map(CallInfo::id)
          val fresh = calls.firstOrNull { it.id !in seen }
          seen += known
          if (fresh != null && live == null) ringIn(fresh)
        } catch (error: CancellationException) {
          throw error
        } catch (error: ApiError) {
          delay(if (error.status == 401) 30_000 else 5_000)
        } catch (error: Exception) {
          delay(5_000)
        }
      }
    }
  }

  private fun ringIn(call: CallInfo) {
    live = Live(
      key = SystemClock.elapsedRealtime(),
      role = Role.CALLEE,
      subject = call.subject,
      subjectId = call.subjectId,
      peerName = call.peerName,
      about = call.about,
      phase = Phase.RingingIn,
      callId = call.id,
      offer = call.offer,
    )
    ringtone = runCatching {
      RingtoneManager.getRingtone(context, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))?.apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
        play()
      }
    }.getOrNull()
    follow(call.id)
  }

  fun answer() {
    val call = live ?: return
    if (call.phase != Phase.RingingIn) return
    val offer = call.offer ?: return
    val callId = call.callId ?: return
    stopTones()
    live = call.copy(phase = Phase.Connecting)
    scope.launch {
      try {
        if (!ensure(Manifest.permission.RECORD_AUDIO)) {
          // Nobody here can talk; somebody else at the supplier still may.
          return@launch teardown("Микрофонд хандах зөвшөөрөл алга. Тохиргооноос зөвшөөрнө үү.")
        }
        val token = tokenOf() ?: return@launch teardown("")
        audioOn()
        val engine = CallEngine.create(context, api.iceServers(token)) ?: return@launch end("Холбогдож чадсангүй.")
        adopt(engine)
        val answer = engine.answer(offer)
        api.answerCall(callId, answer, token)
        CallService.start(context, camera = false)
      } catch (error: CancellationException) {
        throw error
      } catch (error: ApiError) {
        teardown(if (error.code == "TAKEN") "Өөр хүн дуудлагыг авлаа." else error.message)
      } catch (error: Exception) {
        end("Холбогдож чадсангүй.")
      }
    }
  }

  // ── the call on the server ───────────────────────────────────────

  private fun follow(id: String) {
    following?.cancel()
    following = scope.launch {
      var after = -1
      while (isActive && live?.callId == id) {
        val token = tokenOf() ?: return@launch
        try {
          val call = api.call(id, after, wait = 10, token = token)
          after = call.version
          apply(call)
        } catch (error: CancellationException) {
          throw error
        } catch (error: ApiError) {
          if (error.status == 404) return@launch teardown("Дуудлага олдсонгүй.")
          delay(2_000)
        } catch (error: Exception) {
          delay(2_000)
        }
      }
    }
  }

  private suspend fun apply(call: CallInfo) {
    val now = live ?: return
    if (now.callId != call.id) return
    if (call.about.isNotBlank()) live = now.copy(about = call.about)
    if (call.state == "answered") {
      if (now.role == Role.CALLER && now.phase == Phase.RingingOut && call.answer != null) {
        stopTones()
        live = live?.copy(phase = Phase.Connecting)
        try {
          engine?.accept(call.answer)
        } catch (error: Exception) {
          return end("Холбогдож чадсангүй.")
        }
      } else if (now.role == Role.CALLEE && !call.answeredHere && now.phase == Phase.RingingIn) {
        return teardown("Өөр хүн дуудлагыг авлаа.")
      }
    }
    if (call.isOver) teardown(words(call, now.role))
  }

  private fun words(call: CallInfo, role: Role): String = when (call.state) {
    "declined" -> if (role == Role.CALLER) "Татгалзлаа." else "Дуудлагаас татгалзлаа."
    "missed" -> if (role == Role.CALLER) "Хариу өгсөнгүй." else "Аваагүй дуудлага."
    "cancelled" -> if (role == Role.CALLER) "Дуудлагыг цуцаллаа." else "Залгагч тасаллаа."
    else -> if (call.endReason == "too_long") "Дуудлага хэт удсан тул тасаллаа." else "Дуудлага дууслаа."
  }

  private fun adopt(engine: CallEngine) {
    this.engine?.close()
    this.engine = engine
    engine.onConnected = {
      val now = live
      if (now != null && now.phase != Phase.Talking) live = now.copy(phase = Phase.Talking, startedAt = SystemClock.elapsedRealtime())
    }
    engine.onFailed = { end("Холболт тасарлаа.") }
    engine.onRemoteCamera = { on -> live = live?.copy(remoteCamera = on) }
    engine.onRemoteVideo = { track -> remoteVideo = track }
  }

  // ── from the screen ──────────────────────────────────────────────

  fun hangUp() {
    val call = live ?: return
    if (call.phase is Phase.Ended) return teardown("")
    end(if (call.role == Role.CALLEE && call.phase == Phase.RingingIn) "Дуудлагаас татгалзлаа." else "Дуудлага дууслаа.")
  }

  fun toggleMute() {
    val call = live ?: return
    engine?.setMuted(!call.muted)
    live = call.copy(muted = !call.muted)
  }

  fun toggleCamera() {
    val call = live ?: return
    val engine = engine ?: return
    if (call.cameraOn) {
      engine.stopCamera()
      localVideo = null
      live = call.copy(cameraOn = false)
      CallService.start(context, camera = false)
      return
    }
    scope.launch {
      if (!ensure(Manifest.permission.CAMERA)) return@launch
      val track = engine.startCamera() ?: return@launch
      localVideo = track
      // A picture wants the loudspeaker.
      setSpeaker(true)
      live = live?.copy(cameraOn = true, speaker = true)
      CallService.start(context, camera = true)
    }
  }

  fun flipCamera() {
    engine?.flipCamera()
  }

  fun toggleSpeaker() {
    val call = live ?: return
    setSpeaker(!call.speaker)
    live = call.copy(speaker = !call.speaker)
  }

  val frontCamera: Boolean get() = engine?.frontCamera ?: false

  // ── ending ──────────────────────────────────────────────────────

  /** Over from this side: the server is told, and the screen says why. */
  internal fun end(words: String) {
    val call = live ?: return
    val token = tokenOf()
    if (call.callId != null && token != null) scope.launch { runCatching { api.endCall(call.callId, token) } }
    teardown(words)
  }

  private fun teardown(words: String) {
    following?.cancel()
    following = null
    engine?.close()
    engine = null
    remoteVideo = null
    localVideo = null
    stopTones()
    audioOff()
    CallService.stop(context)
    val key = live?.key ?: return
    if (words.isBlank()) {
      live = null
      return
    }
    live = live?.copy(phase = Phase.Ended(words))
    scope.launch {
      delay(1_600)
      if (live?.key == key) live = null
    }
  }

  // ── the phone's audio ───────────────────────────────────────────

  private val audio: AudioManager get() = context.getSystemService(AudioManager::class.java)

  private fun audioOn() {
    if (savedMode == null) savedMode = audio.mode
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    setSpeaker(false)
  }

  private fun audioOff() {
    savedMode?.let { audio.mode = it }
    savedMode = null
    setSpeaker(false)
  }

  @Suppress("DEPRECATION")
  private fun setSpeaker(on: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      if (on) {
        audio.availableCommunicationDevices.firstOrNull { it.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
          ?.let(audio::setCommunicationDevice)
      } else {
        audio.clearCommunicationDevice()
      }
    } else {
      audio.isSpeakerphoneOn = on
    }
  }

  private fun stopTones() {
    runCatching { ringtone?.stop() }
    ringtone = null
    runCatching {
      ringback?.stopTone()
      ringback?.release()
    }
    ringback = null
  }

  private suspend fun ensure(permission: String): Boolean {
    if (ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED) return true
    return request?.invoke(arrayOf(permission)) ?: false
  }
}
