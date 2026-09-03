import Foundation
import Testing

@testable import Basu

/**
 Profile, wallet and inbox: the payloads, and the two places the phone puts an
 opinion on top of them.

 The fixtures are real responses from `/v1/me`, `/v1/wallet` and
 `/v1/notifications`. What they catch is the failure with no other alarm — a
 renamed field showing up as a balance of zero, which looks exactly like an
 empty wallet and is a very different thing to be told.
 */
struct PlatformTests {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      guard let date = ISODate.parse(text) else {
        throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: text))
      }
      return date
    }
    return try decoder.decode(type, from: Data(json.utf8))
  }

  // MARK: - the launcher's one call

  @Test func meCarriesProfileBalanceAndUnreadTogether() throws {
    let me = try decode(Me.self, """
      {
        "id": "0f9b1f5c-7d3a-4a0f-9d21-8f2b1c0e4a55",
        "phone": "+97699001122",
        "display_name": "Батаа",
        "locale": "mn",
        "avatar_seed": "3f8c1a92",
        "member_since": "2026-08-14T02:11:04.000Z",
        "wallet": { "balance_mnt": 31500, "currency": "MNT" },
        "unread": 2
      }
      """)

    #expect(me.displayName == "Батаа")
    #expect(me.wallet.balanceMnt == 31500)
    #expect(me.unread == 2)
    #expect(me.greeting == "Сайн байна уу, Батаа")
  }

  @Test func aGuestWithNoNameIsStillGreetedByName() throws {
    let me = try decode(Me.self, """
      {
        "id": "0f9b1f5c-7d3a-4a0f-9d21-8f2b1c0e4a55",
        "phone": "+97699001122",
        "display_name": null,
        "locale": "mn",
        "avatar_seed": "00112233",
        "member_since": "2026-08-14T02:11:04.000Z",
        "wallet": { "balance_mnt": 0, "currency": "MNT" },
        "unread": 0
      }
      """)

    // Never the phone number, and never an empty comma.
    #expect(me.greeting == "Сайн байна уу")
    #expect(!me.greeting.contains("976"))
  }

  // MARK: - the statement

  @Test func theStatementReadsFromTheGuestsSideOfTheLedger() throws {
    let statement = try decode(WalletStatement.self, """
      {
        "balance_mnt": 31500,
        "currency": "MNT",
        "lines": [
          {
            "id": "8f1c5e2a-0b44-4d7f-8f10-2c9a7b6d5e31",
            "kind": "purchase",
            "amount_mnt": -18500,
            "subject": "order",
            "subject_id": "38ecb474-7c42-471b-88b4-04b12a054a27",
            "memo": null,
            "at": "2026-09-02T04:22:10.482Z"
          },
          {
            "id": "1b2c3d4e-5f60-4718-9a0b-1c2d3e4f5061",
            "kind": "topup",
            "amount_mnt": 50000,
            "subject": "topup",
            "subject_id": "9a8b7c6d-5e4f-4031-8271-6a5b4c3d2e1f",
            "memo": "qpay",
            "at": "2026-09-01T23:58:00.000Z"
          }
        ]
      }
      """)

    #expect(statement.balanceMnt == 31500)
    #expect(statement.lines.first?.amountMnt == -18500)
    #expect(statement.lines.first?.title == "Захиалга")
    #expect(statement.lines.last?.title == "Цэнэглэлт")
  }

  @Test func anUnknownKindOfMovementStillHasAName() throws {
    // The ledger is allowed to grow a movement type without a client release.
    let line = try decode(WalletLine.self, """
      {
        "id": "1b2c3d4e-5f60-4718-9a0b-1c2d3e4f5061",
        "kind": "cashback",
        "amount_mnt": 1200,
        "subject": null, "subject_id": null, "memo": null,
        "at": "2026-09-01T23:58:00.000Z"
      }
      """)
    #expect(line.title == "Гүйлгээ")
  }

  @Test func signedMoneyReadsDownAColumn() {
    #expect(Format.signedMnt(50_000) == "+50,000₮")
    #expect(Format.signedMnt(-18_500) == "−18,500₮")
    // A real minus sign, not a hyphen: they sit at different heights.
    #expect(Format.signedMnt(-1).hasPrefix("\u{2212}"))
  }

  // MARK: - the inbox

  @Test func theInboxKnowsWhatHasNotBeenRead() throws {
    let inbox = try decode(Inbox.self, """
      {
        "unread": 1,
        "messages": [
          {
            "id": "aa11bb22-cc33-4d44-8e55-ff6600112233",
            "title": "Та замд гарсан уу?",
            "body": "Та замд гарсан уу? 1 = Тийм · 2 = 10 минут хойшлуул",
            "template": "arrival.arm",
            "subject": "order",
            "subject_id": "38ecb474-7c42-471b-88b4-04b12a054a27",
            "channel": "sms",
            "state": "sent",
            "at": "2026-09-02T04:14:00.000Z",
            "read": false
          }
        ]
      }
      """)

    #expect(inbox.unread == 1)
    #expect(inbox.messages.first?.read == false)
    #expect(inbox.messages.first?.channel == "sms")
  }

  @Test func aMessageWithNoTitleStillDecodes() throws {
    // Older rows predate the title column; a nil there is a heading, not a crash.
    let message = try decode(InboxMessage.self, """
      {
        "id": "aa11bb22-cc33-4d44-8e55-ff6600112233",
        "title": null,
        "body": "Таны хоол гал дээр гарлаа.",
        "template": "order.cooking",
        "subject": "order",
        "subject_id": null,
        "channel": "push",
        "state": "queued",
        "at": "2026-09-02T04:14:00.000Z",
        "read": true
      }
      """)
    #expect(message.title == nil)
    #expect(message.body.hasPrefix("Таны хоол"))
  }

  @Test func preferencesDefaultToTransactionalOnlyWhenNothingIsSaved() {
    #expect(NotifyPreferences.default.push)
    #expect(NotifyPreferences.default.sms)
    // Marketing is the one that has to be asked for.
    #expect(!NotifyPreferences.default.marketing)
  }
}
