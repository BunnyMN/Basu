import Foundation

/**
 The one place the shell talks to the server.

 Thin on purpose, the way `src/api/server.ts` is thin: it parses, it names who
 is calling, and it hands back a type. Nothing here decides anything about food
 or money — those decisions live on the other end of the wire and are tested
 there. The food service itself never comes through here: it is a web page
 inside `ServiceView`, and it calls `/v1` on its own with the token the shell
 hands it.
 */

/// Where the API is: the pilot, unless a developer says otherwise.
///
/// Every build — debug or release, simulator or phone — talks to the pilot
/// by default, so a build handed to somebody works without a laptop beside
/// it. A developer running `npm run dev` points a debug build at their own
/// machine instead, with `BASU_API`: as an environment variable (the
/// simulator, and how the UI tests point the app at the server they check),
/// or baked into Info.plist at build time (`BASU_API=… xcodebuild …`) for a
/// phone, which has no environment to read and for which `localhost` is the
/// phone itself. Release builds ignore both.
enum Endpoint {
  static let pilot = URL(string: "https://basu.burzai.cloud")!

  static let base: URL = {
    #if DEBUG
      if let raw = ProcessInfo.processInfo.environment["BASU_API"], let url = URL(string: raw) {
        return url
      }
      if let raw = Bundle.main.object(forInfoDictionaryKey: "BasuAPI") as? String,
         !raw.isEmpty, let url = URL(string: raw) {
        return url
      }
    #endif
    return pilot
  }()
}

/// Which ways in the server has open.
struct AuthMethods: Decodable, Sendable, Equatable {
  let password: Bool
  let email: Bool
  let google: Bool
  let apple: Bool

  static let unknown = AuthMethods(password: true, email: false, google: false, apple: true)
}

/// What a code for a password is for: a new account by email, or a
/// forgotten password.
enum PasswordPurpose: String, Sendable {
  case signUp = "sign_up"
  case reset
}

/**
 What Google's round trip came back with: `basu://auth#auth=<token>`, or
 `#auth_error=<why>`. The session rides in the fragment, which no server or
 log ever sees.
 */
enum GoogleReturn: Equatable, Sendable {
  case token(String)
  /// The person backed out at Google. Nothing to say about it.
  case cancelled
  case refused(String)

  static let scheme = "basu"
  static let callback = "basu://auth"

  static func parse(_ url: URL) -> GoogleReturn {
    guard url.scheme == scheme, url.host == "auth",
          let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment,
          let items = URLComponents(string: "?" + fragment)?.queryItems
    else { return .refused("SOCIAL_REFUSED") }
    if let token = items.first(where: { $0.name == "auth" })?.value, !token.isEmpty { return .token(token) }
    let why = items.first(where: { $0.name == "auth_error" })?.value ?? "SOCIAL_REFUSED"
    return why == "CANCELLED" ? .cancelled : .refused(why)
  }

  /// A refusal in the words the web page uses for the same thing.
  static func words(for code: String) -> String {
    code == "SOCIAL_CLOSED"
      ? "Google-ээр нэвтрэх одоогоор нээгдээгүй байна."
      : "Google-ээр нэвтэрч чадсангүй. Дахин оролдоно уу."
  }
}

/// A refusal from the server, already written in Mongolian.
///
/// The API sends `message_mn` precisely so that no client has to invent a
/// second, worse explanation of the same thing — so this carries it through
/// untouched and only guesses when the connection itself failed.
struct APIError: LocalizedError, Sendable {
  let status: Int
  let code: String
  let message: String

  var errorDescription: String? { message }

  static let offline = APIError(
    status: 0,
    code: "OFFLINE",
    message: "Сүлжээ алга. Дахин оролдоно уу.",
  )

  var isUnauthorised: Bool { status == 401 }
}

private struct ErrorEnvelope: Decodable {
  struct Body: Decodable {
    let code: String
    let message_mn: String
  }
  let error: Body
}

/// The timestamps the API sends: ISO 8601, sometimes with milliseconds.
enum ISODate {
  // Formatters are read-only here and Foundation's are safe to share.
  nonisolated(unsafe) private static let withFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

