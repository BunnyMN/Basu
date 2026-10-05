import BasuKit
import SwiftUI
import UserNotifications

/**
 The APNs token, and the one place it is turned into something the server knows.

 Two moments, kept apart on purpose.

 - **A phone that has already said yes registers again** — at launch, and the
   moment somebody signs in. Tokens change — a restore, a new phone, an update
   — and a phone that only registered when its owner opened the inbox could go
   weeks without telling the server where its order updates go.
 - **The question is put when there is something to be told about, not on a
   screen.** Asking on the first screen of an app nobody has used yet is how an
   app gets told no for good; asked over an empty inbox, in iOS's English, it
   was a question about nothing. So the shell asks right after a guest's first
   order, and as a supplier's counter opens — a new order is the one thing a
   supplier must not miss, and push is how it reaches them. First in the
   shell's own words (`PushAsk`), which lead only to iOS's own sheet: one
   button, no way round it, as Apple's guidance has a screen before the
   system's ask.

 Two flags, because they are two different facts. `offered`: the shell's
 screen has been up this run, and once a run is enough. `asked`: iOS's own
 sheet has been asked for, whose answer stands. The profile's «Зөвшөөрөх»
 checks only the second, so it always does what it says.
 */
@MainActor
@Observable
final class PushRegistrar {
  static let shared = PushRegistrar()

  private(set) var token: String?
  /// iOS's own sheet has been asked for this run.
  private(set) var asked = false
  /// The shell's own screen has been put up this run.
  private(set) var offered = false

  /// Set by the shell, so the token reaches `Platform` whenever APNs answers —
  /// which can be before or after somebody signs in.
  var onToken: ((String) -> Void)?

  /// If iOS already said yes, the token is asked for again.
  func registerIfAllowed() async {
    let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    guard Self.allowed(status) else { return }
    UIApplication.shared.registerForRemoteNotifications()
  }

  /// Whether to put the shell's screen up now: iOS has never asked, and
  /// neither the screen nor iOS's sheet has been up this run.
  func shouldOffer() async -> Bool {
    guard !offered, !asked else { return false }
    let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    return Self.offerDue(status: status)
  }

  /// The rule, on its own so it can be checked without a phone: only a
  /// question iOS has never put. A no is an answer, and a yes needs none.
  nonisolated static func offerDue(status: UNAuthorizationStatus) -> Bool {
    status == .notDetermined
  }

  nonisolated static func allowed(_ status: UNAuthorizationStatus) -> Bool {
    status == .authorized || status == .provisional || status == .ephemeral
  }

  /// The shell's screen is going up.
  func markOffered() {
    offered = true
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
 The shell's own words before iOS's: what the notifications will be about, in
 Mongolian, at the moment there is something to be told about. Its one button
 leads to iOS's sheet, where the yes or the no is given; there is no other way
 out of it, and it cannot be swiped away — Apple's guidance for a screen
 before the system's ask.
 */
struct PushAsk: View {
  /// Who it is for: a guest's order, or a supplier's counter.
  enum Audience { case guest, supplier }

  let audience: Audience
  let proceed: () -> Void

  /// As tall as what it says, measured, so the page it is about stays in view.
  @State private var height: CGFloat = 320

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Image(systemName: "bell.badge")
        .font(.sans(22, .medium))
        .foregroundStyle(Color.ink)
        .frame(width: 52, height: 52)
        .background(Color.surface3, in: RoundedRectangle(cornerRadius: BasuMetric.inner, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 10) {
        Text(audience == .supplier ? "Шинэ захиалгыг утсандаа аваарай" : "Захиалгын явцыг утсандаа аваарай")
          .font(.display(36))
          .foregroundStyle(Color.ink)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
        Text(
          audience == .supplier
            ? "Захиалга орж ирмэгц утсанд тань мэдэгдэнэ."
            : "Бэлэн болох, замд гарахад нь мэдэгдэнэ.",
        )
        .font(.sans(16, .medium))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
        // What happens next, said before it does: the phone's own question.
        Text("Дараа нь утас тань зөвшөөрөл асууна.")
          .font(.sans(13, .medium))
          .foregroundStyle(Color.ink3)
          .fixedSize(horizontal: false, vertical: true)
      }
      PrimaryButton(title: "Үргэлжлүүлэх", enabled: true, busy: false, action: proceed)
        .accessibilityIdentifier("push.continue")
    }
    .padding(.horizontal, BasuMetric.screenPadding)
    .padding(.top, 32)
    .padding(.bottom, 16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .fixedSize(horizontal: false, vertical: true)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
    .frame(maxHeight: .infinity, alignment: .top)
    .presentationDetents([.height(height)])
    .presentationBackground { Color.surface2 }
    .presentationCornerRadius(BasuMetric.tile)
    .interactiveDismissDisabled()
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
