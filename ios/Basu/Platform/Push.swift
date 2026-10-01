import BasuKit
import SwiftUI
import UserNotifications

/**
 The APNs token, and the one place it is turned into something the server knows.

 Two moments, kept apart on purpose.

 - **At launch, a phone that has already said yes registers again.** Tokens
   change — a restore, a new phone, an update — and a phone that only
   registered when its owner opened the inbox could go weeks without telling
   the server where its order updates go.
 - **The question is put after the first order, not on a screen.** Asking on
   the first screen of an app nobody has used yet is how an app gets told no
   for good; asked over an empty inbox, in iOS's English, it was a question
   about nothing. Right after paying, the thing the notifications are about is
   on the screen — so the shell asks then, first in its own words (`PushAsk`),
   and only a yes there brings up iOS's one-time sheet. «Дараа» is an answer
   too: the next order may ask again, but not within a week.
 */
@MainActor
@Observable
final class PushRegistrar {
  static let shared = PushRegistrar()

  private(set) var token: String?
  private(set) var asked = false

  /// Set by the shell, so the token reaches `Platform` whenever APNs answers —
  /// which can be before or after somebody signs in.
  var onToken: ((String) -> Void)?

  private let laterKey = "push.laterAt"
  /// How long «Дараа» holds.
  nonisolated static let quiet: TimeInterval = 7 * 24 * 60 * 60

  /// At launch: if iOS already said yes, the token is asked for again.
  func registerIfAllowed() async {
    let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    guard Self.allowed(status) else { return }
    UIApplication.shared.registerForRemoteNotifications()
  }

  /// Whether to put the question now: iOS has never asked, this run has not
  /// asked, and «Дараа» was not said in the last week.
  func shouldOffer(now: Date = .now) async -> Bool {
    guard !asked else { return false }
    let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    let later = UserDefaults.standard.object(forKey: laterKey) as? Date
    return Self.offerDue(status: status, laterAt: later, now: now)
  }

  /// The rule, on its own so it can be checked without a phone.
  nonisolated static func offerDue(status: UNAuthorizationStatus, laterAt: Date?, now: Date) -> Bool {
    guard status == .notDetermined else { return false }
    guard let laterAt else { return true }
    return now.timeIntervalSince(laterAt) >= quiet
  }

  nonisolated static func allowed(_ status: UNAuthorizationStatus) -> Bool {
    status == .authorized || status == .provisional || status == .ephemeral
  }

  /// «Дараа»: not this run, and not this week.
  func later(now: Date = .now) {
    asked = true
    UserDefaults.standard.set(now, forKey: laterKey)
  }

  /// Ask once. A refusal is an answer: iOS will not show the sheet again, and
  /// pestering through a second code path only annoys the same person twice.
  func askIfNeeded() async {
    guard !asked else { return }
    asked = true
    let centre = UNUserNotificationCenter.current()
    let settings = await centre.notificationSettings()
    if settings.authorizationStatus == .notDetermined {
      _ = try? await centre.requestAuthorization(options: [.alert, .badge, .sound])
    }
    guard Self.allowed(await centre.notificationSettings().authorizationStatus) else { return }
    UIApplication.shared.registerForRemoteNotifications()
  }

  func accept(_ data: Data) {
    let hex = data.map { String(format: "%02x", $0) }.joined()
    token = hex
    onToken?(hex)
  }
}

/**
 The shell's own question, before iOS's: what the notifications will be
 about, in Mongolian, at the moment there is something to be told about.
 A yes opens iOS's sheet; «Дараа» closes this and nothing else happens.
 */
struct PushAsk: View {
  let allow: () -> Void
  let later: () -> Void

  /// As tall as what it says, measured, so the page it is about stays in view.
  @State private var height: CGFloat = 360

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Image(systemName: "bell.badge")
        .font(.sans(22, .medium))
        .foregroundStyle(Color.accent)
        .frame(width: 48, height: 48)
        .background(Color.accentSoft, in: RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 6) {
        Text("Захиалгын явцыг утсандаа авах уу?")
          .font(.sans(20, .semibold))
          .foregroundStyle(Color.ink)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
        Text("Бэлэн болох, замд гарах үед нь шууд мэдэгдэнэ. Профайл дээрээс хэзээ ч өөрчилж болно.")
          .font(.sans(14))
          .foregroundStyle(Color.ink2)
          .fixedSize(horizontal: false, vertical: true)
      }
      VStack(spacing: 4) {
        PrimaryButton(title: "Зөвшөөрөх", enabled: true, busy: false, action: allow)
          .accessibilityIdentifier("push.allow")
        Button(action: later) {
          Text("Дараа")
            .font(.sans(15, .medium))
            .foregroundStyle(Color.ink2)
            .frame(maxWidth: .infinity, minHeight: BasuMetric.minTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("push.later")
      }
    }
    .padding(.horizontal, BasuMetric.screenPadding)
    .padding(.top, 28)
    .padding(.bottom, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .fixedSize(horizontal: false, vertical: true)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
    .frame(maxHeight: .infinity, alignment: .top)
    .presentationDetents([.height(height)])
    .presentationBackground { LinearGradient.ground }
  }
}

/// The three UIKit callbacks SwiftUI has no equivalent for.
@MainActor
final class PushAppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data,
  ) {
    PushRegistrar.shared.accept(deviceToken)
  }

  nonisolated func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error,
  ) {
    // Nothing to tell the guest: every message is kept in the inbox whether
    // or not it reached the lock screen, and an alert about a push
    // certificate is a developer's problem on a stranger's screen.
    NSLog("push registration failed: \(error.localizedDescription)")
  }
}
