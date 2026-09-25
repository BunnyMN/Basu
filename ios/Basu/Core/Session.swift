import Foundation
import Security
import UIKit

/**
 Who is signed in, and the token that proves it.

 The token goes in the keychain rather than in `UserDefaults`: it is a bearer
 credential for somebody's lunch money, and defaults are a plist that any
 backup or file dump carries away in the clear.
 */
@MainActor
@Observable
final class Session {
  private(set) var token: String?
  /// What the person signed in with, when the sheet knows it: the number,
  /// or the address. Google and Apple say it only to the server, so after
  /// those both are nil and the profile's `Me` has it instead.
  private(set) var phone: String?
  private(set) var email: String?

  private let api: API
  private let store: Keychain

  init(api: API = API(), store: Keychain = Keychain(service: "mn.basu.app")) {
    self.api = api
    self.store = store
    token = store.read("guest.token")
    phone = store.read("guest.phone")
    email = store.read("guest.email")
  }

  var isSignedIn: Bool { token != nil }

  /// Which ways in the server has open, for the sheet to draw.
  func methods() async -> AuthMethods { await api.authMethods() }

  /// Where the system's sign-in sheet goes for Google.
  var googleStart: URL { api.googleStart }

  // MARK: without a phone

  /// A code to the address. It goes to the inbox, never back here.
  func requestCode(email: String) async throws {
    try await api.emailStart(email: Self.address(email))
  }

  /// The code from the letter. An address nobody has used becomes an account.
  func signIn(email: String, code: String) async throws {
    let address = Self.address(email)
    let token = try await api.emailVerify(email: address, code: code, device: Self.deviceName)
    keep(token: token, phone: nil, email: address)
  }

  /// The session Google's round trip ended with, taken from the fragment.
  func signedInWithGoogle(token: String) {
    keep(token: token, phone: nil, email: nil)
  }

  /// Apple's identity token, and the nonce whose hash Apple put in it.
  func signIn(appleToken: String, nonce: String, name: String?) async throws {
    let token = try await api.apple(identityToken: appleToken, nonce: nonce, name: name, device: Self.deviceName)
    keep(token: token, phone: nil, email: nil)
  }

  /// An address the one way the server stores it.
  nonisolated static func address(_ typed: String) -> String {
    typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  // MARK: with a password

  /// An address or a number, and the password it already has.
  func signIn(login typed: String, password: String) async throws {
    let login = Self.login(typed)
    let token = try await api.signIn(login: login, password: password, device: Self.deviceName)
    keep(token: token, login: login)
  }

  /// A code for choosing a password, to the inbox the login names. Returns
  /// where it went, which is all the sheet may show of an address it was
  /// not typed.
  func requestPasswordCode(login typed: String, purpose: PasswordPurpose) async throws -> String {
    try await api.passwordCode(login: Self.login(typed), purpose: purpose)
  }

  /**
   The code from the letter and the password it is for, and signed in —
   to a new account when the address had none, or to the one it had.
   Returns whether an account was made: somebody who meant to sign up and
   landed in an account they already had should hear so.
   */
  @discardableResult
  func setPassword(login typed: String, code: String, password: String, name: String? = nil) async throws -> Bool {
    let login = Self.login(typed)
    let answer = try await api.setPassword(
      login: login, code: code, password: password, name: name, device: Self.deviceName,
    )
    keep(token: answer.token, login: login)
    return answer.created
  }

  /// What somebody typed to name their account, the one way the server
  /// stores it: an address when it has an @ in it, a number otherwise.
  nonisolated static func login(_ typed: String) -> String {
    typed.contains("@") ? address(typed) : PhoneNumber.e164(typed)
  }

  /// Enough of a login to be worth sending: an address, or a whole number.
  /// An address is not checked further here — the server says what is wrong
  /// with one, in Mongolian, as it does for the email door.
  nonisolated static func looksLikeLogin(_ typed: String) -> Bool {
    typed.contains("@") || PhoneNumber.looksComplete(typed)
  }

  // MARK: with a phone

  /// A new account, for a number nobody has used.
  func register(phone: String, password: String) async throws {
    let number = PhoneNumber.e164(phone)
    let token = try await api.register(phone: number, password: password, device: Self.deviceName)
    keep(token: token, phone: number, email: nil)
  }

  /// What this phone calls itself — «Батаагийн iPhone». It goes to identity so
  /// somebody looking at their sessions can tell which row to revoke.
  @MainActor static var deviceName: String { UIDevice.current.name }

  #if DEBUG
    /// A developer's own server lets a walkthrough straight in. Debug builds
    /// pointed away from the pilot only — the real server has no such door,
    /// and a release build has no such button.
    func demoSignIn(phone: String = "+97699001122") async throws {
      let token = try await api.demoLogin(phone: phone, device: Self.deviceName)
      keep(token: token, phone: phone, email: nil)
    }
  #endif

  /// A stored token outlives the thing it points at — sessions expire, get
  /// revoked, or vanish with the database they were made in. A 401 means this
  /// one is dead, not that the guest did anything wrong.
  func forget() {
    token = nil
    store.delete("guest.token")
  }

  func signOut() {
    forget()
    phone = nil
    email = nil
    store.delete("guest.phone")
    store.delete("guest.email")
  }

  /// A login is one or the other, and the profile says whichever it was.
  private func keep(token: String, login: String) {
    let byEmail = login.contains("@")
    keep(token: token, phone: byEmail ? nil : login, email: byEmail ? login : nil)
  }

  private func keep(token: String, phone: String?, email: String?) {
    self.token = token
    self.phone = phone
    self.email = email
    store.write(token, for: "guest.token")
    for (key, value) in [("guest.phone", phone), ("guest.email", email)] {
      if let value { store.write(value, for: key) } else { store.delete(key) }
    }
  }
}

/// The smallest keychain that does the job. No caching: reads happen when a
/// screen appears, not in a loop.
struct Keychain: Sendable {
  let service: String

  func read(_ key: String) -> String? {
    var query = base(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func write(_ value: String, for key: String) {
    let query = base(key)
    SecItemDelete(query as CFDictionary)
    var insert = query
    insert[kSecValueData as String] = Data(value.utf8)
    insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(insert as CFDictionary, nil)
  }

  func delete(_ key: String) {
    SecItemDelete(base(key) as CFDictionary)
  }

  private func base(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }
}

/// A Mongolian number the way people type it — «8811 2233», «976…»,
/// «+976 8811-2233» — in the one form the server stores. The server does the
/// same; doing it here too means the number the profile shows is that one.
enum PhoneNumber {
  static func e164(_ typed: String) -> String {
    let kept = typed.filter { !" -().".contains($0) }
    let digits = kept.hasPrefix("+") ? String(kept.dropFirst()) : kept
    guard digits.allSatisfy(\.isASCII), digits.allSatisfy(\.isNumber) else { return kept }
    if digits.count == 8 { return "+976" + digits }
    if digits.count == 11, digits.hasPrefix("976") { return "+" + digits }
    if digits.count == 13, digits.hasPrefix("00976") { return "+" + digits.dropFirst(2) }
    return kept
  }

  /// Enough of a number to be worth sending: eight digits, with or without +976.
  static func looksComplete(_ typed: String) -> Bool {
    let number = e164(typed)
    return number.count == 12 && number.hasPrefix("+976")
  }
}
