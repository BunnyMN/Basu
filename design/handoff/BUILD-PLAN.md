# Build plan

Ordered. Each step is a commit with its acceptance criteria met. Don't skip ahead — later steps assume the earlier ones.

## 1. Project skeleton

Create the app target, the `BasuKit` package and the `BasuWidgets` extension per `ARCHITECTURE.md`. Add the App Group. Bundle Golos Text and JetBrains Mono. Drop in `DesignTokens.swift` and `food-tile.png`.

**Done when:** the app builds and launches to an empty screen using `BasuColor.ground` as its background, in both light and dark, and `BasuFont.balance` renders JetBrains Mono.

## 2. Splash

**Done when:** wordmark at 44/600 tracked −0.03em, a 34 × 2 accent rule 14 below it, `УЛААНБААТАР` in mono 10.5 tracked 0.16em pinned 44 from the bottom, status bar visible, no spinner. It hands off to the launcher without a visible jump.

## 3. Tab shell

Icon-only bar, 66pt, three items, glass over content.

**Done when:** the bar matches the artboard in both themes; content insets 74–78 at the bottom so nothing hides under it; every item has a VoiceOver label; tap targets ≥ 44.

## 4. Launcher — grid and registry

`ServiceRegistry` + the grid. Header is `Basu` and the bell only.

**Done when:** 1, 4 and 9 services all render correctly from registry data alone; bands come from the registry; the search field appears at ≥ 7 and filters within bands; names wrap at XXL Dynamic Type without truncating; **no folders, no reordering, no most-recently-used float**; the Хоол tile is `food-tile.png`, full-bleed at radius 18 with no visible plate edge.

## 5. Launcher — LIVE section

One card: label inside at the top, hairline-separated rows.

**Done when:** with one live order the row shows its second line (fire time); with two, rows are ordered by the moment that matters and adding the second row does not move anything above it; with none, the whole card is absent — not an empty card.

## 6. Wallet

**Done when:** balance at 48/600 mono tabular with the ₮ in the sans face; the explanatory sentence renders below it; three top-up buttons; transactions with mono amounts, credits in `ready`, debits with U+2212; a failed fetch omits the balance rather than showing 0.

## 7. Notifications

**Done when:** nav is back chevron + centred 17/600 title with no right-hand action; unread rows carry the blue wash **and** the heavier title; source label and channel chip are both present on every row; swipe-left reveals `Устгах` at 88pt and deleting calls the endpoint; the empty state is the specified sentence with no illustration and no button.

## 8. Profile

**Done when:** avatar is generated from `Account.id` by the specified algorithm and is stable across launches; two field rows; three switches; the sentence explaining why order-progress notifications can't be switched off; `Гарах` in `stop`.

## 9. Live Activity

**Done when:** the activity starts on order confirmation and ends on seating or cancellation; the push token is registered; lock screen, compact, expanded and minimal all match their artboards; the three-segment bar shows stage without any percentage; two concurrent activities behave per the nearer-in-time rule; `staleDate` is seating + 30 min.

## 10. Widgets

**Done when:** small and medium match their artboards in both themes; the timeline has entries at now, fire time, seating time and seating + 15 min; the empty state is the sentence; tapping opens `basu://order/{id}`.

## 11. Pass

Run every screen at 402 × 874 in light and dark, at default and XXL Dynamic Type, with VoiceOver on. Compare against the artboards side by side. Check: no colour outside the token set, no radius outside {12, 18, 8, 16, 2, 24, 22, 19, 40}, every number mono and tabular, every ₮ in the sans face.

## Out of scope

The food service's own flow (menu, cart, checkout), onboarding, sign-in, and every service after food. This handoff is the shell they plug into.
