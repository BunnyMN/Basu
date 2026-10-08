package mn.basu.app.shell

import mn.basu.app.core.Endpoint
import mn.basu.app.core.Format
import mn.basu.app.core.IdeshState
import mn.basu.app.core.LiveIdesh
import mn.basu.app.core.LiveOrder
import mn.basu.app.core.OrderState
import java.time.Instant

/**
 * Something of the guest's that is running right now, whichever app it
 * belongs to. Rows are ordered by the moment that matters, not by which app
 * produced them, so a sheep due Tuesday sits under today's lunch.
 *
 * On the screen an order is a card: what it is, the state in one word, a
 * meter of four under the word, and the day or the time in the corner with
 * what it is the time of — «АВАХ», «ИРЭХ» — in gold.
 */
data class LiveItem(
  val id: String,
  val source: String,
  val title: String,
  val code: String,
  val detail: String,
  val time: Instant,
  /** The time as the corner shows it: `12:21` for a lunch, `11/3` for a sheep. */
  val whenText: String,
  /** What the time *is* — `ИРЭХ`, `ГАЛ`, `БЭЛЭН`, `АВАХ`. */
  val timeLabel: String,
  val destination: Destination?,
  /** The row as TalkBack says it. */
  val spoken: String,
  /** A second line, and only when this row is alone on the screen. */
  val extra: Pair<String, Instant>?,
  /** The card's title: the restaurant, or the meat and how much of it. */
  val headline: String,
  /** The state in one word — the web's own: «Бэлтгэж байна». */
  val word: String,
  /** 1…4 along the meter; nought for an order that ended without happening. */
  val step: Int,
  val tone: Tone,
  /** The tile's picture, for the thumbnail when there is no photograph. */
  val art: String,
  /** A photograph of what was bought, when the order says what animal. */
  val photo: String?,
  /** Over: handed over, served, or ended without happening. */
  val finished: Boolean,
  /** Something happened to it that the guest has not seen yet: a dot until they open it. */
  val news: Boolean = false,
) {
  /** How the state's word is set: as it is, in crimson (cancelled) or gold (money on its way back, a payment owed). */
  enum class Tone { Plain, Stop, Hold }
}

/** The food app's order, as the launcher sees it. */
fun LiveOrder.asLiveItem(expanded: Boolean): LiveItem {
  val (time, label) = moment
  val detail = state.word
  val at = Format.hhmm(time)
  val said = mapOf("гал" to "гал тавина", "бэлэн" to "бэлэн болно")[label] ?: label
  val over = setOf(OrderState.CANCELLED, OrderState.REJECTED, OrderState.NO_SHOW)
  return LiveItem(
    id = id,
    source = "ХООЛ",
    title = restaurant.name,
    code = code,
    detail = detail,
    time = time,
    whenText = at,
    timeLabel = label.uppercase(),
    destination = AppCatalogue.food.destination(order = id),
    spoken = "Хоол, ${restaurant.name}, $at цагт $said, захиалга $code, ${detail.lowercase()}" + fresh(unseen),
    // The fire time is the product. When this is the only thing running it
    // belongs on the launcher, not one tap inside the app.
    extra = if (expanded && fireAt != null && state != OrderState.FIRED && state != OrderState.COOKING) "Гал тавих цаг" to fireAt else null,
    headline = restaurant.name,
    word = detail,
    step = step,
    tone = if (state in over) LiveItem.Tone.Stop else if (state == OrderState.REFUNDED) LiveItem.Tone.Hold else LiveItem.Tone.Plain,
    art = "food-tile",
    photo = null,
    finished = state in over + setOf(OrderState.SERVED, OrderState.CLOSED, OrderState.REFUNDED),
    news = unseen > 0,
  )
}

/** Along the meter: in and waiting on the kitchen, on the fire, ready, served. */
val LiveOrder.step: Int
  get() = when (state) {
    OrderState.FIRED, OrderState.COOKING -> 2
    OrderState.READY -> 3
    OrderState.SERVED, OrderState.CLOSED -> 4
    OrderState.CANCELLED, OrderState.REFUNDED, OrderState.REJECTED, OrderState.NO_SHOW -> 0
    else -> 1
  }

/** The winter-meat order, as the launcher sees it. */
fun LiveIdesh.asLiveItem(): LiveItem {
  val cancelled = state == IdeshState.CANCELLED
  val label = if (cancelled) "буцаалт" else if (receive == "delivery") "ирэх" else "авах"
  val what = "$meat · $amount"
  return LiveItem(
    id = id,
    source = "ИДЭШ",
    title = supplier.name,
    code = code,
    detail = "$what · ${state.word}",
    time = receiveOn,
    // A cancelled order is still here for its refund, not for a day.
    whenText = if (cancelled) "—" else Format.day(receiveOn),
    timeLabel = label.uppercase(),
    destination = AppCatalogue.idesh.destination(order = id),
    spoken = (
      if (cancelled) "Идэш, ${supplier.name}, $meat, $amount, захиалга $code, ${state.word.lowercase()}"
      else "Идэш, ${supplier.name}, ${Format.dayWords(receiveOn)}-нд $label, $meat, $amount, захиалга $code, ${state.word.lowercase()}"
    ) + fresh(unseen),
    extra = null,
    headline = what,
    word = state.word,
    step = step,
    tone = when (state) {
      IdeshState.CANCELLED -> LiveItem.Tone.Stop
      IdeshState.REFUNDED, IdeshState.DRAFT -> LiveItem.Tone.Hold
      else -> LiveItem.Tone.Plain
    },
    art = "idesh-tile",
    photo = photo,
    finished = state in setOf(IdeshState.HANDED, IdeshState.CLOSED, IdeshState.CANCELLED, IdeshState.REFUNDED),
    news = unseen > 0,
  )
}

/** The dot, as TalkBack says it. */
private fun fresh(unseen: Int): String = if (unseen > 0) ", шинэ мэдээтэй" else ""

/** The listing's name without what the amount already says: «Хонины мах, кг-аар» × 10 reads «Хонины мах · 10 кг». */
val LiveIdesh.meat: String
  get() {
    if (unit != "kg") return title
    for (tail in listOf(", кг-аар", " кг-аар", ", кгаар")) if (title.endsWith(tail)) return title.dropLast(tail.length)
    return title
  }

/** «10 кг», or «1 толгой» for a whole animal — the web's own words for the unit. */
val LiveIdesh.amount: String
  get() = when (unit) {
    "kg" -> "$qty кг"
    "whole" -> "$qty толгой"
    else -> "×$qty"
  }

/** Along the meter: paid, being prepared, ready, on its way or handed over. */
val LiveIdesh.step: Int
  get() = when (state) {
    IdeshState.PAID -> 1
    IdeshState.PREPARING -> 2
    IdeshState.READY -> 3
    IdeshState.DISPATCHED, IdeshState.HANDED, IdeshState.CLOSED -> 4
    IdeshState.DRAFT, IdeshState.CANCELLED, IdeshState.REFUNDED -> 0
  }

/** The animal's photograph, from the server — the one its stall shows. */
val LiveIdesh.photo: String?
  get() = if (kind in setOf("sheep", "beef", "goat", "horse")) "${Endpoint.base}/idesh/$kind.jpg" else null
