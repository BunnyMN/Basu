package mn.basu.app

import mn.basu.app.core.Format
import mn.basu.app.core.IdeshState
import mn.basu.app.core.LiveIdesh
import mn.basu.app.core.LiveOrder
import mn.basu.app.core.OrderState
import mn.basu.app.core.PhoneNumber
import mn.basu.app.core.Platform
import mn.basu.app.core.Session
import mn.basu.app.core.VenueRef
import mn.basu.app.design.BasuColor
import mn.basu.app.design.seedCells
import mn.basu.app.shell.LiveItem
import mn.basu.app.shell.ServicePage
import mn.basu.app.shell.amount
import mn.basu.app.shell.asLiveItem
import mn.basu.app.shell.meat
import mn.basu.app.shell.step
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * The rules the shell shares with the iOS app, checked without a phone: the
 * same cases as `ios/BasuTests` where the rule is the same.
 */
class ShellRulesTest {
  @Test
  fun `a number is stored one way however it was typed`() {
    assertEquals("+97688112233", PhoneNumber.e164("8811 2233"))
    assertEquals("+97688112233", PhoneNumber.e164("976 8811-2233"))
    assertEquals("+97688112233", PhoneNumber.e164("+976 (8811) 2233"))
    assertEquals("+97688112233", PhoneNumber.e164("0097688112233"))
    assertTrue(PhoneNumber.looksComplete("88112233"))
    assertFalse(PhoneNumber.looksComplete("8811223"))
  }

  @Test
  fun `a login is an address when it has an at sign`() {
    assertEquals("bat@example.mn", Session.login("  Bat@Example.MN "))
    assertEquals("+97699001122", Session.login("9900 1122"))
    assertTrue(Session.looksLikeLogin("a@b"))
    assertFalse(Session.looksLikeLogin("9900"))
  }

  @Test
  fun `money and time are said the way Ulaanbaatar says them`() {
    assertEquals("15,000₮", Format.mnt(15000))
    assertEquals("−18,500₮", Format.signedMnt(-18500))
    assertEquals("+50,000₮", Format.signedMnt(50000))
    // 04:21 UTC is 12:21 in Ulaanbaatar, whatever zone the phone is on.
    val noon = Instant.parse("2026-10-05T04:21:00Z")
    assertEquals("12:21", Format.hhmm(noon))
    assertEquals("—", Format.hhmm(null))
    assertEquals("Даваа", Format.weekday(noon))
    assertEquals("10-р сарын 5", Format.dayWords(noon))
    assertEquals("10/5", Format.day(noon))
    assertEquals("2026 оны 10-р сарын 5", Format.date(noon))
    assertEquals("Өдрийн мэнд", Format.greeting(noon))
    assertEquals("Өглөөний мэнд", Format.greeting(Instant.parse("2026-10-05T00:00:00Z")))
    assertEquals("Оройн мэнд", Format.greeting(Instant.parse("2026-10-05T10:00:00Z")))
    assertEquals("99+", Format.badge(120))
  }

  @Test
  fun `a device was seen in words`() {
    val now = Instant.parse("2026-10-05T04:00:00Z")
    assertEquals("саяхан", Format.seen(now.minusSeconds(60), now))
    assertEquals("өнөөдөр 11:00", Format.seen(now.minusSeconds(3600), now))
    assertEquals("өчигдөр 12:00", Format.seen(now.minusSeconds(24 * 3600), now))
    assertEquals("10/1", Format.seen(Instant.parse("2026-10-01T04:00:00Z"), now))
  }

  @Test
  fun `an app shows its own pages and hands the rest to the browser`() {
    assertTrue(ServicePage.belongs("/idesh", "/idesh"))
    assertTrue(ServicePage.belongs("/idesh/stall/1", "/idesh"))
    assertTrue(ServicePage.belongs("/dine", "/idesh"))
    assertTrue(ServicePage.belongs("/terms", "/supplier"))
    assertFalse(ServicePage.belongs("/dashboard", "/idesh"))
    assertFalse(ServicePage.belongs("/idesh", "/supplier"))
    assertFalse(ServicePage.belongs("/ideshx", "/idesh"))
    assertTrue(ServicePage.staffOnly("/kds"))
    assertFalse(ServicePage.staffOnly("/kdsx"))
  }

  @Test
  fun `the avatar is the same mark on every device`() {
    val cells = seedCells("3f9a0d7e")
    assertEquals(16, cells.size)
    // Mirrored: a b b a on every row.
    for (row in 0 until 4) {
      assertEquals(cells[row * 4], cells[row * 4 + 3])
      assertEquals(cells[row * 4 + 1], cells[row * 4 + 2])
    }
    // 3, f (15), 9 and 0 are divisible by three: empty. d is the first of
    // thirteen or more that draws: the accent. e comes after it: the ink.
    assertNull(cells[0].colour)
    assertNull(cells[1].colour)
    assertEquals(BasuColor.ink, cells[5].colour)
    assertEquals(BasuColor.accent, cells[9].colour)
    assertEquals(BasuColor.ink2, cells[12].colour)
    assertEquals(BasuColor.ink, cells[13].colour)
    // At most one accent per mark (it is mirrored, so two cells).
    assertEquals(2, cells.count { it.colour == BasuColor.accent })
  }

  @Test
  fun `a lunch maps onto the card`() {
    val order = LiveOrder.from(
      JSONObject(
        """{"id":"o1","code":"7001","state":"ACCEPTED","restaurant":{"id":"r","name":"Алтан Тавган"},
           "table":null,"total_mnt":18500,"party_size":2,
           "slot_starts_at":"2026-10-05T04:30:00.000Z","fire_at":"2026-10-05T04:21:00Z","ready_at":null}""",
      ),
    )
    val item = order.asLiveItem(expanded = true)
    assertEquals("Баталгаажлаа", item.word)
    assertEquals("12:21", item.whenText)
    assertEquals("ГАЛ", item.timeLabel)
    assertEquals(1, item.step)
    assertEquals("Гал тавих цаг", item.extra?.first)
    assertFalse(item.finished)
    assertEquals(OrderState.PLACED, OrderState.from("SOMETHING_NEW"))
  }

  @Test
  fun `a sheep maps onto the same card`() {
    val idesh = LiveIdesh("i1", "9001", IdeshState.PREPARING, VenueRef("s", "Хангай"), "sheep", "Хонины мах, кг-аар", 10, "kg", 250000, "pickup", "2026-11-03")
    assertEquals("Хонины мах", idesh.meat)
    assertEquals("10 кг", idesh.amount)
    assertEquals(2, idesh.step)
    val item = idesh.asLiveItem()
    assertEquals("Хонины мах · 10 кг", item.headline)
    assertEquals("11/3", item.whenText)
    assertEquals("АВАХ", item.timeLabel)
    assertEquals(LiveItem.Tone.Plain, item.tone)
    val cancelled = idesh.copy(state = IdeshState.CANCELLED).asLiveItem()
    assertEquals("—", cancelled.whenText)
    assertEquals(0, cancelled.step)
    assertTrue(cancelled.finished)
    assertEquals(LiveItem.Tone.Stop, cancelled.tone)
  }

  @Test
  fun `a refused top-up is remembered for a day`() {
    val now = 1_000_000_000_000L
    assertFalse(Platform.refusalRemembered(null, now))
    assertTrue(Platform.refusalRemembered(now - 60_000, now))
    assertFalse(Platform.refusalRemembered(now - 25 * 60 * 60 * 1000L, now))
  }
}
