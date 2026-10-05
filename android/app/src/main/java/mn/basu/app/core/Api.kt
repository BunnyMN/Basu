package mn.basu.app.core

import android.net.Uri
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import mn.basu.app.BuildConfig
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.time.Instant
import java.time.OffsetDateTime
import kotlin.coroutines.cancellation.CancellationException

/**
 * The one place the shell talks to the server.
 *
 * Thin on purpose: it parses, it names who is calling, and it hands back a
 * type. Nothing here decides anything about food or money — those decisions
 * live on the other end of the wire. The apps themselves never come through
 * here: they are web pages inside `ServiceView`, and they call `/v1` on their
 * own with the token the shell hands them.
 */

/**
 * Where the API is: the pilot, unless a developer says otherwise. A debug
 * build can be pointed at a developer's own machine with
 * `-PBASU_API=http://10.0.2.2:3000`; release builds ignore it.
 */
object Endpoint {
  const val PILOT = "https://basu.burzai.cloud"

  val base: String by lazy {
    val raw = if (BuildConfig.DEBUG) BuildConfig.BASU_API.trim().trimEnd('/') else ""
    raw.ifEmpty { PILOT }
  }

  private val uri: Uri get() = Uri.parse(base)
  val host: String get() = uri.host ?: ""
  val port: Int get() = uri.port
  /** `host:port`, for what is remembered per server. */
  val key: String get() = "$host:${if (port == -1) 443 else port}"
}

/** Which ways in the server has open. Kept on the phone too, so the way in can be drawn before the server answers. */
data class AuthMethods(
  val password: Boolean,
  val email: Boolean,
  val google: Boolean,
  val apple: Boolean,
  val sms: Boolean,
) {
  fun toJson(): String = JSONObject()
    .put("password", password).put("email", email).put("google", google).put("apple", apple).put("sms", sms)
    .toString()

  companion object {
    val unknown = AuthMethods(password = true, email = false, google = false, apple = true, sms = false)

    fun from(json: JSONObject) = AuthMethods(
      password = json.optBoolean("password", true),
      email = json.optBoolean("email", false),
      google = json.optBoolean("google", false),
      apple = json.optBoolean("apple", false),
      sms = json.optBoolean("sms", false),
    )
  }
}

/** What a code for a password is for: a new account by email, or a forgotten password. */
enum class PasswordPurpose(val raw: String) { SignUp("sign_up"), Reset("reset") }

/**
 * What Google's round trip came back with: `basu://auth#auth=<token>`, or
 * `#auth_error=<why>`. The session rides in the fragment, which no server or
 * log ever sees.
 */
sealed interface GoogleReturn {
  data class Token(val token: String) : GoogleReturn
  /** The person backed out at Google. Nothing to say about it. */
  data object Cancelled : GoogleReturn
  data class Refused(val code: String) : GoogleReturn

  companion object {
    const val SCHEME = "basu"
    const val CALLBACK = "basu://auth"

    fun parse(uri: Uri): GoogleReturn {
      val fragment = uri.encodedFragment
      if (uri.scheme != SCHEME || uri.host != "auth" || fragment.isNullOrEmpty()) return Refused("SOCIAL_REFUSED")
      val items = Uri.parse("basu://auth?$fragment")
      val token = items.getQueryParameter("auth")
      if (!token.isNullOrEmpty()) return Token(token)
      val why = items.getQueryParameter("auth_error") ?: "SOCIAL_REFUSED"
      return if (why == "CANCELLED") Cancelled else Refused(why)
    }

    /** A refusal in the words the web page uses for the same thing. */
    fun words(code: String): String =
      if (code == "SOCIAL_CLOSED") "Google-ээр нэвтрэх одоогоор нээгдээгүй байна."
      else "Google-ээр нэвтэрч чадсангүй. Дахин оролдоно уу."
  }
}

/**
 * A refusal from the server, already written in Mongolian. The API sends
 * `message_mn` so that no client has to invent a second, worse explanation.
 */
class ApiError(val status: Int, val code: String, override val message: String) : Exception(message) {
  val isUnauthorised: Boolean get() = status == 401

  companion object {
    val offline get() = ApiError(0, "OFFLINE", "Сүлжээ алга. Дахин оролдоно уу.")
    /** What is said when the server gave no reason of its own: never a status code. */
    const val FALLBACK = "Алдаа гарлаа. Дахин оролдоно уу."
  }
}

/** A refusal's words, whatever was thrown. */
val Throwable.words: String get() = (this as? ApiError)?.message ?: ApiError.FALLBACK

/** The timestamps the API sends: ISO 8601, sometimes with milliseconds. */
object IsoDate {
  fun parse(text: String?): Instant? {
    if (text.isNullOrEmpty()) return null
    return runCatching { OffsetDateTime.parse(text).toInstant() }.getOrNull()
      ?: runCatching { Instant.parse(text) }.getOrNull()
  }
}

class Api(val base: String = Endpoint.base) {

  /**
   * Is anything listening? Asked twice, a second apart, before the answer is
   * no: a phone waking, or stepping from Wi-Fi to the mobile network, drops
   * one request now and then.
   */
  suspend fun reachable(): Boolean {
    repeat(2) { attempt ->
      if (attempt > 0) delay(1000)
      val ok = try {
        send("/health")
        true
      } catch (e: CancellationException) {
        throw e
      } catch (_: Exception) {
        false
      }
      if (ok) return true
    }
    return false
  }

