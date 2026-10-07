import AVFoundation
import CallKit
import PushKit
import SwiftUI
@preconcurrency import WebRTC

/// CallKit's and PushKit's objects cross to the main actor in this.
private struct Handed<T>: @unchecked Sendable {
  let value: T
}

/**
 Calls, the phone's way: a ring that wakes a phone in a pocket, the system's
 own incoming-call screen, the call in the status bar and on the lock screen.

 Three parts meet here.

 - **PushKit** wakes the app for a ring — even closed, even locked. iOS
   demands every such push be shown as a call at once (`reportNewIncomingCall`
   before the handler returns), or it ends the app and soon stops waking it;
   the server sends one only for a real ring.
 - **CallKit** is the call as the phone knows it: the incoming screen, the
   green bar, the audio session. Answering, muting and hanging up all go
   through it, from its screen or from ours, so the two never disagree.
 - **The server** carries the handshake and the state (src/api/calls.ts); a
   call is followed there until it is over, whoever ends it.

 Outgoing calls start from the order page (`shell.call` → `ServicePage`).
 Only one call at a time.
 */
@MainActor
@Observable
final class CallCenter: NSObject {
  static let shared = CallCenter()

  enum Role { case caller, callee }

  enum Phase: Equatable {
    case ringingOut
    case ringingIn
    case connecting
    case talking
    case ended(String)
  }

  /// The one call, as the screen draws it.
  struct Live {
    let uuid: UUID
    var callId: String?
    let role: Role
    var peerName: String
    var about: String
    let subject: String
    let subjectId: String
    var phase: Phase
    var startedAt: Date?
    var muted = false
    var cameraOn = false
    var speaker = false
    var remoteCamera = false
    var version = 0
    var offer: String?
  }

  private(set) var live: Live?
  /// The screen, over everything: a call this phone made, or one it answered.
  var presenting: Bool {
    guard let live else { return false }
    return live.role == .caller || live.phase != .ringingIn
  }

  private(set) var engine: CallEngine?

  /// The simulator's CallKit ends every call it is asked to start, a few
  /// milliseconds in. There a call runs without it — the same handshake, the
  /// audio session switched on by hand — so it can be tried from a Mac.
  private static let usesCallKit: Bool = {
    #if targetEnvironment(simulator)
      false
    #else
      true
    #endif
  }()

  private var api = API()
  private var token: @MainActor () -> String? = { nil }
  private var provider: CXProvider?
  private let controller = CXCallController()
  private var registry: PKPushRegistry?
  private var voipToken: String?
  private var registeredFor: String?
  private var following: Task<Void, Never>?
  /// The answer the person rung tapped before the offer had arrived.
  private var pendingAnswer: Handed<CXAnswerCallAction>?

  // MARK: setting up

  /// At launch: a ring may be what launched the app, and PushKit must be
  /// listening before it is handed over.
  func start(api: API, token: @escaping @MainActor () -> String?) {
    guard provider == nil else { return }
    self.api = api
    self.token = token

    let config = CXProviderConfiguration()
    config.supportsVideo = true
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    // A call about an order is not one to return from the phone's own list:
    // it has no number, and the order may be long over.
    config.includesCallsInRecents = false
    let provider = CXProvider(configuration: config)
    provider.setDelegate(self, queue: nil)
    self.provider = provider

    let audio = RTCAudioSession.sharedInstance()
    audio.useManualAudio = true
    audio.isAudioEnabled = false

    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    self.registry = registry
  }

  /// Signed in, or the token changed: this phone rings for this person.
  func signedIn() {
    guard let voipToken, let session = token(), registeredFor != session else { return }
    registeredFor = session
    let api = api
    Task { try? await api.registerRingToken(voipToken, token: session) }
  }

  /// Signing out: the phone rings for them no more.
  func signedOut(token session: String?) {
    registeredFor = nil
    if let live, let provider {
      provider.reportCall(with: live.uuid, endedAt: nil, reason: .failed)
      teardown(words: "")
    }
    guard let voipToken, let session else { return }
    let api = api
    Task { try? await api.revokeRingToken(voipToken, token: session) }
  }

  // MARK: ringing out

