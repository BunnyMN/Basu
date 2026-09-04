# Architecture

## Platform

- iOS 18.0 minimum. iPhone only, portrait only.
- SwiftUI, Swift 6, strict concurrency.
- No third-party dependencies.

## Xcode project layout

```
Basu.xcodeproj
├── Basu                        (app target, iOS 18)
│   ├── BasuApp.swift           @main, scene, deep links
│   ├── Shell/                  tab bar, launcher, routing
│   ├── Wallet/
│   ├── Notifications/
│   ├── Profile/
│   └── Resources/              Assets.xcassets, fonts, Localizable.strings (mn)
├── BasuKit                     (local Swift package — shared by app and widgets)
│   ├── Sources/BasuKit/
│   │   ├── DesignTokens.swift  ← supplied
│   │   ├── Models/             Order, Service, WalletTx, AppNotification, Account
│   │   ├── Store/              OrderStore, WalletStore, NotificationStore, ServiceRegistry
│   │   ├── Networking/         BasuAPI, endpoints, decoding
│   │   ├── Activity/           BasuActivityAttributes (ActivityKit)
│   │   └── Avatar/             AvatarMark.swift (deterministic mark generator)
│   └── Tests/
└── BasuWidgets                 (widget extension: WidgetKit + ActivityKit UI)
    ├── BasuWidgetBundle.swift
    ├── OrderWidget.swift       small + medium
    └── OrderLiveActivity.swift lock screen + Dynamic Island
```

**App Group** `group.mn.basu.shared` — required. The widget extension and the app both read the current order snapshot from it. Nothing else is shared through it.

## Module boundaries

- `BasuKit` owns models, stores, networking, tokens and the avatar generator. It imports nothing from the app.
- The app target owns all screens and navigation.
- `BasuWidgets` imports `BasuKit` for tokens and `BasuActivityAttributes`. It never talks to the network — it renders whatever the timeline / activity gives it.

## State

Observable stores, injected through the environment, one per domain:

| Store | Owns | Persistence |
| --- | --- | --- |
| `ServiceRegistry` | the app grid: which services exist, their band, their order | remote config, cached to disk |
| `OrderStore` | live orders, their stage, their times | remote + App Group snapshot |
| `WalletStore` | balance, transactions | remote, no local cache of balance |
| `NotificationStore` | notification list, read state | remote, read state posted back |
| `AccountStore` | account id, name, phone, prefs | Keychain (token), UserDefaults (prefs) |

Rules:

- **Balance is never cached across launches.** It is fetched on appear; until it arrives, show the last known value greyed or nothing — never a zero.
- **Bands are configuration, not user state.** The user cannot reorder, and there are no folders. The grid must render in registry order, always.
- **The search field appears at ≥ 7 services** and is hidden below that. It filters within bands.
- Live order ordering is by the moment that matters (seating time, arrival time) — not by service, not by creation date.

## Navigation

Flat three-tab shell: home / wallet / profile. Icon-only tab bar, 66pt.

- Tapping a service icon presents that service's own flow (initially the food service; later ones are separate feature modules behind the same protocol).
- Tapping a live row opens the order it refers to.
- Wallet and Profile are tab roots with a nav title, not pushed screens. The Notifications screen is pushed from the bell and has a back chevron.
- Deep links: `basu://order/{id}`, `basu://wallet`, `basu://notifications`. The Live Activity and both widgets link to `basu://order/{id}`.

## Service plug-in protocol

Services arrive over time (food now; taxi, delivery, tickets, bills, shops, internet, pharmacy, coffee later). Define them once:

```swift
public protocol BasuService: Identifiable, Sendable {
    var id: ServiceID { get }          // "food", "taxi", …
    var name: String { get }           // "Хоол" — localised, from registry
    var tag: String { get }            // "урьдчилсан"
    var band: ServiceBand { get }      // .daily / .other
    var icon: ServiceIcon { get }      // .raster("food-tile") or .symbol(...)
    func rootView() -> AnyView
}
```

Adding a service must not require touching the launcher, the LIVE section, the widget, or the tab bar.

## ActivityKit (Live Activity)

One activity per order, in `BasuKit/Activity`:

```swift
public struct BasuActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var stage: OrderStage        // .waiting / .cooking / .ready
        public var seatingTime: Date
        public var fireTime: Date?
        public var stageLabel: String       // "Гал дээр гарлаа"
    }
    public var orderID: String
    public var venueName: String           // "Алтан Тавган"
    public var partySize: Int
    public var orderNumber: String         // "№0971"
    public var serviceID: String           // "food"
}
```

- **Start** when the order is confirmed; **end** when the party is seated or the order is cancelled. `staleDate` = seating time + 30 min.
- Updates come by **push** (`pushType: .token`); register the token with the backend on start. Do not poll.
- Three stages drive a three-segment bar, so no percentage is ever computed or shown.
- Lock screen card, Dynamic Island compact and expanded, and minimal are all specified in `README.md` §Live Activity. The expanded view shows nothing the lock screen card doesn't.
- With two activities live, the food activity keeps the wide compact slot and the other collapses to its glyph; whichever is **nearer in time** takes the wide slot.

## WidgetKit

`OrderWidget`, small (`systemSmall`) and medium (`systemMedium`), same timeline:

- Timeline entries at: now, fire time, seating time, and seating + 15 min (the reset to empty).
- Reads the order snapshot from the App Group; the app writes that snapshot on every order change.
- Empty state is a sentence — `Захиалга алга. Товшиж хоол сонгоно.` — not a zeroed layout.
- `.widgetURL(URL(string: "basu://order/\(id)"))`.
- Both sizes are specified in `README.md` §Widgets.

## Networking

`BasuAPI` is an actor. `async/await`, `URLSession`, no Combine. Bearer token from the Keychain, refreshed on 401. All decoding through `Codable` models in `BasuKit/Models`. See `DATA-MODEL.md` for endpoints and payloads.

Failure rules:

- A failed balance fetch shows the wallet screen with the balance omitted and a retry affordance — never a zero.
- A failed order fetch does not hide a live order that is already known; the last snapshot stands with its own timestamp.
- Order-progress notifications cannot be disabled. Enforce that server-side too, not only in the UI.

## Fonts

Golos Text and JetBrains Mono, both SIL OFL. Bundle the variable or static weights 400/500/600 (700 is unused), register in `Info.plist` under `UIAppFonts`. `DesignTokens.swift` wires them to the roles.

## Accessibility

- Minimum tap target 44 × 44 everywhere, including the bell and the tab items.
- App names in the grid wrap; they never truncate.
- Numbers use tabular figures so they don't jitter as they change.
- The unread wash is not the only unread signal — the heavier title carries it too.
- Every tab item, icon tile and live row needs an explicit `accessibilityLabel`; the tab bar is icon-only, so its labels are the only thing VoiceOver has.
