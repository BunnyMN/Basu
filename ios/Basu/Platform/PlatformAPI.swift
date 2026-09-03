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
  let phone: String
  let displayName: String?
  let locale: String
  let avatarSeed: String
  let memberSince: Date
  let wallet: WalletSummary
  let unread: Int

  enum CodingKeys: String, CodingKey {
    case id, phone, locale, wallet, unread
    case displayName = "display_name"
    case avatarSeed = "avatar_seed"
    case memberSince = "member_since"
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

  enum CodingKeys: String, CodingKey {
    case currency, lines
    case balanceMnt = "balance_mnt"
  }

  static let empty = WalletStatement(balanceMnt: 0, currency: "MNT", lines: [])
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

  /**
   Which app the movement came from.

   The vertical writes its own label into the memo when it asks to be paid, so
   the shell never has to know that «order» means lunch. A movement with no
   memo is the platform's own — a top-up.
   */
  var source: String { memo?.isEmpty == false ? memo! : "Basu" }

  /// The ledger's word for it, in the language of the person reading it.
  var title: String {
    switch kind {
    case "topup": "Цэнэглэлт"
    case "purchase": "Захиалга"
    case "refund": "Буцаалт"
    case "promotion": "Урамшуулал"
    default: "Гүйлгээ"
    }
  }
}

struct TopupStarted: Decodable, Sendable {
  let topupId: String
  let amountMnt: Int
  let actionUrl: String?
  let state: String

  enum CodingKeys: String, CodingKey {
    case state
    case topupId = "topup_id"
    case amountMnt = "amount_mnt"
    case actionUrl = "action_url"
  }
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

  func wallet(token: String) async throws -> WalletStatement {
    try await send(.init(path: "/v1/wallet", token: token))
  }

  /// Asking for money. Nothing is credited until `settleTopup`.
  func startTopup(amountMnt: Int, token: String) async throws -> TopupStarted {
    try await send(.init(
      path: "/v1/wallet/topup",
      method: "POST",
      body: ["amount_mnt": amountMnt],
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
