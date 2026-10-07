import SwiftUI
@preconcurrency import WebRTC

/**
 The call, over everything — the same screen the website draws (call.js):
 the order it is about in gold, the other side's name, how it is going, and
 round buttons along the bottom. Hanging up is the crimson one. The other
 side's camera, when it is on, fills the screen behind the words; this
 phone's own is a small window in the corner.

 CallKit draws the incoming ring; this is everything after it, and the whole
 of a call this phone made.
 */
struct CallScreen: View {
  @State private var center = CallCenter.shared

  var body: some View {
    ZStack {
      RadialGradient(colors: [Color.surface2, Color.sunk], center: .top, startRadius: 0, endRadius: 700)
        .ignoresSafeArea()

      if let live = center.live, live.remoteCamera, let track = center.engine?.remoteVideo {
        VideoTrackView(track: track, fill: true)
          .ignoresSafeArea()
          .overlay {
            LinearGradient(
              stops: [
                .init(color: Color.sunk.opacity(0.6), location: 0),
                .init(color: .clear, location: 0.28),
                .init(color: .clear, location: 0.62),
                .init(color: Color.sunk.opacity(0.8), location: 1),
              ],
              startPoint: .top,
              endPoint: .bottom,
            )
            .ignoresSafeArea()
            .allowsHitTesting(false)
          }
          .accessibilityLabel("Нөгөө талын камер")
      }

      VStack(spacing: 0) {
        head
          .padding(.top, 56)
        Spacer(minLength: 0)
        if let live = center.live, live.cameraOn, let track = center.engine?.localVideo {
          HStack {
            Spacer()
            VideoTrackView(track: track, fill: true, mirrored: center.engine?.frontCamera ?? false)
              .frame(width: 96, height: 128)
              .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
              .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.goldLine, lineWidth: 1))
              .accessibilityLabel("Таны камер")
          }
          .padding(.trailing, 16)
          .padding(.bottom, 20)
        }
        buttons
          .padding(.bottom, 36)
      }
      .padding(.horizontal, 24)
    }
    .preferredColorScheme(.dark)
    .accessibilityIdentifier("call.screen")
  }

  private var head: some View {
    VStack(spacing: 10) {
      if let about = center.live?.about, !about.isEmpty {
        Text(about.uppercased())
          .font(.sans(12, .bold))
          .tracking(1.4)
          .foregroundStyle(Color.gold)
      }
      Text(center.live?.peerName ?? "")
        .font(.display(36))
        .foregroundStyle(Color.ink)
        .multilineTextAlignment(.center)
        .lineLimit(2)
        .minimumScaleFactor(0.7)
        .accessibilityAddTraits(.isHeader)
      TimelineView(.periodic(from: .now, by: 1)) { context in
        Text(status(at: context.date))
          .font(.sans(16, .semibold))
          .monospacedDigit()
          .foregroundStyle(Color.ink2)
          .multilineTextAlignment(.center)
      }
      .accessibilityAddTraits(.updatesFrequently)
    }
    .shadow(color: (center.live?.remoteCamera ?? false) ? .black.opacity(0.7) : .clear, radius: 12)
  }

  private func status(at now: Date) -> String {
    guard let live = center.live else { return "" }
    switch live.phase {
    case .ringingOut: return live.callId == nil ? "Залгаж байна…" : "Дуугарч байна…"
    case .ringingIn: return "Танд залгаж байна…"
    case .connecting: return "Холбогдож байна…"
    case let .ended(words): return words
    case .talking:
      let seconds = max(0, Int(now.timeIntervalSince(live.startedAt ?? now)))
      return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
  }

  @ViewBuilder
  private var buttons: some View {
    if let live = center.live {
      if case .ended = live.phase {
        Color.clear.frame(height: 92)
      } else {
        HStack(alignment: .top, spacing: 18) {
          RoundButton(symbol: live.muted ? "mic.slash.fill" : "mic.fill", label: live.muted ? "Дуу нээх" : "Дуу хаах", on: live.muted) {
            center.toggleMute()
          }
          RoundButton(symbol: live.cameraOn ? "video.slash.fill" : "video.fill", label: live.cameraOn ? "Камер унтраах" : "Камер", on: live.cameraOn) {
            center.toggleCamera()
          }
          if live.cameraOn {
            RoundButton(symbol: "arrow.triangle.2.circlepath.camera.fill", label: "Эргүүлэх", on: false) {
              center.flipCamera()
            }
          } else {
            RoundButton(symbol: "speaker.wave.2.fill", label: "Чанга", on: live.speaker) {
              center.toggleSpeaker()
            }
          }
          RoundButton(symbol: "phone.down.fill", label: "Таслах", on: false, danger: true) {
            center.hangUp()
          }
          .accessibilityIdentifier("call.end")
        }
      }
    }
  }
}

/// One of the round buttons: off-white when on, crimson for hanging up.
private struct RoundButton: View {
  let symbol: String
  let label: String
  let on: Bool
  var danger = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 8) {
        Image(systemName: symbol)
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(danger ? Color.onAccent : on ? Color.onLight : Color.ink)
          .frame(width: 64, height: 64)
          .background(danger ? Color.accent : on ? Color.ink : Color.surface3, in: Circle())
          .shadow(color: danger ? Color.accent.opacity(0.55) : .clear, radius: 14, y: 8)
        Text(label)
          .font(.sans(12, .semibold))
          .foregroundStyle(Color.ink2)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
      }
      .frame(width: 72)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityAddTraits(on ? .isSelected : [])
  }
}

/// A WebRTC video track, drawn with Metal.
private struct VideoTrackView: UIViewRepresentable {
  let track: RTCVideoTrack
  var fill = true
  var mirrored = false

  func makeUIView(context: Context) -> RTCMTLVideoView {
    let view = RTCMTLVideoView(frame: .zero)
    view.videoContentMode = fill ? .scaleAspectFill : .scaleAspectFit
    view.clipsToBounds = true
    track.add(view)
    context.coordinator.track = track
    return view
  }

  func updateUIView(_ view: RTCMTLVideoView, context: Context) {
    view.transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
    if context.coordinator.track !== track {
      context.coordinator.track?.remove(view)
      track.add(view)
      context.coordinator.track = track
    }
  }

  static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
    coordinator.track?.remove(view)
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator {
    var track: RTCVideoTrack?
  }
}
