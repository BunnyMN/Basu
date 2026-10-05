package mn.basu.app.core

import org.json.JSONObject
import java.time.Instant

/**
 * What the API says, in types — the shell's share of it.
 *
 * Only what the launcher, the inbox, the wallet and the profile draw is read
 * here. Menus, sittings, dishes and the status screen belong to the apps,
 * which are web pages and read their own JSON.
 */

// ── orders ─────────────────────────────────────────────────────────────

enum class OrderState {
  DRAFT, PLACED, ACCEPTED, SCHEDULED, ARMED, HELD, RESLOTTED, FIRED, COOKING, READY, SERVED,
  NO_SHOW, REJECTED, CANCELLED, REFUNDED, CLOSED;

  /** The same words the web app uses. Shared copy, one product. */
  val headline: Pair<String, String>?
    get() = when (this) {
      PLACED -> "Хүлээгдэж байна" to "Ресторан хараахан хараагүй"
      ACCEPTED -> "Баталгаажлаа" to "Гал тавих цаг тооцоологдож байна"
      HELD -> "Хүлээж байна" to "Гал тогоо ачаалалтай байна"
      FIRED -> "Гал дээр" to "Хоол хийгдэж эхэллээ"
      READY -> "Бэлэн" to "Ширээндээ хүрч ирлээ"
      SERVED -> "Сайхан хооллоорой" to ""
      CLOSED -> "Дууслаа" to "Баярлалаа"
      CANCELLED -> "Цуцлагдлаа" to "Мөнгө буцаагдана"
      REFUNDED -> "Буцаагдлаа" to "Мөнгө таны данс руу очлоо"
      NO_SHOW -> "Ирээгүй" to "Хоол хадгалагдаагүй"
      REJECTED -> "Татгалзсан" to "Мөнгө бүтэн буцаагдана"
      else -> null
    }

  /** The state's one word, the web launcher's own. Never the state's name in English. */
  val word: String
    get() = headline?.first ?: when (this) {
      SCHEDULED -> "Хүлээн авсан"
      ARMED -> "Хөдлөх цаг"
      COOKING -> "Гал дээр"
      else -> "Хүлээгдэж байна"
    }

  companion object {
    /** Unknown states read rather than throw: a server that learns a new one should not brick the phone. */
    fun from(raw: String?): OrderState = entries.firstOrNull { it.name == raw } ?: PLACED
  }
}

data class VenueRef(val id: String, val name: String) {
  companion object {
    fun from(json: JSONObject?) = VenueRef(json?.optString("id") ?: "", json?.optString("name") ?: "")
  }
}

/** One row of `GET /v1/orders` — what the home screen puts in front of you. */
data class LiveOrder(
  val id: String,
  val code: String,
  val state: OrderState,
  val restaurant: VenueRef,
  val table: String?,
  val totalMnt: Int,
  val partySize: Int?,
  val slotStartsAt: Instant,
  val fireAt: Instant?,
  val readyAt: Instant?,
) {
  /**
   * The time worth putting in the corner of the card, and what it is called.
   * The sitting is when the guest comes — «ирэх».
   */
  val moment: Pair<Instant, String>
    get() {
      if (readyAt != null && (state == OrderState.FIRED || state == OrderState.COOKING)) return readyAt to "бэлэн"
      if (fireAt != null && state != OrderState.READY && state != OrderState.SERVED) return fireAt to "гал"
      return slotStartsAt to "ирэх"
    }

  companion object {
    fun from(json: JSONObject) = LiveOrder(
      id = json.getString("id"),
      code = json.optString("code"),
      state = OrderState.from(json.str("state")),
      restaurant = VenueRef.from(json.optJSONObject("restaurant")),
      table = json.str("table"),
      totalMnt = json.optInt("total_mnt"),
      partySize = json.int("party_size"),
      slotStartsAt = json.date("slot_starts_at") ?: Instant.EPOCH,
      fireAt = json.date("fire_at"),
      readyAt = json.date("ready_at"),
    )
  }
}

// ── өвлийн идэш ────────────────────────────────────────────────────────

/** The life of a winter-meat order, as the server names it. */
enum class IdeshState(val word: String) {
  DRAFT("Төлөгдөөгүй"),
  PAID("Төлсөн"),
  PREPARING("Бэлтгэж байна"),
  READY("Бэлэн"),
  DISPATCHED("Замд"),
  HANDED("Хүлээлгэн өгсөн"),
  CLOSED("Дууслаа"),
  CANCELLED("Цуцлагдлаа"),
  REFUNDED("Буцаагдлаа");

