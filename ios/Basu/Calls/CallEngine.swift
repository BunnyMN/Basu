import AVFoundation
@preconcurrency import WebRTC

/// WebRTC's objects cross from its own threads to the main actor in this, and only this.
private struct Handed<T>: @unchecked Sendable {
  let value: T
}

/**
 One call's WebRTC: the connection to the other phone, the microphone, and
 the camera when it is on.

 Voice from the start; a video line is agreed in the first handshake too, with
 nothing on it, so turning the camera on later is putting a track on that
 line — no second handshake through the server. A small data channel says
 when the camera goes on or off, which the picture alone says late.

 The handshake is complete rather than trickled: the offer and the answer go
 to the server once, with every way of reaching the phone already in them
 (`gathered`). One request each way, which is what the long-polling server
 is built for.

 Main actor throughout. WebRTC calls back on its own threads; those
 callbacks only hand values over.
 */
@MainActor
final class CallEngine: NSObject {
  private static let factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    return RTCPeerConnectionFactory(
      encoderFactory: RTCDefaultVideoEncoderFactory(),
      decoderFactory: RTCDefaultVideoDecoderFactory(),
    )
  }()

  private let peer: RTCPeerConnection
  private var audioTrack: RTCAudioTrack?
  private var capturer: RTCCameraVideoCapturer?
  private var channel: RTCDataChannel?
  private var gatheredWaiters: [CheckedContinuation<Void, Never>] = []
  private var closed = false

  /// This phone's camera, while it is on — for the small preview.
  private(set) var localVideo: RTCVideoTrack?
  /// The other side's picture line. Present from the handshake; only shows anything while their camera is on.
  private(set) var remoteVideo: RTCVideoTrack?
  private(set) var frontCamera = false

  var onConnected: (() -> Void)?
  var onFailed: (() -> Void)?
  var onRemoteCamera: ((Bool) -> Void)?
  var onRemoteVideo: ((RTCVideoTrack) -> Void)?

  init?(iceServers: [IceServer]) {
    let config = RTCConfiguration()
    config.iceServers = iceServers.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
    config.sdpSemantics = .unifiedPlan
    config.continualGatheringPolicy = .gatherOnce
    config.bundlePolicy = .maxBundle
    config.rtcpMuxPolicy = .require
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    // The delegate is set below, once `self` exists; nothing happens on a
    // connection before an offer or an answer is made on it.
    guard let peer = Self.factory.peerConnection(with: config, constraints: constraints, delegate: nil) else { return nil }
    self.peer = peer
    super.init()
    peer.delegate = self
  }

  // MARK: the handshake

  /// The caller's half: voice, an empty video line, the side channel.
  func offer() async throws -> String {
    addMicrophone()
    let video = RTCRtpTransceiverInit()
    video.direction = .sendRecv
    peer.addTransceiver(of: .video, init: video)
    let channel = peer.dataChannel(forLabel: "basu", configuration: RTCDataChannelConfiguration())
    channel?.delegate = self
    self.channel = channel
    let sdp = try await describe(offer: true)
    try await setLocal(type: .offer, sdp: sdp)
    await gathered()
    guard let local = peer.localDescription?.sdp else { throw CallEngineError.noDescription }
    return local
  }

  /// The person rung's half, made from the caller's offer.
  func answer(to offer: String) async throws -> String {
    try await setRemote(type: .offer, sdp: offer)
    addMicrophone()
    // Ready to send a picture from the start, so the camera needs no second handshake.
    for transceiver in peer.transceivers where transceiver.mediaType == .video {
      var error: NSError?
      transceiver.setDirection(.sendRecv, error: &error)
    }
    let sdp = try await describe(offer: false)
    try await setLocal(type: .answer, sdp: sdp)
    await gathered()
    guard let local = peer.localDescription?.sdp else { throw CallEngineError.noDescription }
    return local
  }

  /// The caller, once the other side has answered.
  func accept(answer: String) async throws {
    try await setRemote(type: .answer, sdp: answer)
  }

  private func addMicrophone() {
    guard audioTrack == nil else { return }
    let constraints = RTCMediaConstraints(
      mandatoryConstraints: nil,
      optionalConstraints: ["googEchoCancellation": "true", "googNoiseSuppression": "true", "googAutoGainControl": "true"],
    )
    let source = Self.factory.audioSource(with: constraints)
    let track = Self.factory.audioTrack(with: source, trackId: "voice")
    peer.add(track, streamIds: ["basu"])
    audioTrack = track
  }

  private func describe(offer: Bool) async throws -> String {
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    let peer = Handed(value: peer)
    return try await withCheckedThrowingContinuation { (done: CheckedContinuation<String, Error>) in
      let finish: @Sendable (RTCSessionDescription?, Error?) -> Void = { description, error in
        if let description { done.resume(returning: description.sdp) } else { done.resume(throwing: error ?? CallEngineError.noDescription) }
      }
      if offer { peer.value.offer(for: constraints, completionHandler: finish) } else { peer.value.answer(for: constraints, completionHandler: finish) }
    }
  }

  private func setLocal(type: RTCSdpType, sdp: String) async throws {
    let peer = Handed(value: peer)
    try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
      peer.value.setLocalDescription(RTCSessionDescription(type: type, sdp: sdp)) { error in
        if let error { done.resume(throwing: error) } else { done.resume() }
      }
    }
  }

  private func setRemote(type: RTCSdpType, sdp: String) async throws {
    let peer = Handed(value: peer)
    try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
      peer.value.setRemoteDescription(RTCSessionDescription(type: type, sdp: sdp)) { error in
        if let error { done.resume(throwing: error) } else { done.resume() }
      }
    }
  }

  /// Until every way of reaching this phone is in the description — or two
  /// and a half seconds, by when the useful ones are.
  private func gathered() async {
    if peer.iceGatheringState == .complete { return }
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      gatheredWaiters.append(done)
      Task { @MainActor [weak self] in
        try? await Task.sleep(for: .milliseconds(2500))
        self?.releaseGathered()
      }
    }
  }

  private func releaseGathered() {
    let waiting = gatheredWaiters
    gatheredWaiters = []
    waiting.forEach { $0.resume() }
  }

  // MARK: during the call

  func setMuted(_ muted: Bool) {
    audioTrack?.isEnabled = !muted
  }

  private var videoSender: RTCRtpSender? {
    peer.transceivers.first { $0.mediaType == .video }?.sender
  }

  /// The back camera first: what is shown is the animal, not the face.
  @discardableResult
  func startCamera(front: Bool = false) -> RTCVideoTrack? {
    stopCapturing()
    let source = Self.factory.videoSource()
    let capturer = RTCCameraVideoCapturer(delegate: source)
    let devices = RTCCameraVideoCapturer.captureDevices()
    guard let device = devices.first(where: { $0.position == (front ? .front : .back) }) ?? devices.first,
          let format = Self.format(for: device)
    else { return nil }
    let fps = min(30, Int(format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 30))
    capturer.startCapture(with: device, format: format, fps: fps)
    let track = Self.factory.videoTrack(with: source, trackId: "camera")
    videoSender?.track = track
    self.capturer = capturer
    localVideo = track
    frontCamera = device.position == .front
    tell(["camera": true])
    return track
  }

  func flipCamera() -> RTCVideoTrack? {
    guard localVideo != nil else { return nil }
    return startCamera(front: !frontCamera)
  }

  func stopCamera() {
    stopCapturing()
    videoSender?.track = nil
    localVideo = nil
    tell(["camera": false])
  }

  private func stopCapturing() {
    capturer?.stopCapture()
    capturer = nil
  }

  /// The largest format no bigger than 1280×720: enough to see the meat, light enough for a mobile network.
  private static func format(for device: AVCaptureDevice) -> AVCaptureDevice.Format? {
    let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
    let fitting = formats.filter {
      let d = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
      return d.width <= 1280 && d.height <= 720
    }
    return (fitting.isEmpty ? formats : fitting).max { a, b in
      let x = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
      let y = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
      return Int(x.width) * Int(x.height) < Int(y.width) * Int(y.height)
    }
  }

  private func tell(_ message: [String: Bool]) {
    guard let channel, channel.readyState == .open,
          let data = try? JSONSerialization.data(withJSONObject: message)
    else { return }
    channel.sendData(RTCDataBuffer(data: data, isBinary: false))
  }

  func close() {
    guard !closed else { return }
    closed = true
    stopCapturing()
    channel?.close()
    peer.close()
    releaseGathered()
  }

  // MARK: from WebRTC's threads

  fileprivate func connectionChanged(_ state: RTCPeerConnectionState) {
    guard !closed else { return }
    switch state {
    case .connected: onConnected?()
    case .failed: onFailed?()
    default: break
    }
  }

  fileprivate func gatheringChanged(_ state: RTCIceGatheringState) {
    if state == .complete { releaseGathered() }
  }

  fileprivate func received(track: RTCMediaStreamTrack) {
    guard let video = track as? RTCVideoTrack else { return }
    remoteVideo = video
    onRemoteVideo?(video)
  }

  fileprivate func received(message: Data) {
    guard let said = try? JSONSerialization.jsonObject(with: message) as? [String: Any],
          let camera = said["camera"] as? Bool
    else { return }
    onRemoteCamera?(camera)
  }

  fileprivate func adopt(_ channel: RTCDataChannel) {
    channel.delegate = self
    self.channel = channel
  }
}

enum CallEngineError: Error {
  case noDescription
}

extension CallEngine: RTCPeerConnectionDelegate {
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
    Task { @MainActor in self.gatheringChanged(newState) }
  }

  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
    Task { @MainActor in self.connectionChanged(newState) }
  }

  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
    let track = Handed(value: transceiver.receiver.track)
    Task { @MainActor in
      if let track = track.value { self.received(track: track) }
    }
  }

  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
    let channel = Handed(value: dataChannel)
    Task { @MainActor in self.adopt(channel.value) }
  }
}

extension CallEngine: RTCDataChannelDelegate {
  nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

  nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    let data = buffer.data
    Task { @MainActor in self.received(message: data) }
  }
}
