package mn.basu.app.calls

import android.content.Context
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * One call's WebRTC: the connection to the other phone, the microphone, and
 * the camera when it is on — the twin of iOS's CallEngine.swift.
 *
 * Voice from the start, and a video line agreed in the first handshake with
 * nothing on it, so the camera turned on later is a track put on that line —
 * no second handshake through the server. A small data channel says when the
 * camera goes on or off. The handshake is complete rather than trickled: one
 * request each way, with every way of reaching the phone already in it.
 *
 * WebRTC calls back on its own threads; the callbacks here are posted to the
 * main thread, where everything else runs.
 */
class CallEngine private constructor(private val context: Context, iceServers: List<IceServer>) {
  companion object {
    private var factory: PeerConnectionFactory? = null
    val egl: EglBase by lazy { EglBase.create() }

    private fun factory(context: Context): PeerConnectionFactory = factory ?: run {
      PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
      PeerConnectionFactory.builder()
        .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
        .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
        .setAudioDeviceModule(
          JavaAudioDeviceModule.builder(context.applicationContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule(),
        )
        .createPeerConnectionFactory()
        .also { factory = it }
    }

    fun create(context: Context, iceServers: List<IceServer>): CallEngine? =
      runCatching { CallEngine(context, iceServers) }.getOrNull()
  }

  private val main = Handler(Looper.getMainLooper())
  private val peerFactory = factory(context)
  private val gathered = CompletableDeferred<Unit>()
  private var closed = false
  private var audioTrack: org.webrtc.AudioTrack? = null
  private var channel: DataChannel? = null
  private var capturer: CameraVideoCapturer? = null
  private var surfaceHelper: SurfaceTextureHelper? = null
  private var videoSource: VideoSource? = null

  /** This phone's camera, while it is on — for the small preview. */
  var localVideo: VideoTrack? = null
    private set
  /** The other side's picture line; only shows anything while their camera is on. */
  var remoteVideo: VideoTrack? = null
    private set
  var frontCamera = false
    private set

  var onConnected: (() -> Unit)? = null
  var onFailed: (() -> Unit)? = null
  var onRemoteCamera: ((Boolean) -> Unit)? = null
  var onRemoteVideo: ((VideoTrack) -> Unit)? = null

  private val peer: PeerConnection

  init {
    val config = PeerConnection.RTCConfiguration(
      iceServers.map { server ->
        PeerConnection.IceServer.builder(server.urls).apply {
          server.username?.let(::setUsername)
          server.credential?.let(::setPassword)
        }.createIceServer()
      },
    ).apply {
      sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
      bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
      rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
      continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
    }
    peer = peerFactory.createPeerConnection(config, Observer()) ?: error("no peer connection")
  }

  // ── the handshake ─────────────────────────────────────────────────

  /** The caller's half: voice, an empty video line, the side channel. */
  suspend fun offer(): String {
    addMicrophone()
    peer.addTransceiver(
      MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
      RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV),
    )
    adopt(peer.createDataChannel("basu", DataChannel.Init()))
    setLocal(describe(offer = true))
    waitGathered()
    return peer.localDescription.description
  }

  /** The person rung's half, made from the caller's offer. */
  suspend fun answer(offer: String): String {
    setRemote(SessionDescription(SessionDescription.Type.OFFER, offer))
    addMicrophone()
    // Ready to send a picture from the start, so the camera needs no second handshake.
    peer.transceivers.filter { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO }
      .forEach { it.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV }
    setLocal(describe(offer = false))
    waitGathered()
    return peer.localDescription.description
  }

  /** The caller, once the other side has answered. */
  suspend fun accept(answer: String) {
    setRemote(SessionDescription(SessionDescription.Type.ANSWER, answer))
  }

  private fun addMicrophone() {
    if (audioTrack != null) return
    val source = peerFactory.createAudioSource(MediaConstraints())
    val track = peerFactory.createAudioTrack("voice", source)
    peer.addTrack(track, listOf("basu"))
    audioTrack = track
  }

  private suspend fun describe(offer: Boolean): SessionDescription = suspendCancellableCoroutine { done ->
    val observer = object : SdpObserver {
      override fun onCreateSuccess(description: SessionDescription) = done.resume(description)
      override fun onCreateFailure(error: String?) = done.resumeWithException(IllegalStateException(error ?: "no description"))
      override fun onSetSuccess() {}
      override fun onSetFailure(error: String?) {}
    }
    if (offer) peer.createOffer(observer, MediaConstraints()) else peer.createAnswer(observer, MediaConstraints())
  }

  private suspend fun setLocal(description: SessionDescription) = set(description, local = true)

  private suspend fun setRemote(description: SessionDescription) = set(description, local = false)

