import Foundation
import Testing

@testable import Basu

/**
 The app lock, without a face.

 What matters is when it asks and that it cannot be switched on by a check
 that failed — a lock its owner has never opened is a way to lose the app.
 The check itself is the phone's; here it is a closure that says yes or no.
 */
@MainActor
struct AppLockTests {
  private func lock(enabled: Bool = false, passes: Bool = true, kind: AppLock.Kind = .faceID) -> AppLock {
    let defaults = UserDefaults(suiteName: "AppLockTests.\(UUID().uuidString)")!
    defaults.set(enabled, forKey: AppLock.key)
    return AppLock(defaults: defaults, check: { _ in passes }, available: { kind })
  }

  private let noon = Date(timeIntervalSince1970: 1_790_000_000)

  @Test func switchedOnItAsksAtLaunch() {
    let lock = lock(enabled: true)
    #expect(lock.locked)
  }

  @Test func aMinuteAwayIsAnErrandNotADeparture() {
    let lock = lock(enabled: true)
    lock.admitted()
    lock.left(at: noon)
    #expect(lock.curtained, "away, the app switcher sees the wordmark")
    lock.returned(at: noon.addingTimeInterval(AppLock.grace - 1))
    #expect(!lock.locked)
    #expect(!lock.curtained)
  }

  @Test func longerAwayAsksAgain() async {
    let lock = lock(enabled: true)
    lock.admitted()
    lock.left(at: noon)
    lock.returned(at: noon.addingTimeInterval(AppLock.grace + 1))
    #expect(lock.locked)
    #expect(lock.curtained)
    await lock.unlock()
    #expect(!lock.locked)
    #expect(!lock.curtained)
  }

  @Test func aFailedCheckLeavesItLocked() async {
    let lock = lock(enabled: true, passes: false)
    await lock.unlock()
    #expect(lock.locked)
  }

  @Test func itIsSwitchedOnOnlyByACheckThatPassed() async {
    let refused = lock(passes: false)
    await refused.turn(on: true)
    #expect(!refused.enabled)

    let passed = lock(passes: true)
    await passed.turn(on: true)
    #expect(passed.enabled)
    #expect(!passed.locked, "switching it on does not lock the person who just did")
  }

  @Test func aPhoneWithNoPasscodeCannotLockAnybodyOut() async {
    let bare = lock(enabled: true, passes: false, kind: .none)
    await bare.unlock()
    #expect(!bare.locked)

    let off = lock(passes: true, kind: .none)
    await off.turn(on: true)
    #expect(!off.enabled)
  }

  @Test func offItNeitherLocksNorCurtains() {
    let lock = lock(enabled: false)
    lock.left(at: noon)
    #expect(!lock.curtained)
    lock.returned(at: noon.addingTimeInterval(3600))
    #expect(!lock.locked)
  }
}