  companion object {
    fun from(raw: String?): IdeshState = entries.firstOrNull { it.name == raw } ?: PAID
  }
}

/** The supplier a signed-in guest owns, if they own one. Null for almost everybody. */
data class SupplierMine(val id: String, val name: String, val state: String) {
  companion object {
    fun from(json: JSONObject) = SupplierMine(json.optString("id"), json.optString("name"), json.optString("state"))
  }
}

/**
 * One row of `GET /v1/idesh`. Dates come as `YYYY-MM-DD` days, not instants:
 * the meat is ready on a day, and the row says so.
 */
data class LiveIdesh(
  val id: String,
  val code: String,
  val state: IdeshState,
  val supplier: VenueRef,
  /** `sheep`, `beef`, `goat`, `horse` — which animal, for the card's photograph. */
  val kind: String?,
  val title: String,
  val qty: Int,
  /** `kg` or `whole` — what `qty` counts. */
  val unit: String?,
  val totalMnt: Int,
  val receive: String,
  val receiveOnDay: String,
) {
  /** Noon on the day, in Ulaanbaatar — an instant to sort by, never to print. */
  val receiveOn: Instant
    get() = IsoDate.parse("${receiveOnDay}T12:00:00+08:00") ?: Instant.MAX

  companion object {
    fun from(json: JSONObject) = LiveIdesh(
      id = json.getString("id"),
      code = json.optString("code"),
      state = IdeshState.from(json.str("state")),
      supplier = VenueRef.from(json.optJSONObject("supplier")),
      kind = json.str("kind"),
      title = json.optString("title"),
      qty = json.optInt("qty"),
      unit = json.str("unit"),
      totalMnt = json.optInt("total_mnt"),
      receive = json.optString("receive"),
      receiveOnDay = json.optString("receive_on"),
    )
  }
}

// ── the platform: who you are, what you have, what you were told ───────

data class WalletSummary(val balanceMnt: Int, val currency: String) {
  companion object {
    fun from(json: JSONObject?) = WalletSummary(json?.optInt("balance_mnt") ?: 0, json?.optString("currency", "MNT") ?: "MNT")
  }
}

data class Me(
  val id: String,
  /** Nil for an account made by email, Google or Apple. */
  val phone: String?,
  val email: String?,
  val displayName: String?,
  val locale: String,
  val avatarSeed: String,
  val memberSince: Instant,
  val wallet: WalletSummary,
  val unread: Int,
  /** Whether the account has a password to change, or only one to set. Nil from an older server. */
  val hasPassword: Boolean?,
) {
  /** What to greet somebody as. A first name if we have one, never a number. */
  val greeting: String
    get() {
      val name = displayName?.trim()
      return if (name.isNullOrEmpty()) "Сайн байна уу" else "Сайн байна уу, $name"
    }

  companion object {
    fun from(json: JSONObject) = Me(
      id = json.optString("id"),
      phone = json.str("phone"),
      email = json.str("email"),
      displayName = json.str("display_name"),
      locale = json.optString("locale", "mn"),
      avatarSeed = json.optString("avatar_seed"),
      memberSince = json.date("member_since") ?: Instant.EPOCH,
      wallet = WalletSummary.from(json.optJSONObject("wallet")),
      unread = json.optInt("unread"),
      hasPassword = json.bool("has_password"),
    )
  }
}

/** The ledger's word for a kind of movement. A kind the phone has never heard of is still a movement. */
fun movementWord(kind: String): String = when (kind) {
  "topup" -> "Цэнэглэлт"
  "purchase" -> "Захиалга"
  "refund" -> "Буцаалт"
  "promotion" -> "Урамшуулал"
  else -> "Гүйлгээ"
}

data class WalletLine(
  val id: String,
  val kind: String,
  /** Signed the way the guest reads it: what their balance did. */
  val amountMnt: Int,
  val subject: String?,
  val subjectId: String?,
  val memo: String?,
  val at: Instant,
) {
  val title: String get() = movementWord(kind)

  companion object {
    fun from(json: JSONObject) = WalletLine(
      id = json.optString("id"),
      kind = json.optString("kind"),
      amountMnt = json.optInt("amount_mnt"),
      subject = json.str("subject"),
      subjectId = json.str("subject_id"),
      memo = json.str("memo"),
      at = json.date("at") ?: Instant.EPOCH,
    )
  }
}

