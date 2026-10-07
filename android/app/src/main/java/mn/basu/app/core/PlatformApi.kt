package mn.basu.app.core

/**
 * The platform's half of the wire: who you are, what you have, what you were
 * told. Kept apart from `Api.kt` the way `src/platform/` is kept apart from
 * the dining code on the server — nothing here mentions a restaurant, an
 * order or a kitchen.
 */

/** One call the launcher makes: profile, balance and unread together. */
suspend fun Api.me(token: String): Me = Me.from(send("/v1/me", token = token))

suspend fun Api.updateProfile(displayName: String?, locale: String?, token: String): Me =
  Me.from(send("/v1/me", "PATCH", mapOf("display_name" to displayName, "locale" to locale), token))

// ── the ways back in ───────────────────────────────────────────────────

/**
 * A code to an address, for an account that has none. An account with a
 * password types it too: a stolen session must not be able to add its own
 * address.
 */
suspend fun Api.attachEmailCode(email: String, password: String?, token: String) {
  send("/v1/me/email/code", "POST", mapOf("email" to email, "password" to password), token)
}

/** The code from that letter. The caller asks for `me` again afterwards. */
suspend fun Api.attachEmail(email: String, code: String, token: String) {
  send("/v1/me/email", "POST", mapOf("email" to email, "code" to code), token)
}

/** A code for an account's first password, to the address on the account. Returns that address. */
suspend fun Api.firstPasswordCode(token: String): String =
  send("/v1/me/password/code", "POST", token = token).getString("to")

/**
 * A new password, knowing the old one — or the first, with the code from
 * `firstPasswordCode`'s letter. Every other session ends. Returns how many.
 */
suspend fun Api.changePassword(current: String?, next: String, code: String?, token: String): Int =
  send("/v1/me/password", "POST", mapOf("next" to next, "current" to current, "code" to code), token).optInt("revoked")

suspend fun Api.wallet(token: String, before: String? = null): WalletStatement =
  WalletStatement.from(send("/v1/wallet", token = token, query = if (before != null) mapOf("before" to before) else emptyMap()))

suspend fun Api.movement(id: String, token: String): Movement = Movement.from(send("/v1/wallet/$id", token = token))

// ── where you are signed in ────────────────────────────────────────────

suspend fun Api.sessions(token: String): List<DeviceSession> =
  send("/v1/me/sessions", token = token).getJSONArray("sessions").objects().map(DeviceSession::from)

/** Everywhere *else*. Returns how many. */
suspend fun Api.revokeOtherSessions(token: String): Int =
  send("/v1/me/sessions/revoke", "POST", token = token).optInt("revoked")

suspend fun Api.revokeSession(id: String, token: String) {
  send("/v1/me/sessions/$id", "DELETE", token = token)
}

/** Closing the account. Refused while the wallet holds money or something is running. */
suspend fun Api.closeAccount(token: String) {
  send("/v1/me", "DELETE", token = token)
}

/** Asking for money. Nothing is credited until `settleTopup`. */
suspend fun Api.startTopup(amountMnt: Int, token: String): TopupStarted =
  TopupStarted.from(send("/v1/wallet/topup", "POST", mapOf("amount_mnt" to amountMnt), token))

/** Confirming it arrived. Safe to call twice — the ledger settles once. */
suspend fun Api.settleTopup(id: String, token: String): Int =
  send("/v1/wallet/topup/$id/settle", "POST", token = token).optInt("balance_mnt")

/** The newest page, or with `before` — an earlier page's `next` — the one after it. */
suspend fun Api.inbox(token: String, before: String? = null): Inbox =
  Inbox.from(send("/v1/notifications", token = token, query = if (before != null) mapOf("before" to before) else emptyMap()))

/** No id marks the whole inbox read — what opening the list means. */
suspend fun Api.markRead(id: String?, token: String) {
  send("/v1/notifications/read", "POST", mapOf("id" to id), token)
}

/** The swipe. The row is gone from this guest's inbox. */
suspend fun Api.deleteMessage(id: String, token: String) {
  send("/v1/notifications/$id", "DELETE", token = token)
}

suspend fun Api.notifyPreferences(token: String): NotifyPreferences =
  NotifyPreferences.from(send("/v1/notifications/preferences", token = token))

suspend fun Api.setNotifyPreferences(push: Boolean?, sms: Boolean?, marketing: Boolean?, token: String): NotifyPreferences =
  NotifyPreferences.from(
    send("/v1/notifications/preferences", "PATCH", mapOf("push" to push, "sms" to sms, "marketing" to marketing), token),
  )

suspend fun Api.registerPushToken(pushToken: String, label: String?, token: String) {
  send("/v1/notifications/devices", "POST", mapOf("push_token" to pushToken, "platform" to "android", "label" to label), token)
}
