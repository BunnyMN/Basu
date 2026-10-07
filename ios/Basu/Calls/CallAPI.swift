import Foundation

/**
 The calls API (src/api/calls.ts), as the shell speaks it.

 The voice never comes through here: only the ring, the two halves of the
 WebRTC handshake, and how the call ended. A screen waiting on the other side
 asks «anything after version N?» and the server holds the answer until
 there is something — `wait` seconds at most, kept under the client's own
 fifteen-second timeout.
 */
struct CallInfo: Decodable, Sendable, Equatable {
  let id: String
  let state: String
  let version: Int
  /// `caller` or `callee` — which side of it this phone is.
  let role: String
  let subject: String
  let subjectId: String
  /// «Идэш №7001».
  let about: String
  /// The other side as this side sees it: the business, or the guest's name.
  let peerName: String
  /// The caller's offer, for the person rung while it rings.
  let offer: String?
  /// The answer, for the caller once it is answered.
  let answer: String?
  /// At a supplier everybody is rung: whether it was this person who picked up.
  let answeredHere: Bool
  let endReason: String?

  var isOver: Bool { ["ended", "declined", "missed", "cancelled"].contains(state) }

  enum CodingKeys: String, CodingKey {
    case id, state, version, role, subject, about, offer, answer
    case subjectId = "subject_id"
    case peerName = "peer_name"
    case answeredHere = "answered_here"
    case endReason = "end_reason"
  }
}

struct IceServer: Decodable, Sendable {
  let urls: [String]
  let username: String?
  let credential: String?
}

struct CallPermission: Decodable, Sendable {
  let canCall: Bool
  let peerName: String

  enum CodingKeys: String, CodingKey {
    case canCall = "can_call"
    case peerName = "peer_name"
  }
}

extension API {
  func iceServers(token: String) async throws -> [IceServer] {
    struct Answer: Decodable {
      let iceServers: [IceServer]
      enum CodingKeys: String, CodingKey { case iceServers = "ice_servers" }
    }
    return try await send(.init(path: "/v1/calls/ice", token: token), as: Answer.self).iceServers
  }

  func canCall(subject: String, subjectId: String, token: String) async throws -> CallPermission {
    try await send(.init(
      path: "/v1/calls/can",
      query: [.init(name: "subject", value: subject), .init(name: "subject_id", value: subjectId)],
      token: token,
    ))
  }

  /// Rings the other side of `subjectId` with this phone's offer.
  func startCall(subject: String, subjectId: String, offer: String, token: String) async throws -> CallInfo {
    try await send(.init(
      path: "/v1/calls",
      method: "POST",
      body: ["subject": subject, "subject_id": subjectId, "offer": offer],
      token: token,
    ))
  }

  /// The call as soon as it is past `after`, or as it is once `wait` runs out.
  func call(_ id: String, after: Int = -1, wait: Int = 0, token: String) async throws -> CallInfo {
    try await send(.init(
      path: "/v1/calls/\(id)",
      query: [.init(name: "after", value: String(after)), .init(name: "wait", value: String(wait))],
      token: token,
    ))
  }

  func answerCall(_ id: String, answer: String, token: String) async throws -> CallInfo {
    try await send(.init(path: "/v1/calls/\(id)/answer", method: "POST", body: ["answer": answer], token: token))
  }

  /// Cancel, decline or end — whichever it is for this person now.
  @discardableResult
  func endCall(_ id: String, token: String) async throws -> CallInfo {
    try await send(.init(path: "/v1/calls/\(id)/end", method: "POST", token: token))
  }

  /// How this phone is woken for a call: its PushKit token.
  func registerRingToken(_ ringToken: String, token: String) async throws {
    _ = try await send(
      .init(path: "/v1/calls/tokens", method: "POST", body: ["kind": "voip", "token": ringToken], token: token),
      as: API.Blank.self,
    )
  }

  func revokeRingToken(_ ringToken: String, token: String) async throws {
    _ = try await send(
      .init(path: "/v1/calls/tokens/revoke", method: "POST", body: ["token": ringToken], token: token),
      as: API.Blank.self,
    )
  }
}