  static func parse(_ text: String) -> Date? {
    withFraction.date(from: text) ?? plain.date(from: text)
  }
}

struct API: Sendable {
  var base: URL = Endpoint.base
  var urlSession: URLSession = .shared

  /// Is anything listening? Used to tell "nobody is cooking today" apart from
  /// "this phone cannot reach the server", which look identical on screen and
  /// mean completely different things to whoever is holding it.
  func reachable() async -> Bool {
    ((try? await send(.init(path: "/health"), as: Blank.self)) != nil)
  }

  // MARK: signing in
  //
  // An email address or a phone number, and a password. Each call names the
  // device — what this phone calls itself — so the session list on the
  // profile screen is four different rows rather than four identical ones.

  /// `login` is an address when it has an @ in it, a number otherwise. The
  /// server tells them apart the same way; older builds sent `phone`.
  func signIn(login: String, password: String, device: String) async throws -> String {
    try await send(
      .init(path: "/v1/auth/login", method: "POST", body: ["login": login, "password": password, "device": device]),
      as: Token.self,
    ).token
  }

  /**
   A code for choosing a password, to an inbox: `signUp` for an address that
   is to become an account, `reset` for a forgotten password, named by its
   address or its number. Returns where the letter went — the address as
   typed, or masked («ba•••mn@gmail.com») when only a number was.
   */
  func passwordCode(login: String, purpose: PasswordPurpose) async throws -> String {
    try await send(
      .init(path: "/v1/auth/password/code", method: "POST", body: ["login": login, "purpose": purpose.rawValue]),
      as: CodeSent.self,
    ).to
  }

  /// The code from that letter and the password it is for. An address with
  /// no account becomes one, named `name`; one with an account gets the new
  /// password, and every other session of it ends.
  func setPassword(login: String, code: String, password: String, name: String?, device: String) async throws -> PasswordSet {
    var body: [String: Any] = ["login": login, "code": code, "password": password, "device": device]
    if let name { body["name"] = name }
    return try await send(.init(path: "/v1/auth/password", method: "POST", body: body), as: PasswordSet.self)
  }

  func register(phone: String, password: String, device: String) async throws -> String {
    try await send(
      .init(path: "/v1/auth/register", method: "POST", body: ["phone": phone, "password": password, "device": device]),
      as: Token.self,
    ).token
  }

  // MARK: signing in without a phone
  //
  // A code by email, Google through the system's sign-in sheet, and Apple.
  // The server says which of them it has open; the sheet draws only those.

  /// A server that does not answer is taken to have what every one of them
  /// has: Apple and the phone. Google and email wait until it says so.
  func authMethods() async -> AuthMethods {
    (try? await send(.init(path: "/v1/auth/methods"), as: AuthMethods.self)) ?? .unknown
  }

  /// The code goes to the inbox, never back here.
  func emailStart(email: String) async throws {
    _ = try await send(.init(path: "/v1/auth/email/start", method: "POST", body: ["email": email]), as: Blank.self)
  }

  func emailVerify(email: String, code: String, device: String) async throws -> String {
    try await send(
      .init(path: "/v1/auth/email/verify", method: "POST", body: ["email": email, "code": code, "device": device]),
      as: Token.self,
    ).token
  }

  /// The identity token Apple handed the app, and the nonce whose hash Apple
  /// was asked to put in it.
  func apple(identityToken: String, nonce: String, name: String?, device: String) async throws -> String {
    var body: [String: Any] = ["identity_token": identityToken, "nonce": nonce, "device": device]
    if let name { body["name"] = name }
    return try await send(.init(path: "/v1/auth/apple", method: "POST", body: body), as: Token.self).token
  }

  /// Where the system's sign-in sheet opens for Google. The server sends the
  /// person on to Google, and back to `basu://auth` — which the sheet
  /// catches before any other app could.
  var googleStart: URL {
    var components = URLComponents(url: base.appendingPathComponent("/v1/auth/google/start"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "return", value: GoogleReturn.callback)]
    return components.url!
  }

  // MARK: what is running