data class WalletStatement(
  val balanceMnt: Int,
  val currency: String,
  val lines: List<WalletLine>,
  /** Pass back as `before` for the next page. Null when the list is done. */
  val next: String?,
  /** Whether money can be put in right now. Null is "not said". */
  val topupsOpen: Boolean? = null,
) {
  companion object {
    val empty = WalletStatement(0, "MNT", emptyList(), null)

    fun from(json: JSONObject) = WalletStatement(
      balanceMnt = json.optInt("balance_mnt"),
      currency = json.optString("currency", "MNT"),
      lines = json.optJSONArray("lines")?.objects()?.map(WalletLine::from) ?: emptyList(),
      next = json.str("next"),
      topupsOpen = json.bool("topups_open"),
    )
  }
}

/** One movement in full, with the tax receipt once the authority issues one. */
data class Movement(
  val id: String,
  val kind: String,
  val amountMnt: Int,
  val subject: String?,
  val subjectId: String?,
  val memo: String?,
  val at: Instant,
  val receipt: Receipt?,
) {
  /** `qr`: the URL the tax authority's QR encodes. `lottery`: the part people actually check. */
  data class Receipt(val qr: String, val lottery: String?)

  val title: String get() = movementWord(kind)

  companion object {
    fun from(json: JSONObject) = Movement(
      id = json.optString("id"),
      kind = json.optString("kind"),
      amountMnt = json.optInt("amount_mnt"),
      subject = json.str("subject"),
      subjectId = json.str("subject_id"),
      memo = json.str("memo"),
      at = json.date("at") ?: Instant.EPOCH,
      receipt = json.optJSONObject("receipt")?.let { Receipt(it.optString("qr"), it.str("lottery")) },
    )
  }
}

/** Where somebody is signed in. One row per device that still holds a token. */
data class DeviceSession(
  val id: String,
  val label: String?,
  /** The phone asking. A list where you cannot tell is a list nobody uses. */
  val current: Boolean,
  val createdAt: Instant,
  val lastSeenAt: Instant?,
) {
  val name: String get() = if (label.isNullOrEmpty()) "Тодорхойгүй төхөөрөмж" else label

  companion object {
    fun from(json: JSONObject) = DeviceSession(
      id = json.optString("id"),
      label = json.str("label"),
      current = json.optBoolean("current"),
      createdAt = json.date("created_at") ?: Instant.EPOCH,
      lastSeenAt = json.date("last_seen_at"),
    )
  }
}

data class TopupStarted(val topupId: String, val amountMnt: Int, val actionUrl: String?, val state: String) {
  companion object {
    fun from(json: JSONObject) = TopupStarted(
      json.optString("topup_id"), json.optInt("amount_mnt"), json.str("action_url"), json.optString("state"),
    )
  }
}

data class InboxMessage(
  val id: String,
  val title: String?,
  val body: String,
  val template: String,
  val subject: String?,
  val subjectId: String?,
  val channel: String,
  val state: String,
  val at: Instant,
  val read: Boolean,
) {
  companion object {
    fun from(json: JSONObject) = InboxMessage(
      id = json.optString("id"),
      title = json.str("title"),
      body = json.optString("body"),
      template = json.optString("template"),
      subject = json.str("subject"),
      subjectId = json.str("subject_id"),
      channel = json.optString("channel"),
      state = json.optString("state"),
      at = json.date("at") ?: Instant.EPOCH,
      read = json.optBoolean("read"),
    )
  }
}

data class Inbox(val unread: Int, val messages: List<InboxMessage>) {
  companion object {
    val empty = Inbox(0, emptyList())

    fun from(json: JSONObject) = Inbox(
      json.optInt("unread"),
      json.optJSONArray("messages")?.objects()?.map(InboxMessage::from) ?: emptyList(),
    )
  }
}

data class NotifyPreferences(val push: Boolean, val sms: Boolean, val marketing: Boolean) {
  companion object {
    val default = NotifyPreferences(push = true, sms = true, marketing = false)

    fun from(json: JSONObject) = NotifyPreferences(
      json.optBoolean("push", true), json.optBoolean("sms", true), json.optBoolean("marketing", false),
    )
  }
}
