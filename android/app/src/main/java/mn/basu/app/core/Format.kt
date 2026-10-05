package mn.basu.app.core

import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs

/**
 * Money and time, said the way Ulaanbaatar says them.
 *
 * The clock is pinned to Asia/Ulaanbaatar rather than to the phone's zone: a
 * fire time is a fact about a kitchen, and a guest whose phone is still on
 * last week's holiday timezone must not be shown a different one.
 */
object Format {
  val zone: ZoneId = ZoneId.of("Asia/Ulaanbaatar")
  private val clock = DateTimeFormatter.ofPattern("HH:mm", Locale.UK)
  private val tugrik = DecimalFormat("#,###", DecimalFormatSymbols(Locale.US))

  private fun local(at: Instant): ZonedDateTime = at.atZone(zone)

  fun mnt(value: Int): String = "${grouped(value)}₮"

  /** Just the digits, grouped by thousands with a comma: «15,000». */
  fun grouped(value: Int): String = tugrik.format(value.toLong())

  fun hhmm(at: Instant?): String = if (at == null) "—" else clock.format(local(at))

  /** «Мягмар»: the day of the week, in Ulaanbaatar. */
  fun weekday(at: Instant): String {
    val names = listOf("Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба", "Ням")
    return names[local(at).dayOfWeek.value - 1]
  }

  /**
   * The launcher's hello, by Ulaanbaatar's clock: «Өглөөний мэнд» until
   * eleven, «Өдрийн мэнд» until five, «Оройн мэнд» after.
   */
  fun greeting(at: Instant): String = when (local(at).hour) {
    in 4..10 -> "Өглөөний мэнд"
    in 11..16 -> "Өдрийн мэнд"
    else -> "Оройн мэнд"
  }

  /** Signed money: `+50,000₮` / `−18,500₮` — a real minus sign, not a hyphen. */
  fun signedMnt(value: Int): String = if (value < 0) "−${mnt(-value)}" else "+${mnt(value)}"

  /** `11/3` — month, then day, at the size a card corner allows. */
  fun day(at: Instant): String = local(at).let { "${it.monthValue}/${it.dayOfMonth}" }

  /** When something started, at the precision that kind of fact has: «2026 оны 9-р сараас». */
  fun since(at: Instant): String = local(at).let { "${it.year} оны ${it.monthValue}-р сараас" }

  /** `2026 оны 10-р сарын 1` — the whole date, for a receipt and anything kept. */
  fun date(at: Instant): String = local(at).let { "${it.year} оны ${it.monthValue}-р сарын ${it.dayOfMonth}" }

  /** `10-р сарын 3` — a day in a sentence, the way a message says it. */
  fun dayWords(at: Instant): String = local(at).let { "${it.monthValue}-р сарын ${it.dayOfMonth}" }

  private fun sameDay(a: Instant, b: Instant): Boolean = local(a).toLocalDate() == local(b).toLocalDate()

  /** When a device was last seen: «саяхан», «өнөөдөр 11:40», «өчигдөр 18:05», or the day. */
  fun seen(at: Instant, now: Instant = Instant.now()): String {
    if (now.epochSecond - at.epochSecond < 5 * 60) return "саяхан"
    if (sameDay(at, now)) return "өнөөдөр ${hhmm(at)}"
    if (local(at).toLocalDate() == local(now).toLocalDate().minusDays(1)) return "өчигдөр ${hhmm(at)}"
    return day(at)
  }

  /** The time if it happened today, the date if it did not. */
  fun `when`(at: Instant, now: Instant = Instant.now()): String = if (sameDay(at, now)) hhmm(at) else day(at)

  /** The same, for TalkBack: «10/1» is read out as a fraction, so a day is said in words. */
  fun whenSpoken(at: Instant, now: Instant = Instant.now()): String = if (sameDay(at, now)) hhmm(at) else dayWords(at)

  /** A line as TalkBack should say it: «·» and «×» are pauses, and «№7001» is «дугаар 7001». */
  fun spoken(text: String): String = text
    .replace("№", "дугаар ")
    .replace(" · ", ", ")
    .replace("·", ",")
    .replace(" ×", " ")
    .replace("×", " ")

  /** Money as TalkBack should say it: the digits and the word, not the sign. */
  fun moneySpoken(value: Int): String = "${grouped(abs(value))} төгрөг"

  /** The badge: the exact count to 99, then `99+`. */
  fun badge(count: Int): String = if (count > 99) "99+" else "$count"
}