  private suspend fun set(description: SessionDescription, local: Boolean): Unit = suspendCancellableCoroutine { done ->
    val observer = object : SdpObserver {
      override fun onCreateSuccess(description: SessionDescription) {}
      override fun onCreateFailure(error: String?) {}
      override fun onSetSuccess() = done.resume(Unit)
      override fun onSetFailure(error: String?) = done.resumeWithException(IllegalStateException(error ?: "not set"))
    }
    if (local) peer.setLocalDescription(observer, description) else peer.setRemoteDescription(observer, description)
  }

  /** Until every way of reaching this phone is in the description — or two and a half seconds, by when the useful ones are. */
  private suspend fun waitGathered() {
    withTimeoutOrNull(2_500) { gathered.await() }
  }

  // ── during the call ────────────────────────────────────────────────

  fun setMuted(muted: Boolean) {
    audioTrack?.setEnabled(!muted)
  }

  private val videoSender
    get() = peer.transceivers.firstOrNull { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO }?.sender

  /** The back camera first: what is shown is the animal, not the face. */
  fun startCamera(): VideoTrack? {
    if (localVideo != null) return localVideo
    val enumerator = Camera2Enumerator(context)
    val names = enumerator.deviceNames
    val name = names.firstOrNull { enumerator.isBackFacing(it) } ?: names.firstOrNull() ?: return null
    val capturer = enumerator.createCapturer(name, null) ?: return null
    val helper = SurfaceTextureHelper.create("basu-camera", egl.eglBaseContext)
    val source = peerFactory.createVideoSource(false)
    capturer.initialize(helper, context, source.capturerObserver)
    capturer.startCapture(1280, 720, 30)
    val track = peerFactory.createVideoTrack("camera", source)
    videoSender?.setTrack(track, false)
    this.capturer = capturer
    surfaceHelper = helper
    videoSource = source
    localVideo = track
    frontCamera = enumerator.isFrontFacing(name)
    tell(camera = true)
    return track
  }

  fun flipCamera() {
    capturer?.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
      override fun onCameraSwitchDone(front: Boolean) {
        main.post { frontCamera = front }
      }
      override fun onCameraSwitchError(error: String?) {}
    })
  }

  fun stopCamera() {
    videoSender?.setTrack(null, false)
    releaseCamera()
    tell(camera = false)
  }

  private fun releaseCamera() {
    runCatching { capturer?.stopCapture() }
    capturer?.dispose()
    capturer = null
    localVideo?.dispose()
    localVideo = null
    videoSource?.dispose()
    videoSource = null
    surfaceHelper?.dispose()
    surfaceHelper = null
  }

  private fun tell(camera: Boolean) {
    val channel = channel ?: return
    if (channel.state() != DataChannel.State.OPEN) return
    val bytes = JSONObject().put("camera", camera).toString().toByteArray()
    channel.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
  }

  private fun adopt(channel: DataChannel?) {
    this.channel = channel ?: return
    channel.registerObserver(object : DataChannel.Observer {
      override fun onBufferedAmountChange(previous: Long) {}
      override fun onStateChange() {}
      override fun onMessage(buffer: DataChannel.Buffer) {
        val bytes = ByteArray(buffer.data.remaining()).also(buffer.data::get)
        val camera = runCatching { JSONObject(String(bytes)).getBoolean("camera") }.getOrNull() ?: return
        main.post { if (!closed) onRemoteCamera?.invoke(camera) }
      }
    })
  }

  fun close() {
    if (closed) return
    closed = true
    releaseCamera()
    channel?.close()
    peer.close()
    gathered.complete(Unit)
  }

  // ── from WebRTC's threads ─────────────────────────────────────────

  private inner class Observer : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceCandidate(candidate: IceCandidate?) {}
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
    override fun onAddStream(stream: MediaStream?) {}
    override fun onRemoveStream(stream: MediaStream?) {}
    override fun onRenegotiationNeeded() {}
    override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}

    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
      if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.complete(Unit)
    }

    override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) {
      main.post {
        if (closed) return@post
        when (state) {
          PeerConnection.PeerConnectionState.CONNECTED -> onConnected?.invoke()
          PeerConnection.PeerConnectionState.FAILED -> onFailed?.invoke()
          else -> {}
        }
      }
    }

    override fun onTrack(transceiver: RtpTransceiver?) {
      val track = transceiver?.receiver?.track() as? VideoTrack ?: return
      main.post {
        if (closed) return@post
        remoteVideo = track
        onRemoteVideo?.invoke(track)
      }
    }

    override fun onDataChannel(channel: DataChannel?) {
      main.post { if (!closed) adopt(channel) }
    }
  }
}

