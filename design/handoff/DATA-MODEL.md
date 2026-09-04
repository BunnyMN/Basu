# Data model & contracts

All ids are opaque strings. All timestamps are ISO 8601 with offset. All money is integer MNT — never a float, never a formatted string from the server.

## Models

```swift
public struct Account: Codable, Sendable {
    public let id: String          // 8 hex chars — the avatar seed, e.g. "3f8c1a92"
    public var name: String        // "Батаа"
    public var phone: String       // "+976 9900 1122"
    public let joined: Date
    public var locale: String      // "mn"
}

public enum ServiceBand: String, Codable, Sendable { case daily, other }

public struct Service: Codable, Sendable, Identifiable {
    public let id: String          // "food", "taxi", "delivery", "tickets", "bills", "shops", "internet", "pharmacy", "coffee"
    public let name: String        // "Хоол"
    public let tag: String         // "урьдчилсан"
    public let band: ServiceBand
    public let sortIndex: Int      // registry order; the grid honours it exactly
    public let iconName: String    // asset name, e.g. "food-tile"
    public let enabled: Bool
}

public enum OrderStage: String, Codable, Sendable { case waiting, cooking, ready }

public struct Order: Codable, Sendable, Identifiable {
    public let id: String
    public let serviceID: String
    public let number: String      // "№0971"
    public let venueName: String   // "Алтан Тавган"
    public let partySize: Int
    public var stage: OrderStage
    public var stageLabel: String  // server-supplied, localised: "Гал дээр гарлаа"
    public var seatingTime: Date
    public var fireTime: Date?     // only meaningful for food
    public var amount: Int?        // MNT, once charged
    public var cancellable: Bool
}

public enum WalletTxKind: String, Codable, Sendable { case topup, order, refund }

public struct WalletTx: Codable, Sendable, Identifiable {
    public let id: String
    public let kind: WalletTxKind
    public let title: String       // "Цэнэглэлт" / "Захиалга" / "Буцаалт"
    public let source: String      // "Basu" / "Хоол · Модерн Номадс №0971"
    public let amount: Int         // signed MNT: +50000, -18500
    public let at: Date
}

public enum NotificationChannel: String, Codable, Sendable { case app, sms }

public struct AppNotification: Codable, Sendable, Identifiable {
    public let id: String
    public let serviceID: String?  // nil for Basu's own messages
    public let sourceLabel: String // "ХООЛ" / "BASU"
    public let channel: NotificationChannel
    public let title: String
    public let body: String
    public let at: Date
    public var read: Bool
}

public struct NotificationPrefs: Codable, Sendable {
    public var inApp: Bool         // "Аппаар"
    public var sms: Bool           // "Мессежээр"
    public var promos: Bool        // "Урамшуулал"
    // Order-progress notifications are NOT here. They cannot be disabled.
}
```

## Endpoints

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/v1/me` | `Account` |
| `PATCH` | `/v1/me` | `Account` — name, locale |
| `GET` | `/v1/services` | `[Service]` — the registry; drives the grid and its bands |
| `GET` | `/v1/wallet` | `{ balance: Int, transactions: [WalletTx] }` |
| `POST` | `/v1/wallet/topup` | `{ amount: Int }` → `{ balance: Int }` |
| `GET` | `/v1/orders/live` | `[Order]` |
| `GET` | `/v1/orders/{id}` | `Order` |
| `GET` | `/v1/notifications` | `[AppNotification]` |
| `POST` | `/v1/notifications/{id}/read` | 204 |
| `DELETE` | `/v1/notifications/{id}` | 204 — the swipe action |
| `GET`/`PUT` | `/v1/notifications/prefs` | `NotificationPrefs` |
| `POST` | `/v1/activities/{orderID}/token` | 204 — ActivityKit push token registration |

Top-up amounts offered in the UI are 20,000 / 50,000 / 100,000₮. They are UI constants, not server config, unless `/v1/wallet` starts returning them.

## Live Activity push payload

```json
{
  "aps": {
    "timestamp": 1788500000,
    "event": "update",
    "content-state": {
      "stage": "cooking",
      "stageLabel": "Гал дээр гарлаа",
      "seatingTime": "2026-09-04T11:30:00+08:00",
      "fireTime": "2026-09-04T11:15:00+08:00"
    },
    "alert": {
      "title": "Гал дээр гарлаа",
      "body": "Цуцлах боломжгүй боллоо."
    },
    "stale-date": 1788503400,
    "relevance-score": 100
  }
}
```

`event: "end"` with a `dismissal-date` when the party is seated. The app must also end the activity locally if it learns of seating first.

## Formatting

- Money: grouped by thousands with a comma, then `₮` in the sans face — `70,000₮`. Debits use a real minus sign `−` (U+2212), not a hyphen.
- Times: `HH:mm`, 24-hour, mono tabular. Same-day only; anything older than today shows `M/d` instead.
- Badge: the exact count to 99, then `99+`.
- Avatar: see `README.md` §Avatar marks for the deterministic algorithm. It is derived from `Account.id` — there is no upload and no image storage.