  /// Whether this guest is a supplier — the launcher's one question before
  /// it draws the tile. `null` from the server is a plain no.
  func supplierMine(token: String) async throws -> SupplierMine? {
    try await send(.init(path: "/v1/supplier/me", token: token), as: Wrapped<SupplierMine?>.self, key: "supplier").value
  }

  /// The other service's live list. Its page draws everything else.
  func liveIdesh(token: String) async throws -> [LiveIdesh] {
    try await send(.init(path: "/v1/idesh", token: token), as: Wrapped<[LiveIdesh]>.self, key: "orders").value
  }

  func liveOrders(token: String) async throws -> [LiveOrder] {
    try await send(.init(path: "/v1/orders", token: token), as: Wrapped<[LiveOrder]>.self, key: "orders").value
  }

  /// Straight to a session, the way a developer's own server allows. Debug
  /// builds only: the real way in is a password.
  func demoLogin(phone: String, device: String) async throws -> String {
    try await send(
      .init(path: "/dev/login", method: "POST", body: ["phone": phone, "device": device]),
      as: Token.self,
    ).token
  }

  // MARK: the wire

  private struct Token: Decodable { let token: String }
  private struct CodeSent: Decodable { let to: String }
  struct Blank: Decodable {}

  /// A session, and whether an account was made for it.
  struct PasswordSet: Decodable, Sendable {
    let token: String
    /// False when the address already had an account, which now has this
    /// password — worth telling somebody who thought they were signing up.
    let created: Bool
  }

  /// A payload that is one named array — `{ "restaurants": [...] }`.
  struct Wrapped<T: Decodable>: Decodable {
    let value: T

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: Key.self)
      let key = decoder.userInfo[.wrapperKey] as? String ?? ""
      value = try container.decode(T.self, forKey: Key(stringValue: key)!)
    }

    struct Key: CodingKey {
      var stringValue: String
      var intValue: Int? { nil }
      init?(stringValue: String) { self.stringValue = stringValue }
      init?(intValue: Int) { nil }
    }
  }

  struct Request {
    var path: String
    var method: String = "GET"
    var query: [URLQueryItem] = []
    var body: [String: Any]?
    var token: String?
    var idempotencyKey: String?
  }

  // Not private: the platform calls live in Platform/PlatformAPI.swift, which
  // is a different file, and keeping them there is the point — profile, wallet
  // and inbox are the shell's, not any one app's, and the app is laid out the
  // way the server is.
  func send<T: Decodable>(_ request: Request) async throws -> T {
    try await send(request, as: T.self)
  }

  func send<T: Decodable>(_ request: Request, as type: T.Type, key: String? = nil) async throws -> T {
    var components = URLComponents(url: base.appendingPathComponent(request.path), resolvingAgainstBaseURL: false)!
    if !request.query.isEmpty { components.queryItems = request.query }

    var urlRequest = URLRequest(url: components.url!)
    urlRequest.httpMethod = request.method
    urlRequest.timeoutInterval = 15
    if let body = request.body {
      urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
      urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    if let token = request.token {
      urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    }
    if let key = request.idempotencyKey {
      urlRequest.setValue(key, forHTTPHeaderField: "idempotency-key")
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await urlSession.data(for: urlRequest)
    } catch {
      throw APIError.offline
    }

    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) {
        throw APIError(status: status, code: envelope.error.code, message: envelope.error.message_mn)
      }
      throw APIError(status: status, code: "HTTP_\(status)", message: "Алдаа гарлаа. (\(status))")
    }

    if T.self == Blank.self { return Blank() as! T }

    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      guard let date = ISODate.parse(text) else {
        throw DecodingError.dataCorrupted(
          .init(codingPath: decoder.codingPath, debugDescription: "not a date: \(text)"),
        )
      }
      return date
    }
    if let key { decoder.userInfo[.wrapperKey] = key }
    return try decoder.decode(T.self, from: data)
  }
}

extension CodingUserInfoKey {
  static let wrapperKey = CodingUserInfoKey(rawValue: "mn.basu.wrapperKey")!
}