  /// From the order page: ring the other side of this order.
  func ringOut(subject: String, subjectId: String, peerName: String) {
    guard live == nil, token() != nil else { return }
    let uuid = UUID()
    live = Live(uuid: uuid, role: .caller, peerName: peerName, about: "", subject: subject, subjectId: subjectId, phase: .ringingOut)
    guard Self.usesCallKit else { return dial(nil) }
    let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: peerName))
    action.isVideo = false
    action.contactIdentifier = peerName
    controller.request(CXTransaction(action: action)) { [weak self] error in
      guard error != nil else { return }
      Task { @MainActor in self?.teardown(words: "Залгаж чадсангүй.") }
    }
  }

  /// CallKit has started the call: now the handshake.
  private func dial(_ action: Handed<CXStartCallAction>?) {
    guard var call = live, call.role == .caller, let session = token() else { return action?.value.fail() ?? () }
    configureAudio()
    action?.value.fulfill()
    if !Self.usesCallKit { activateAudioByHand() }
    let api = api
    Task {
      do {
        guard await AVAudioApplication.requestRecordPermission() else { throw CallFailure.microphone }
        let ice = try await api.iceServers(token: session)
        guard let engine = CallEngine(iceServers: ice) else { throw CallFailure.engine }
        self.attach(engine)
        let offer = try await engine.offer()
        guard self.live?.uuid == call.uuid else { return engine.close() }
        let started = try await api.startCall(subject: call.subject, subjectId: call.subjectId, offer: offer, token: session)
        guard self.live?.uuid == call.uuid else {
          _ = try? await api.endCall(started.id, token: session)
          return
        }
        call.callId = started.id
        call.about = started.about
        call.version = started.version
        self.live?.callId = started.id
        self.live?.about = started.about
        self.live?.version = started.version
        self.provider?.reportOutgoingCall(with: call.uuid, startedConnectingAt: nil)
        self.follow(started.id)
      } catch CallFailure.microphone {
        self.end(words: "Микрофонд хандах зөвшөөрөл алга. Тохиргооноос зөвшөөрнө үү.")
      } catch let error as APIError {
        self.end(words: error.message)
      } catch {
        self.end(words: "Залгаж чадсангүй.")
      }
    }
  }

  // MARK: ringing in

  private func ringIn(_ payload: [AnyHashable: Any], completion: @escaping @Sendable () -> Void) {
    let uuid = UUID()
    let callId = payload["call_id"] as? String
    let caller = payload["caller_name"] as? String ?? "Basu"
    let about = payload["about"] as? String ?? ""
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: about.isEmpty ? caller : about)
    update.localizedCallerName = caller
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false

    // Shown before anything else, always — iOS's rule for a push that woke the app.
    guard let provider else { return completion() }
    let busy = live != nil
    provider.reportNewIncomingCall(with: uuid, update: update) { _ in completion() }
    guard !busy, let callId, token() != nil else {
      // Already on a call, signed out, or a ring with nothing in it: the
      // phone shows it and lets it go at once; somebody else at the
      // supplier can still pick it up.
      provider.reportCall(with: uuid, endedAt: nil, reason: busy ? .unanswered : .failed)
      return
    }
    live = Live(
      uuid: uuid,
      callId: callId,
      role: .callee,
      peerName: caller,
      about: about,
      subject: payload["subject"] as? String ?? "",
      subjectId: payload["subject_id"] as? String ?? "",
      phase: .ringingIn,
    )
    follow(callId)
  }

  private func answer(_ action: Handed<CXAnswerCallAction>) {
    guard let call = live, call.role == .callee else { return action.value.fail() }
    configureAudio()
    guard let offer = call.offer else {
      // The ring came before the offer did: answered the moment it arrives.
      pendingAnswer = action
      live?.phase = .connecting
      return
    }
    live?.phase = .connecting
    guard let session = token(), let callId = call.callId else { return action.value.fail() }
    let api = api
    Task {
      do {
        guard await AVAudioApplication.requestRecordPermission() else { throw CallFailure.microphone }
        let ice = try await api.iceServers(token: session)
        guard let engine = CallEngine(iceServers: ice) else { throw CallFailure.engine }
        self.attach(engine)
        let answer = try await engine.answer(to: offer)
        let answered = try await api.answerCall(callId, answer: answer, token: session)
        self.live?.version = answered.version
        action.value.fulfill()
      } catch let error as APIError {
        action.value.fail()
        self.end(words: error.code == "TAKEN" ? "Өөр хүн дуудлагыг авлаа." : error.message)
      } catch CallFailure.microphone {
        action.value.fail()
        self.end(words: "Микрофонд хандах зөвшөөрөл алга. Тохиргооноос зөвшөөрнө үү.")
      } catch {
        action.value.fail()
        self.end(words: "Холбогдож чадсангүй.")
      }
    }
  }

  // MARK: the call on the server

  /// Follows the call until it is over, whoever ends it.
  private func follow(_ callId: String) {
    following?.cancel()
    following = Task { [weak self] in
      var after = -1
      while !Task.isCancelled {
        guard let self, let session = self.token(), self.live?.callId == callId else { return }
        do {
          let call = try await self.api.call(callId, after: after, wait: 10, token: session)
          after = call.version
          await self.apply(call)
        } catch is CancellationError {
          return
        } catch let error as APIError where error.status == 404 {
          self.end(words: "Дуудлага олдсонгүй.")
          return
        } catch {
          try? await Task.sleep(for: .seconds(2))
        }
      }
    }
  }

  private func apply(_ call: CallInfo) async {
    guard var live, live.callId == call.id else { return }
    live.version = call.version
    if !call.about.isEmpty { live.about = call.about }
    if live.role == .callee, live.offer == nil, let offer = call.offer {
      live.offer = offer
      self.live = live
      if let action = pendingAnswer {
        pendingAnswer = nil
        self.live?.phase = .ringingIn
        answer(action)
      }
    }
    self.live?.version = call.version
    if call.state == "answered" {
      if live.role == .caller, live.phase == .ringingOut, let answer = call.answer {
        self.live?.phase = .connecting
        do {
          try await engine?.accept(answer: answer)
        } catch {
          return end(words: "Холбогдож чадсангүй.")
        }
      } else if live.role == .callee, !call.answeredHere, live.phase == .ringingIn {
        provider?.reportCall(with: live.uuid, endedAt: nil, reason: .answeredElsewhere)
        return teardown(words: "")
      }
    }
    if call.isOver {
      let reason: CXCallEndedReason = switch call.state {
      case "missed": .unanswered
      case "declined", "cancelled": live.role == .caller ? .remoteEnded : .unanswered
      default: .remoteEnded
      }
      provider?.reportCall(with: live.uuid, endedAt: nil, reason: reason)
      teardown(words: Self.words(for: call, role: live.role))
    }
  }

  private static func words(for call: CallInfo, role: Role) -> String {
    switch call.state {
    case "declined": role == .caller ? "Татгалзлаа." : "Дуудлагаас татгалзлаа."
    case "missed": role == .caller ? "Хариу өгсөнгүй." : "Аваагүй дуудлага."
    case "cancelled": role == .caller ? "Дуудлагыг цуцаллаа." : "Залгагч тасаллаа."
    default: call.endReason == "too_long" ? "Дуудлага хэт удсан тул тасаллаа." : "Дуудлага дууслаа."
    }
  }

  // MARK: the engine

  private func attach(_ engine: CallEngine) {
    self.engine?.close()
    self.engine = engine
    engine.onConnected = { [weak self] in
      guard let self, var live = self.live, live.phase != .talking else { return }
      live.phase = .talking
      live.startedAt = .now
      self.live = live
      if live.role == .caller { self.provider?.reportOutgoingCall(with: live.uuid, connectedAt: .now) }
    }
    engine.onFailed = { [weak self] in self?.end(words: "Холболт тасарлаа.") }
    engine.onRemoteCamera = { [weak self] on in self?.live?.remoteCamera = on }
  }

  // MARK: from the screen

  /// Hang up — from our button or CallKit's, it goes through CallKit.
  func hangUp() {
    guard let live else { return }
    if case .ended = live.phase { return teardown(words: "") }
    guard Self.usesCallKit else { return hungUp(live.uuid) }
    controller.request(CXTransaction(action: CXEndCallAction(call: live.uuid))) { [weak self] error in
      guard error != nil else { return }
      Task { @MainActor in self?.end(words: "Дуудлага дууслаа.") }
    }
  }

  func toggleMute() {
    guard let live else { return }
    guard Self.usesCallKit else {
      engine?.setMuted(!live.muted)
      self.live?.muted = !live.muted
      return
    }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: live.uuid, muted: !live.muted))) { _ in }
  }

  func toggleCamera() {
    guard let engine, var live else { return }
    if live.cameraOn {
      engine.stopCamera()
      live.cameraOn = false
    } else {
      guard engine.startCamera() != nil else { return }
      live.cameraOn = true
      // A picture wants the loudspeaker, as FaceTime does.
      if !live.speaker { setSpeaker(true, in: &live) }
    }
    self.live = live
    let update = CXCallUpdate()
    update.hasVideo = live.cameraOn || live.remoteCamera
    provider?.reportCall(with: live.uuid, updated: update)
  }

  func flipCamera() {
    _ = engine?.flipCamera()
  }

  func toggleSpeaker() {
    guard var live else { return }
    setSpeaker(!live.speaker, in: &live)
    self.live = live
  }

  private func setSpeaker(_ on: Bool, in live: inout Live) {
    let audio = RTCAudioSession.sharedInstance()
    audio.lockForConfiguration()
    try? audio.overrideOutputAudioPort(on ? .speaker : .none)
    audio.unlockForConfiguration()
    live.speaker = on
  }

  // MARK: ending

  /// Over, from this side: the server is told, CallKit is told, the screen says why.
  private func end(words: String) {
    guard let live else { return }
    if let callId = live.callId, let session = token() {
      let api = api
      Task { _ = try? await api.endCall(callId, token: session) }
    }
    provider?.reportCall(with: live.uuid, endedAt: nil, reason: .failed)
    teardown(words: words)
  }

  /// Everything let go; the screen keeps the last words a moment.
  private func teardown(words: String) {
    following?.cancel()
    following = nil
    engine?.close()
    engine = nil
    if let pendingAnswer {
      pendingAnswer.value.fail()
      self.pendingAnswer = nil
    }
    guard let uuid = live?.uuid else { return }
    if words.isEmpty {
      live = nil
      return
    }
    live?.phase = .ended(words)
    Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(1600))
      if self?.live?.uuid == uuid { self?.live = nil }
    }
  }

  /// What CallKit's `didActivate` does, done by hand where there is no CallKit.
  private func activateAudioByHand() {
    let audio = RTCAudioSession.sharedInstance()
    audio.lockForConfiguration()
    try? audio.setActive(true)
    audio.unlockForConfiguration()
    audio.isAudioEnabled = true
  }

  /// Hung up from this side, however it was asked: the server is told and everything let go.
  private func hungUp(_ uuid: UUID) {
    guard let live, live.uuid == uuid else { return }
    if let callId = live.callId, let session = token() {
      let api = api
      Task { _ = try? await api.endCall(callId, token: session) }
    }
    teardown(words: live.role == .callee && live.phase == .ringingIn ? "Дуудлагаас татгалзлаа." : "Дуудлага дууслаа.")
  }

  private func configureAudio() {
    let audio = RTCAudioSession.sharedInstance()
    let config = RTCAudioSessionConfiguration.webRTC()
    config.category = AVAudioSession.Category.playAndRecord.rawValue
    config.mode = AVAudioSession.Mode.voiceChat.rawValue
    config.categoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP]
    audio.lockForConfiguration()
    try? audio.setConfiguration(config)
    audio.unlockForConfiguration()
  }

  private enum CallFailure: Error { case microphone, engine }
}

