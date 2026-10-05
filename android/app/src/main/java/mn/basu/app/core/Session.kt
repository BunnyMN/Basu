package mn.basu.app.core

import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Who is signed in, and the token that proves it.
 *
 * The token is kept encrypted under a key in the Android Keystore rather than
 * as plain preferences: it is a bearer credential for somebody's lunch money.
 */
class Session(private val api: Api, private val context: Context) {
  private val store = Keychain(context, "basu.session")
  private val prefs = context.getSharedPreferences("basu", Context.MODE_PRIVATE)

  var token: String? by mutableStateOf(store.read("guest.token"))
    private set

  /**
   * What the person signed in with, when the sheet knows it: the number, or
   * the address. Google says it only to the server, so after that both are
   * null and the profile's `Me` has it instead.
   */
  var phone: String? by mutableStateOf(store.read("guest.phone"))
    private set
  var email: String? by mutableStateOf(store.read("guest.email"))
    private set

  val isSignedIn: Boolean get() = token != null

  /**
   * Which ways in the server has open, for the sheet to draw. Remembered, so
   * the next sheet draws them at once; a server that does not answer gets
   * what it said last time.
   */
  suspend fun methods(): AuthMethods {
    api.authMethodsIfAnswered()?.let {
      prefs.edit().putString(methodsKey, it.toJson()).apply()
      return it
    }
    return rememberedMethods() ?: AuthMethods.unknown
  }

  /** Per server: a developer's own one may have doors the pilot has not. */
  private val methodsKey get() = "auth.methods.${Endpoint.key}"

  /** What the server said last time, if it has ever said. */
  fun rememberedMethods(): AuthMethods? =
    prefs.getString(methodsKey, null)?.let { runCatching { AuthMethods.from(JSONObject(it)) }.getOrNull() }

  /** Where the system's browser tab goes for Google. */
  val googleStart: Uri get() = api.googleStart

  // ── without a phone ──────────────────────────────────────────────────

  /** A code to the address. It goes to the inbox, never back here. */
  suspend fun requestCode(email: String) = api.emailStart(address(email))

  /** The code from the letter. An address nobody has used becomes an account. */
  suspend fun signIn(email: String, code: String) {
    val address = address(email)
    val token = api.emailVerify(address, code, deviceName(context))
    keep(token, phone = null, email = address)
  }

  /** The session Google's round trip ended with, taken from the fragment. */
  fun signedInWithGoogle(token: String) = keep(token, phone = null, email = null)

  // ── with a password ──────────────────────────────────────────────────

  /** An address or a number, and the password it already has. */
  suspend fun signInWithPassword(typed: String, password: String) {
    val login = login(typed)
    keepLogin(api.signIn(login, password, deviceName(context)), login)
  }

  /** A code for choosing a password, to the inbox the login names. Returns where it went. */
  suspend fun requestPasswordCode(typed: String, purpose: PasswordPurpose): String =
    api.passwordCode(login(typed), purpose)

  /**
   * The code from the letter and the password it is for, and signed in.
   * Returns whether an account was made.
   */
  suspend fun setPassword(typed: String, code: String, password: String, name: String? = null): Boolean {
    val login = login(typed)
    val answer = api.setPassword(login, code, password, name, deviceName(context))
    keepLogin(answer.token, login)
    return answer.created
  }

  // ── with a phone ─────────────────────────────────────────────────────

  /** A new account, for a number nobody has used. */
  suspend fun register(phone: String, password: String) {
    val number = PhoneNumber.e164(phone)
    keep(api.register(number, password, deviceName(context)), phone = number, email = null)
  }

  /** A developer's own server lets a walkthrough straight in. Debug builds only. */
  suspend fun demoSignIn(phone: String = "+97699001122") {
    keep(api.demoLogin(phone, deviceName(context)), phone = phone, email = null)
  }

  /**
   * A stored token outlives the thing it points at. A 401 means this one is
   * dead, not that the guest did anything wrong.
   */
  fun forget() {
    token = null
    store.delete("guest.token")
  }

  fun signOut() {
    forget()
    phone = null
    email = null
    store.delete("guest.phone")
    store.delete("guest.email")
  }

  private fun keepLogin(token: String, login: String) {
    val byEmail = login.contains("@")
    keep(token, phone = if (byEmail) null else login, email = if (byEmail) login else null)
  }

  private fun keep(token: String, phone: String?, email: String?) {
    store.write(token, "guest.token")
    if (phone != null) store.write(phone, "guest.phone") else store.delete("guest.phone")
    if (email != null) store.write(email, "guest.email") else store.delete("guest.email")
    this.phone = phone
    this.email = email
    this.token = token
  }

  companion object {
    /** An address the one way the server stores it. */
    fun address(typed: String): String = typed.trim().lowercase()

    /** What somebody typed to name their account: an address when it has an @ in it, a number otherwise. */
    fun login(typed: String): String = if (typed.contains("@")) address(typed) else PhoneNumber.e164(typed)

    /** Enough of a login to be worth sending: an address, or a whole number. */
    fun looksLikeLogin(typed: String): Boolean = typed.contains("@") || PhoneNumber.looksComplete(typed)

    /**
     * What this phone calls itself — «Батаагийн Galaxy». It goes to identity
     * so somebody looking at their sessions can tell which row to revoke.
     */
    fun deviceName(context: Context): String {
      val given = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
      if (!given.isNullOrBlank()) return given
      val maker = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
      return if (Build.MODEL.startsWith(maker, ignoreCase = true)) Build.MODEL else "$maker ${Build.MODEL}"
    }
  }
}

/**
 * The smallest keychain that does the job: values encrypted with AES-GCM
 * under a key that never leaves the Android Keystore, kept in a preferences
 * file of their own that no backup carries (see `backup_rules.xml`).
 */
class Keychain(context: Context, name: String) {
  private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
  private val alias = "mn.basu.app.$name"

  private fun key(): SecretKey {
    val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keystore.getKey(alias, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build(),
    )
    return generator.generateKey()
  }

  fun read(name: String): String? {
    val stored = prefs.getString(name, null) ?: return null
    return runCatching {
      val bytes = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
      String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
    }.getOrNull()
  }

  fun write(value: String, name: String) {
    runCatching {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key())
      val bytes = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
      prefs.edit().putString(name, Base64.encodeToString(bytes, Base64.NO_WRAP)).apply()
    }
  }

  fun delete(name: String) {
    prefs.edit().remove(name).apply()
  }
}

/**
 * A Mongolian number the way people type it — «8811 2233», «976…»,
 * «+976 8811-2233» — in the one form the server stores.
 */
object PhoneNumber {
  fun e164(typed: String): String {
    val kept = typed.filter { it !in " -()." }
    val digits = if (kept.startsWith("+")) kept.drop(1) else kept
    if (digits.isEmpty() || !digits.all { it in '0'..'9' }) return kept
    if (digits.length == 8) return "+976$digits"
    if (digits.length == 11 && digits.startsWith("976")) return "+$digits"
    if (digits.length == 13 && digits.startsWith("00976")) return "+" + digits.drop(2)
    return kept
  }

  /** Enough of a number to be worth sending: eight digits, with or without +976. */
  fun looksComplete(typed: String): Boolean {
    val number = e164(typed)
    return number.length == 12 && number.startsWith("+976")
  }
}
