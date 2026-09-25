import BasuKit
import LocalAuthentication
import SwiftUI

/**
 Face ID over the shell: the wallet and the orders stay behind the phone's
 owner, even when the phone is handed to somebody else unlocked.

 Off until somebody turns it on, and turned on only by passing it once — a
 switch that could lock its owner out without their face or code having
 worked even one time is a trap. The phone's own passcode is always the way
 past a face that will not match; Basu keeps no second secret.

 Leaving for a moment does not lock: paying through a bank's app, or reading
 a code in the mail, and coming straight back is one errand. A minute away
 is a departure. While the app is away the shell is curtained either way, so
 the app switcher never shows a balance.
 */
@MainActor
@Observable
final class AppLock {
  static let key = "lock.enabled"
  /// How long the app may be away before coming back asks for a face.
  static let grace: TimeInterval = 60

  private(set) var enabled: Bool
  /// Asks for the face or the code before the shell shows.
  private(set) var locked: Bool
  /// Away from the screen: the shell is covered, whatever happens next.
  private(set) var curtained = false

  private var leftAt: Date?
  private let defaults: UserDefaults
  private let check: (String) async -> Bool
  private let available: () -> Kind

  init(
    defaults: UserDefaults = .standard,
    check: @escaping (String) async -> Bool = AppLock.deviceOwner,
    available: @escaping () -> Kind = { AppLock.kind },
  ) {
    self.defaults = defaults
    self.check = check
    self.available = available
    enabled = defaults.bool(forKey: Self.key)
    locked = defaults.bool(forKey: Self.key)
  }

  /// What this phone checks with: the switch's words and the button's.
  var kind: Kind { available() }

  // MARK: coming and going

  func left(at now: Date) {
    guard enabled else { return }
    curtained = true
    if leftAt == nil { leftAt = now }
  }

  func returned(at now: Date) {
    defer { leftAt = nil }
    guard enabled else {
      curtained = false
      return
    }
    if let leftAt, now.timeIntervalSince(leftAt) > Self.grace { locked = true }
    curtained = locked
  }

  // MARK: the face

  /// Signing in is proof enough: a lock left over from launch does not ask
  /// again of somebody who has just typed a password or passed Apple's check.
  func admitted() {
    locked = false
    curtained = false
  }

  /// One try. A cancelled or failed one leaves the lock where it was.
  func unlock() async {
    guard locked else { return }
    // A phone that has since lost its passcode has nothing to check against,
    // and a lock nobody can open is worse than none.
    guard available() != .none else {
      locked = false
      curtained = false
      return
    }
    if await check("Basu-г нээх") {
      locked = false
      curtained = false
    }
  }

  /// On only once the face or code has worked here; off at a touch.
  func turn(on: Bool) async {
    if on {
      let kind = available()
      guard kind != .none, await check("Basu-г \(kind.by) түгжих") else { return }
    }
    enabled = on
    locked = false
    curtained = false
    defaults.set(on, forKey: Self.key)
  }

  // MARK: what the phone has

  enum Kind: Equatable {
    case faceID, touchID, opticID, passcode, none

    var title: String {
      switch self {
      case .faceID: "Face ID"
      case .touchID: "Touch ID"
      case .opticID: "Optic ID"
      case .passcode, .none: "Нууц код"
      }
    }

    /// «…-ээр»: by it, as a sentence says it.
    var by: String {
      switch self {
      case .faceID: "Face ID-ээр"
      case .touchID: "Touch ID-ээр"
      case .opticID: "Optic ID-ээр"
      case .passcode, .none: "нууц кодоор"
      }
    }

    var symbol: String {
      switch self {
      case .faceID: "faceid"
      case .touchID: "touchid"
      case .opticID: "opticid"
      case .passcode, .none: "lock"
      }
    }
  }

  nonisolated static var kind: Kind {
    let context = LAContext()
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return .none }
    switch context.biometryType {
    case .faceID: return .faceID
    case .touchID: return .touchID
    case .opticID: return .opticID
    default: return .passcode
    }
  }

  /// Face, finger or eye, and the phone's passcode when those do not match.
  nonisolated static func deviceOwner(_ reason: String) async -> Bool {
    (try? await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
  }
}

/**
 What stands over the shell while it is locked or away: the splash's wordmark
 and, locked, the one button. It asks once by itself on arrival — asking again
 on its own after a cancel would bring the sheet straight back over a person
 who has just said no.
 */
struct LockView: View {
  @Environment(AppLock.self) private var lock
  @Environment(\.scenePhase) private var phase
  @State private var asked = false

  var body: some View {
    ZStack {
      LinearGradient.ground.ignoresSafeArea()
      VStack(spacing: 14) {
        Text("Basu")
          .font(.sans(44, .semibold))
          .tracking(-0.03 * 44)
          .foregroundStyle(Color.ink)
        RoundedRectangle(cornerRadius: 1, style: .continuous)
          .fill(Color.accent)
          .frame(width: 34, height: 2)
      }
      if lock.locked {
        VStack {
          Spacer()
          Button {
            Task { await lock.unlock() }
          } label: {
            Label("\(lock.kind.by) нээх", systemImage: lock.kind.symbol)
              .font(.sans(16, .medium))
              .foregroundStyle(Color.accent)
              .frame(minHeight: BasuMetric.minTarget)
              .padding(.horizontal, 20)
              .glassCard(radius: 22)
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("lock.open")
          .padding(.bottom, 60)
        }
      }
    }
    .accessibilityIdentifier("lock")
    .onChange(of: phase, initial: true) { _, now in
      guard now == .active, lock.locked, !asked else { return }
      asked = true
      Task { await lock.unlock() }
    }
  }
}
