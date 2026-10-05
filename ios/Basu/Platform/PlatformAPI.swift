import Foundation

/**
 The platform's half of the wire: who you are, what you have, what you were told.

 Kept apart from `Core/API.swift` the way `src/platform/` is kept apart from the
 dining code on the server. Nothing in this file mentions a restaurant, an order
 or a kitchen — that is the test, and the day a second app lands inside Basu it
 is the reason none of this has to be touched.
 */

// MARK: - what comes back

struct Me: Decodable, Sendable, Equatable {
  let id: String
  /// Nil for an account made by email, Google or Apple.
  let phone: String?
  let email: String?
  let displayName: String?
  let locale: String
  let avatarSeed: String
  let memberSince: Date
  let wallet: WalletSummary
  let unread: Int
  /// Whether the account has a password to change, or only one to set — an
  /// account made by email, Google or Apple has none until it chooses one.
  /// Nil from a server that predates passwords by email, which has neither
  /// the changing nor the address to recover one with.
  let hasPassword: Bool?

  enum CodingKeys: String, CodingKey {
    case id, phone, email, locale, wallet, unread
    case displayName = "display_name"
    case avatarSeed = "avatar_seed"
    case memberSince = "member_since"
    case hasPassword = "has_password"
  }

  /// What to greet somebody as. A first name if we have one, never a number.
  var greeting: String {
    guard let name = displayName?.trimmingCharacters(in: .whitespaces), !name.isEmpty else {
      return "Сайн байна уу"
    }
    return "Сайн байна уу, \(name)"
  }
}

struct WalletSummary: Decodable, Sendable, Equatable {
  let balanceMnt: Int
  let currency: String

  enum CodingKeys: String, CodingKey {
    case currency
    case balanceMnt = "balance_mnt"
  }
}

struct WalletStatement: Decodable, Sendable, Equatable {
  let balanceMnt: Int
  let currency: String
  let lines: [WalletLine]
  /// Pass back as `before` for the next page. `nil` when the list is done.
  let next: String?
  /// Whether money can be put in right now. Not sent by the server yet: nil
  /// is "not said", and the wallet goes by the last refusal instead (see
  /// `Platform.topupsOpen`).
  var topupsOpen: Bool? = nil

  enum CodingKeys: String, CodingKey {
    case currency, lines, next
    case balanceMnt = "balance_mnt"
    case topupsOpen = "topups_open"
  }

  static let empty = WalletStatement(balanceMnt: 0, currency: "MNT", lines: [], next: nil)
}

/// One movement in full, with the tax receipt once the authority issues one.
struct Movement: Decodable, Sendable, Equatable {
  let id: String
  let kind: String
  let amountMnt: Int
  let subject: String?
  let subjectId: String?
  let memo: String?
  let at: Date
  let receipt: Receipt?

  struct Receipt: Decodable, Sendable, Equatable {
    /// The URL the tax authority's QR encodes.
    let qr: String
    /// The lottery number, which is the part people actually check.
    let lottery: String?
  }

  enum CodingKeys: String, CodingKey {
    case id, kind, subject, memo, at, receipt
    case amountMnt = "amount_mnt"
    case subjectId = "subject_id"
  }

  var title: String { Self.word(for: kind) }

  /// The ledger's word for a kind of movement, in the language of the person
  /// reading it. A kind the phone has never heard of is still a movement.
  static func word(for kind: String) -> String {
    switch kind {
    case "topup": "Цэнэглэлт"
    case "purchase": "Захиалга"
    case "refund": "Буцаалт"
    case "promotion": "Урамшуулал"
    default: "Гүйлгээ"
    }
  }
}

/// Where somebody is signed in. One row per phone that still holds a token.
struct DeviceSession: Decodable, Sendable, Identifiable, Equatable {
  let id: String
  let label: String?
  /// The phone asking. A list where you cannot tell is a list nobody uses.
  let current: Bool
  let createdAt: Date
  let lastSeenAt: Date?

  enum CodingKeys: String, CodingKey {
    case id, label, current
    case createdAt = "created_at"
    case lastSeenAt = "last_seen_at"
  }

  var name: String { label?.isEmpty == false ? label! : "Тодорхойгүй төхөөрөмж" }
}

struct WalletLine: Decodable, Sendable, Identifiable, Equatable {
  let id: String
  let kind: String
  /// Signed the way the guest reads it: what their balance did.
  let amountMnt: Int
  let subject: String?
  let subjectId: String?
  let memo: String?
  let at: Date

  enum CodingKeys: String, CodingKey {
    case id, kind, subject, memo, at
    case amountMnt = "amount_mnt"
    case subjectId = "subject_id"
  }

