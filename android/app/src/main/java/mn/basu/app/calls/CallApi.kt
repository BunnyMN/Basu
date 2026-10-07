package mn.basu.app.calls

import mn.basu.app.core.Api
import mn.basu.app.core.objects
import mn.basu.app.core.str
import org.json.JSONObject

/**
 * The calls API (src/api/calls.ts), as the shell speaks it — the twin of
 * iOS's CallAPI.swift.
 *
 * Only the ring, the two halves of the WebRTC handshake and how the call
 * ended pass through here; the voice goes phone to phone. A screen waiting
 * on the other side asks «anything after version N?» and the server holds
 * the answer until there is something: `wait` seconds at most, kept under
 * the client's own fifteen-second read timeout.
 */
data class CallInfo(
  val id: String,
  val state: String,
  val version: Int,
  /** `caller` or `callee` — which side of it this phone is. */
  val role: String,
  val subject: String,
  val subjectId: String,
  /** «Идэш №7001». */
  val about: String,
  /** The other side as this side sees it: the business, or the guest's name. */
  val peerName: String,
  /** The caller's offer, for the person rung while it rings. */
  val offer: String?,
  /** The answer, for the caller once it is answered. */
  val answer: String?,
  /** At a supplier everybody is rung: whether it was this person who picked up. */
  val answeredHere: Boolean,
  val endReason: String?,
) {
  val isOver: Boolean get() = state in setOf("ended", "declined", "missed", "cancelled")

  companion object {
    fun from(json: JSONObject) = CallInfo(
      id = json.optString("id"),
      state = json.optString("state"),
      version = json.optInt("version"),
      role = json.optString("role"),
      subject = json.optString("subject"),
      subjectId = json.optString("subject_id"),
      about = json.optString("about"),
      peerName = json.optString("peer_name"),
      offer = json.str("offer"),
      answer = json.str("answer"),
      answeredHere = json.optBoolean("answered_here"),
      endReason = json.str("end_reason"),
    )
  }
}

data class IceServer(val urls: List<String>, val username: String?, val credential: String?)

suspend fun Api.iceServers(token: String): List<IceServer> =
  send("/v1/calls/ice", token = token).getJSONArray("ice_servers").objects().map { server ->
    val urls = server.getJSONArray("urls")
    IceServer((0 until urls.length()).map(urls::getString), server.str("username"), server.str("credential"))
  }

suspend fun Api.startCall(subject: String, subjectId: String, offer: String, token: String): CallInfo =
  CallInfo.from(send("/v1/calls", "POST", mapOf("subject" to subject, "subject_id" to subjectId, "offer" to offer), token))

/** The call as soon as it is past `after`, or as it is once `wait` runs out. */
suspend fun Api.call(id: String, after: Int, wait: Int, token: String): CallInfo =
  CallInfo.from(send("/v1/calls/$id", token = token, query = mapOf("after" to after.toString(), "wait" to wait.toString())))

suspend fun Api.answerCall(id: String, answer: String, token: String): CallInfo =
  CallInfo.from(send("/v1/calls/$id/answer", "POST", mapOf("answer" to answer), token))

/** Cancel, decline or end — whichever it is for this person now. */
suspend fun Api.endCall(id: String, token: String): CallInfo =
  CallInfo.from(send("/v1/calls/$id/end", "POST", token = token))

/** The calls ringing this person; while the list is still `known`, the answer waits for a change. */
suspend fun Api.ringing(known: List<String>, wait: Int, token: String): List<CallInfo> =
  send("/v1/calls/ringing", token = token, query = mapOf("known" to known.joinToString(","), "wait" to wait.toString()))
    .getJSONArray("calls").objects().map(CallInfo::from)
