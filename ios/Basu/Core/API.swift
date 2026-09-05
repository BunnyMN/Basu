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

/// Where the API is. A debug build talks to the machine it was built on; a
/// release build talks to the pilot. `BASU_API` overrides both, which is how
/// the UI test points the app at a server it started itself.
enum Endpoint {
  static let base: URL = {
    if let raw = ProcessInfo.processInfo.environment["BASU_API"], let url = URL(string: raw) {
      return url
    }
    #if DEBUG
      // A debug build on a real phone: the address is baked in at build time
      // (`BASU_API=` on the xcodebuild line), because a phone has no
      // environment and `localhost` there is the phone itself.
      if let raw = Bundle.main.object(forInfoDictionaryKey: "BasuAPI") as? String,
         !raw.isEmpty, let url = URL(string: raw) {
        return url
      }
      return URL(string: "http://localhost:3000")!
    #else
      return URL(string: "https://basu.burzai.cloud")!
    #endif
  }()
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

  func requestCode(phone: String) async throws {
    _ = try await send(.init(path: "/v1/auth/otp", method: "POST", body: ["phone": phone]), as: Blank.self)
  }

  func verify(phone: String, code: String, device: String) async throws -> String {
    let answer: Token = try await send(
      .init(
        path: "/v1/auth/verify",
        method: "POST",
        // What this phone calls itself, so the session list on the profile
        // screen is four different rows rather than four identical ones.
        body: ["phone": phone, "code": code, "device": device],
      ),
    )
    return answer.token
  }

  // MARK: what is running

  /// The other service's live list. Its page draws everything else.
  func liveIdesh(token: String) async throws -> [LiveIdesh] {
    try await send(.init(path: "/v1/idesh", token: token), as: Wrapped<[LiveIdesh]>.self, key: "orders").value
  }

  func liveOrders(token: String) async throws -> [LiveOrder] {
    try await send(.init(path: "/v1/orders", token: token), as: Wrapped<[LiveOrder]>.self, key: "orders").value
  }

  /// Straight to a session, the way the demo pages do it. Debug builds only:
  /// the real way in is an SMS.
  func demoLogin(phone: String, device: String) async throws -> String {
    try await send(
      .init(path: "/dev/login", method: "POST", body: ["phone": phone, "device": device]),
      as: Token.self,
    ).token
  }

  // MARK: the wire

  private struct Token: Decodable { let token: String }
  struct Blank: Decodable {}

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