  /// The ledger's word for it, in the language of the person reading it. How
  /// the statement says the rest — who, which app, which order — is
  /// `WalletLine.shown`, read from the memo the vertical wrote.
  var title: String { Movement.word(for: kind) }
}

struct TopupStarted: Decodable, Sendable {
  let topupId: String
  let amountMnt: Int
  let actionUrl: String?
  /// Raised for the app's own sheet: QPay's QR and the bank apps, no page.
  let qpay: QPayInvoice?
  let state: String

  enum CodingKeys: String, CodingKey {
    case state, qpay
    case topupId = "topup_id"
    case amountMnt = "amount_mnt"
    case actionUrl = "action_url"
  }
}

/// A QPay invoice the app draws itself: the QR's text, and every bank app
/// that pays it with one tap.
struct QPayInvoice: Decodable, Sendable, Equatable {
  let qr: String
  let banks: [QPayBank]
  /// When QPay lets it go unpaid.
  let expiresAt: Date?

  enum CodingKeys: String, CodingKey {
    case qr, banks
    case expiresAt = "expires_at"
  }
}

/// One bank app: its name, its logo, and the link that opens it on the invoice.
struct QPayBank: Decodable, Sendable, Equatable, Identifiable {
  let name: String
  let description: String
  let logo: String
  let link: String
  var id: String { link }
}

/// What the payment sheet is paying: how much, and QPay's invoice for it.
struct PayRequest: Identifiable, Equatable {
  let id: String
  let amountMnt: Int
  let invoice: QPayInvoice
}

struct InboxMessage: Decodable, Sendable, Identifiable, Equatable {
  let id: String
  let title: String?
  let body: String
  let template: String
  let subject: String?
  let subjectId: String?
  let channel: String
  let state: String
  let at: Date
  let read: Bool

  enum CodingKeys: String, CodingKey {
    case id, title, body, template, subject, channel, state, at, read
    case subjectId = "subject_id"
  }
}

struct Inbox: Decodable, Sendable, Equatable {
  let unread: Int
  let messages: [InboxMessage]

  static let empty = Inbox(unread: 0, messages: [])
}

struct NotifyPreferences: Decodable, Sendable, Equatable {
  var push: Bool
  var sms: Bool
  var marketing: Bool

  static let `default` = NotifyPreferences(push: true, sms: true, marketing: false)
}

private struct Revoked: Decodable { let revoked: Int }
private struct Sent: Decodable { let to: String }

// MARK: - the calls

extension API {
  /// One call the launcher makes: profile, balance and unread together.
  func me(token: String) async throws -> Me {
    try await send(.init(path: "/v1/me", token: token))
  }

  func updateProfile(displayName: String?, locale: String?, token: String) async throws -> Me {
    var body: [String: Any] = [:]
    if let displayName { body["display_name"] = displayName }
    if let locale { body["locale"] = locale }
    return try await send(.init(path: "/v1/me", method: "PATCH", body: body, token: token))
  }

  // MARK: the ways back in

  /**
   A code to an address, for an account that has none. An account with a
   password types it too: a session can be stolen, and an address is how a
   password gets replaced, so a stolen one must not be able to add its own.
   One with no password must have signed in a moment ago, or is told to.
   */
  func attachEmailCode(email: String, password: String?, token: String) async throws {
    var body: [String: Any] = ["email": email]
    if let password { body["password"] = password }
    _ = try await send(
      .init(path: "/v1/me/email/code", method: "POST", body: body, token: token),
      as: API.Blank.self,
    )
  }

  /// The code from that letter. The answer is the bare profile, without the
  /// balance `me` carries, so the caller asks for `me` again rather than
  /// decoding half of one.
  func attachEmail(email: String, code: String, token: String) async throws {
    _ = try await send(
      .init(path: "/v1/me/email", method: "POST", body: ["email": email, "code": code], token: token),
      as: API.Blank.self,
    )
  }

  /**
   A code for an account's first password, to the address on the account —
   the server sends it nowhere else. Returns that address.

   An account made by email, Google or Apple has no old password to prove
   itself with, and a session alone proves nothing: whoever holds one left
   signed in somewhere would give themselves a way in that outlives it.
   */
  func firstPasswordCode(token: String) async throws -> String {
    let answer: Sent = try await send(.init(path: "/v1/me/password/code", method: "POST", token: token))
    return answer.to
  }

  /// A new password, knowing the old one — or the first, with the code from
  /// `firstPasswordCode`'s letter. Every other session ends; the one in hand
  /// stays. Returns how many.
  func changePassword(current: String?, next: String, code: String?, token: String) async throws -> Int {
    var body: [String: Any] = ["next": next]
    if let current { body["current"] = current }
    if let code { body["code"] = code }
    let answer: Revoked = try await send(
      .init(path: "/v1/me/password", method: "POST", body: body, token: token),
    )
    return answer.revoked
  }