// MARK: - CallKit

extension CallCenter: CXProviderDelegate {
  nonisolated func providerDidReset(_ provider: CXProvider) {
    MainActor.assumeIsolated { self.teardown(words: "") }
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    let action = Handed(value: action)
    MainActor.assumeIsolated { self.dial(action) }
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    let action = Handed(value: action)
    MainActor.assumeIsolated { self.answer(action) }
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let action = Handed(value: action)
    MainActor.assumeIsolated {
      self.hungUp(action.value.callUUID)
      action.value.fulfill()
    }
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    let action = Handed(value: action)
    MainActor.assumeIsolated {
      self.engine?.setMuted(action.value.isMuted)
      self.live?.muted = action.value.isMuted
      action.value.fulfill()
    }
  }

  nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    let session = Handed(value: audioSession)
    MainActor.assumeIsolated {
      let audio = RTCAudioSession.sharedInstance()
      audio.audioSessionDidActivate(session.value)
      audio.isAudioEnabled = true
    }
  }

  nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    let session = Handed(value: audioSession)
    MainActor.assumeIsolated {
      let audio = RTCAudioSession.sharedInstance()
      audio.audioSessionDidDeactivate(session.value)
      audio.isAudioEnabled = false
    }
  }
}

// MARK: - PushKit

extension CallCenter: PKPushRegistryDelegate {
  nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    let hex = credentials.token.map { String(format: "%02x", $0) }.joined()
    MainActor.assumeIsolated {
      self.voipToken = hex
      self.registeredFor = nil
      self.signedIn()
    }
  }

  nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    MainActor.assumeIsolated {
      self.voipToken = nil
      self.registeredFor = nil
    }
  }

  nonisolated func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void,
  ) {
    let payload = Handed(value: payload.dictionaryPayload)
    let completion = Handed(value: completion)
    MainActor.assumeIsolated { self.ringIn(payload.value) { completion.value() } }
  }
}
