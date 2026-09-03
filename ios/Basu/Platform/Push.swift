import SwiftUI
import UserNotifications

/**
 The APNs token, and the one place it is turned into something the server knows.

 Registration is deliberately not at launch. Asking for notification permission
 on the first screen of an app nobody has used yet is how an app gets told no
 permanently — the ask happens when the guest opens the thing notifications are
 about, which is the inbox.
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
    guard await centre.notificationSettings().authorizationStatus == .authorized else { return }
    UIApplication.shared.registerForRemoteNotifications()
  }

  func accept(_ data: Data) {
    let hex = data.map { String(format: "%02x", $0) }.joined()
    token = hex
    onToken?(hex)
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
    // Nothing to tell the guest: the messages that matter also go by SMS, and
    // an alert about a push certificate is a developer's problem on a
    // stranger's screen.
    NSLog("push registration failed: \(error.localizedDescription)")
  }
}