  func wallet(token: String, before: String? = nil) async throws -> WalletStatement {
    var query: [URLQueryItem] = []
    if let before { query.append(.init(name: "before", value: before)) }
    return try await send(.init(path: "/v1/wallet", query: query, token: token))
  }

  func movement(_ id: String, token: String) async throws -> Movement {
    try await send(.init(path: "/v1/wallet/\(id)", token: token))
  }

  // MARK: where you are signed in

  func sessions(token: String) async throws -> [DeviceSession] {
    try await send(.init(path: "/v1/me/sessions", token: token), as: Wrapped<[DeviceSession]>.self, key: "sessions").value
  }

  /// Everywhere *else*. Signing somebody out of the phone in their hand
  /// mid-panic is the wrong end of the tool.
  @discardableResult
  func revokeOtherSessions(token: String) async throws -> Int {
    let answer: Revoked = try await send(
      .init(path: "/v1/me/sessions/revoke", method: "POST", token: token),
    )
    return answer.revoked
  }

  func revokeSession(_ id: String, token: String) async throws {
    _ = try await send(
      .init(path: "/v1/me/sessions/\(id)", method: "DELETE", token: token),
      as: API.Blank.self,
    )
  }

  /// Closing the account. Refused while the wallet holds money or something of
  /// theirs is running — the server says which, in Mongolian.
  func closeAccount(token: String) async throws {
    _ = try await send(.init(path: "/v1/me", method: "DELETE", token: token), as: API.Blank.self)
  }

  /// Asking for money. Nothing is credited until `settleTopup`. `native`:
  /// QPay's QR and bank apps for the app's own sheet, rather than a page.
  func startTopup(amountMnt: Int, token: String) async throws -> TopupStarted {
    try await send(.init(
      path: "/v1/wallet/topup",
      method: "POST",
      body: ["amount_mnt": amountMnt, "native": true],
      token: token,
    ))
  }

  /// Confirming it arrived. Safe to call twice — the ledger settles once.
  @discardableResult
  func settleTopup(_ id: String, token: String) async throws -> Int {
    let answer: WalletSummary = try await send(.init(
      path: "/v1/wallet/topup/\(id)/settle",
      method: "POST",
      token: token,
    ))
    return answer.balanceMnt
  }

  func inbox(token: String) async throws -> Inbox {
    try await send(.init(path: "/v1/notifications", token: token))
  }

  /// No id marks the whole inbox read — what opening the list means.
  func markRead(_ id: String?, token: String) async throws {
    var body: [String: Any] = [:]
    if let id { body["id"] = id }
    _ = try await send(
      .init(path: "/v1/notifications/read", method: "POST", body: body, token: token),
      as: API.Blank.self,
    )
  }

  /// The swipe. The row is gone from this guest's inbox; the message itself
  /// stays a record of what was sent.
  func deleteMessage(_ id: String, token: String) async throws {
    _ = try await send(
      .init(path: "/v1/notifications/\(id)", method: "DELETE", token: token),
      as: API.Blank.self,
    )
  }

  /// ActivityKit's push token for one order, so the server can move the lock
  /// screen without the app being open. `subject` is `order` for a lunch,
  /// `idesh` for an идэш.
  func registerActivityToken(_ pushToken: String, subject: String, order orderId: String, token: String) async throws {
    _ = try await send(
      .init(
        path: "/v1/activities/\(orderId)/token", method: "POST",
        body: ["push_token": pushToken, "subject": subject], token: token,
      ),
      as: API.Blank.self,
    )
  }

  func notifyPreferences(token: String) async throws -> NotifyPreferences {
    try await send(.init(path: "/v1/notifications/preferences", token: token))
  }

  func setNotifyPreferences(
    push: Bool?,
    sms: Bool?,
    marketing: Bool?,
    token: String,
  ) async throws -> NotifyPreferences {
    var body: [String: Any] = [:]
    if let push { body["push"] = push }
    if let sms { body["sms"] = sms }
    if let marketing { body["marketing"] = marketing }
    return try await send(.init(
      path: "/v1/notifications/preferences",
      method: "PATCH",
      body: body,
      token: token,
    ))
  }

  func registerPushToken(_ pushToken: String, label: String?, token: String) async throws {
    var body: [String: Any] = ["push_token": pushToken, "platform": "ios"]
    if let label { body["label"] = label }
    _ = try await send(
      .init(path: "/v1/notifications/devices", method: "POST", body: body, token: token),
      as: API.Blank.self,
    )
  }
}