  // ── signing in ───────────────────────────────────────────────────────
  //
  // An email address or a phone number, and a password. Each call names the
  // device, so the session list on the profile is rows that can be told apart.

  suspend fun signIn(login: String, password: String, device: String): String =
    send("/v1/auth/login", "POST", mapOf("login" to login, "password" to password, "device" to device)).getString("token")

  /** A code for choosing a password, to an inbox. Returns where the letter went. */
  suspend fun passwordCode(login: String, purpose: PasswordPurpose): String =
    send("/v1/auth/password/code", "POST", mapOf("login" to login, "purpose" to purpose.raw)).getString("to")

  /** A session, and whether an account was made for it. */
  data class PasswordSet(val token: String, val created: Boolean)

  suspend fun setPassword(login: String, code: String, password: String, name: String?, device: String): PasswordSet {
    val body = mutableMapOf<String, Any>("login" to login, "code" to code, "password" to password, "device" to device)
    if (name != null) body["name"] = name
    val answer = send("/v1/auth/password", "POST", body)
    return PasswordSet(answer.getString("token"), answer.optBoolean("created", false))
  }

  suspend fun register(phone: String, password: String, device: String): String =
    send("/v1/auth/register", "POST", mapOf("phone" to phone, "password" to password, "device" to device)).getString("token")

  // ── signing in without a phone ───────────────────────────────────────

  /** Nil when the server did not answer — so a guess is never remembered as its answer. */
  suspend fun authMethodsIfAnswered(): AuthMethods? = try {
    AuthMethods.from(send("/v1/auth/methods"))
  } catch (e: CancellationException) {
    throw e
  } catch (_: Exception) {
    null
  }

  /** The code goes to the inbox, never back here. */
  suspend fun emailStart(email: String) {
    send("/v1/auth/email/start", "POST", mapOf("email" to email))
  }

  suspend fun emailVerify(email: String, code: String, device: String): String =
    send("/v1/auth/email/verify", "POST", mapOf("email" to email, "code" to code, "device" to device)).getString("token")

  /**
   * Where the system's browser tab opens for Google. The server sends the
   * person on to Google, and back to `basu://auth`.
   */
  val googleStart: Uri
    get() = Uri.parse("$base/v1/auth/google/start").buildUpon()
      .appendQueryParameter("return", GoogleReturn.CALLBACK)
      .build()

  // ── what is running ──────────────────────────────────────────────────

  /** Whether this guest is a supplier. `null` from the server is a plain no. */
  suspend fun supplierMine(token: String): SupplierMine? =
    send("/v1/supplier/me", token = token).optJSONObject("supplier")?.let(SupplierMine::from)

  suspend fun liveIdesh(token: String): List<LiveIdesh> =
    send("/v1/idesh", token = token).getJSONArray("orders").objects().map(LiveIdesh::from)

  suspend fun liveOrders(token: String): List<LiveOrder> =
    send("/v1/orders", token = token).getJSONArray("orders").objects().map(LiveOrder::from)

  /** Straight to a session, the way a developer's own server allows. Debug builds only. */
  suspend fun demoLogin(phone: String, device: String): String =
    send("/dev/login", "POST", mapOf("phone" to phone, "device" to device)).getString("token")

  // ── the wire ─────────────────────────────────────────────────────────

  suspend fun send(
    path: String,
    method: String = "GET",
    body: Map<String, Any?>? = null,
    token: String? = null,
    query: Map<String, String> = emptyMap(),
  ): JSONObject = withContext(Dispatchers.IO) {
    val search = if (query.isEmpty()) "" else query.entries.joinToString("&", "?") {
      "${URLEncoder.encode(it.key, "UTF-8")}=${URLEncoder.encode(it.value, "UTF-8")}"
    }
    val status: Int
    val text: String
    try {
      val connection = URL(base + path + search).openConnection() as HttpURLConnection
      try {
        connection.requestMethod = method
        connection.connectTimeout = 15_000
        connection.readTimeout = 15_000
        connection.setRequestProperty("accept", "application/json")
        if (token != null) connection.setRequestProperty("authorization", "Bearer $token")
        if (body != null || method == "POST" || method == "PATCH") {
          connection.doOutput = true
          connection.setRequestProperty("content-type", "application/json")
          val json = JSONObject()
          body?.forEach { (key, value) -> if (value != null) json.put(key, value) }
          connection.outputStream.use { it.write(json.toString().toByteArray()) }
        }
        status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
      } finally {
        connection.disconnect()
      }
    } catch (_: IOException) {
      throw ApiError.offline
    }

    if (status !in 200..299) {
      val error = runCatching { JSONObject(text).getJSONObject("error") }.getOrNull()
      if (error != null && error.has("message_mn")) {
        throw ApiError(status, error.optString("code", "HTTP_$status"), error.getString("message_mn"))
      }
      // No words of the server's own — a proxy's error page, a gateway that
      // timed out. The person is told what to do; the number is for the log.
      Log.w("Basu", "$method $path answered $status without an error body")
      throw ApiError(status, "HTTP_$status", ApiError.FALLBACK)
    }
    runCatching { JSONObject(text) }.getOrElse { JSONObject() }
  }
}

fun org.json.JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

/** A string, or null when the key is missing or JSON null — `optString` says "null". */
fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key)

fun JSONObject.int(key: String): Int? = if (isNull(key)) null else optInt(key)

fun JSONObject.bool(key: String): Boolean? = if (isNull(key)) null else optBoolean(key)

fun JSONObject.date(key: String): Instant? = IsoDate.parse(str(key))
