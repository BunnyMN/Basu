import Foundation
import Security

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
  private(set) var phone: String?

  private let api: API
  private let store: Keychain

  init(api: API = API(), store: Keychain = Keychain(service: "mn.basu.app")) {
    self.api = api
    self.store = store
    token = store.read("guest.token")
    phone = store.read("guest.phone")
  }

  var isSignedIn: Bool { token != nil }

  func requestCode(phone: String) async throws {
    try await api.requestCode(phone: phone)
  }

  func verify(phone: String, code: String) async throws {
    let token = try await api.verify(phone: phone, code: code)
    keep(token: token, phone: phone)
  }

  #if DEBUG
    /// The demo way in: the walkthrough cannot read an SMS that went to a fake
    /// gateway, and putting the code in the response would be a hole that
    /// shipped. Debug builds only — the button does not exist in a release.
    func demoSignIn(phone: String = "+97699001122") async throws {
      let token = try await api.demoLogin(phone: phone)
      keep(token: token, phone: phone)
    }
  #endif

  /// A stored token outlives the thing it points at — sessions expire, get
  /// revoked, or vanish when the demo database is reseeded. A 401 means this
  /// one is dead, not that the guest did anything wrong.
  func forget() {
    token = nil
    store.delete("guest.token")
  }

  func signOut() {
    forget()
    phone = nil
    store.delete("guest.phone")
  }

  private func keep(token: String, phone: String) {
    self.token = token
    self.phone = phone
    store.write(token, for: "guest.token")
    store.write(phone, for: "guest.phone")
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
