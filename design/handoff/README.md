# Handoff: Basu — launcher shell, wallet, notifications, profile

## Overview

Basu is a Mongolian-language super-app shell for iOS. It launches other services (food pre-order first, more later), holds a shared wallet balance, and collects notifications from every service into one list. This handoff covers the shell only: the splash, the launcher at three stages of growth (1, 4 and 9 app icons), the wallet, notifications (populated and empty) and profile, the Live Activity and Dynamic Island, the Home Screen widgets, plus the icon system, avatar marks and the bell badge.

Everything is specified in both light and dark theme, at 402 × 874 pt (iPhone 16 logical size).

## About the design files

`Basu Shell.dc.html` in this folder is a **design reference created in HTML** — a prototype showing intended look, copy and behaviour. It is not production code to copy. The task is to recreate these screens in the target codebase's own environment (SwiftUI is the natural target here, since the design is drawn to iOS metrics and uses SF Symbols conventions) using its established patterns, components and libraries. If no environment exists yet, pick the framework and implement there.

`support.js` is the runtime the prototype needs to open in a browser. It is not part of the design; ignore it when implementing.

Open the HTML file directly in a browser to see all twenty-two artboards on one pannable canvas. Each artboard has a caption above it and, on the light/dark sections, an annotation below it explaining why the screen is built that way.

## Fidelity

**High-fidelity.** Colours, type sizes, weights, spacing, radii and copy are final and should be matched. Two substitutions were made because the browser cannot use Apple's fonts:

| Design intends | Prototype uses | On implementation |
| --- | --- | --- |
| SF Pro Text / Display | Golos Text | Golos Text is the intended face — it carries Cyrillic and is drawn for screen. Ship it. |
| SF Mono | JetBrains Mono | Intended for all numerals and labels. Ship it. |

The Хоол tile is a supplied raster render (`food-tile.png`), full-bleed at radius 18 with no inner margin; so is the Идэш tile (`idesh-tile.png`), composed onto the same off-white ground. The remaining tiles are hand-drawn SVG at SF Symbols' metrics. Where an SF Symbol exists for the same object, prefer the symbol.

All copy is Mongolian Cyrillic and is final — do not translate or rewrite it.

---

## Design tokens

Both themes are authored independently. Dark is not an inversion of light; the values below are the source of truth.

### Colour

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `ground` | `#EFF1F2` → `#E9EBEC` → `#DFE3E4`, linear-gradient 176° at 0/46/100% | `#141B1E` → `#0E1315` → `#0A0E10`, same stops | Screen background. The wash exists so translucent surfaces have something to be translucent against. |
| `surface` | `rgba(255,255,255,.62)` | `rgba(22,29,32,.58)` | Cards, icon tiles, tab bar |
| `surface2` | `rgba(243,245,246,.55)` | `rgba(28,36,40,.50)` | Search field, avatar plate |
| `ink` | `#14181B` | `#E7ECED` | Primary text, numbers |
| `ink2` | `#4A555C` | `#A2B0B6` | Secondary text, body copy |
| `ink3` | `#78868E` | `#6E7E85` | Labels, timestamps, tags |
| `line` | `#D2D8DA` | `#283236` | Hairlines, card borders |
| `line2` | `#C0C8CB` | `#374348` | Stronger borders, device edge |
| `accent` | `#C64E08` | `#FF8A3D` | The one brand colour. Links, active tab, icons, badge |
| `accentSoft` | `#FAE7DA` | `#33200F` | Reserved; unused in these screens |
| `onAccent` | `#FFFFFF` | `#160B03` | Text on accent fills |
| `ready` | `#136A4B` | `#57C295` | Credit amounts |
| `hold` | `#7E6113` | `#DAB65A` | Waiting-state dot |
| `stop` | `#9B2226` | `#F08A8D` | Sign-out |
| `route` | `#1B5B8F` | `#78B0E0` | In-transit dot |
| `shadow` | `rgba(20,24,27,.05)` | `rgba(0,0,0,.4)` | Icon tile shadow, y1 blur2 |

**Material.** Every surface is translucent over a backdrop blur of `8px` with `saturate(1.05)` — SwiftUI `.ultraThinMaterial`. The 1pt hairline stays on top of the blur; it is what keeps edges legible. No tint, no second colour, no gradient on any card.

### Type

Sizes are pt. Numbers are always mono with tabular figures; the ₮ sign is set in the sans face with `0.1em` leading space, because the mono face has no glyph for it and collides with the last digit.

| Role | Face | Size / weight / leading | Tracking |
| --- | --- | --- | --- |
| Screen title (Мэдэгдэл) | Sans | 28 / 600 / 1.15 | −0.02em |
| Wallet balance | Mono | 48 / 600 / 1 | −0.02em |
| Brand (Basu) | Sans | 27 / 600 / 1 | −0.025em |
| Profile name | Sans | 24 / 600 / 1.15 | −0.02em |
| LIVE time | Mono | 23 / 600 / 1 | — |
| Greeting | Sans | 17 / 400 / 1.35 | — |
| LIVE title, notification title | Sans | 15.5 / 600 / 1.25 | — |
| Notification title, read | Sans | 15.5 / 400 / 1.35 | — |
| List row, settings row | Sans | 15 / 400–500 / 1.3 | — |
| Status-bar clock, transaction amount | Mono | 15 / 600 / 1 | — |
| Nav link (Basu ‹) | Sans | 15 / 500 / 1 | — |
| App name | Sans | 13 / 600 / 1.25 | — |
| Body copy | Sans | 13–14 / 400 / 1.5–1.6 | — |
| Inline action (Дэлгэрэнгүй) | Sans | 13 / 500 / 1.2 | — |
| Meta, timestamps | Mono | 11–11.5 / 400 / 1.3–1.4 | — |
| Section label (ТҮРИЙВЧ) | Mono | 10 / 500 / 1 | 0.16em, uppercase |
| Tab label | Sans | 10 / 500–600 / 1.2 | — |
| Source label (ХООЛ) | Mono | 9.5 / 500 / 1 | 0.14em |
| App tag | Mono | 9.5 / 400 / 1.3 | — |
| Badge count | Mono | 9.5 / 600 / 1 | — |
| Channel chip (SMS) | Mono | 9 / 500 / 1 | 0.12em |

Body copy uses `text-wrap: pretty`. App names wrap rather than truncate at larger Dynamic Type.

### Geometry

- Radius: **12** on cards and rows, **18** on app icon tiles, **28%** on avatar plates, **8** on the badge pill, **16** on the switch track, **2** on the channel chip.
- Screen padding: **20** horizontal.
- Status bar: **54** tall, clock at 30 from the left edge.
- Tab bar: **78** tall, `1px` top hairline, content padded **10** from its top.
- Content area: bottom padding **82** so nothing sits under the bar.
- Hairline: always **1px** `line`.
- Home indicator: 140 × 5, radius 3, `ink` at 28% opacity, 9 from the bottom.

---

## Screens

### 0. Splash

Shown for the length of launch, then the launcher fades in behind it. Contents, centred on the ground gradient: the wordmark `Basu` at 44/600 tracked −0.03em in `ink`; a 34 × 2 accent rule below it, radius 1, gap 14; and `УЛААНБААТАР` in mono 10.5 tracked 0.16em `ink3` pinned 44 from the bottom. The 54pt status bar is present, as on every other screen. No logo file, no spinner, no progress text.

### 1. Launcher (Нүүр)

The default screen. Three artboards show it at 1, 4 and 9 icons — same structure, different content, to prove it holds up as the product grows.

**Layout**, top to bottom inside 20pt side padding, gap 9:

1. **Header block**: `Basu` at 27/600 on the left, the bell alone on the right. No city label, no greeting, no avatar — all three were cut.
2. **ИДЭВХТЭЙ (live) section**: one card containing everything. The `ИДЭВХТЭЙ` label sits inside it at padding 11 × 14 (10 at the bottom); rows follow, each separated by a 1pt `line` top border, padding 11 × 14. Rows are not individual cards.
3. **App grid section**, gap 9.

**Bell.** 26 × 26, stroke 1.6 in `ink`. Badge is a **15pt-tall pill** (not a circle), min-width 15, horizontal padding 4, radius 8, `accent` fill, `onAccent` mono 9.5 tabular. Positioned `top: −3, right: −5` so it grows rightward from its own left edge and the bell never shifts. Three digits become `99+`.

**Avatar.** 30 × 30 on the launcher, 54 × 54 on profile. See *Avatar marks* below.

**LIVE row.** A card, padding 9 × 14, gap 9.
- Header line, `space-between`: left is a wrapping flex run (gap 4 × 8) of — a 6pt status dot, the source label (`ХООЛ`, `ТАКСИ`), the title at 15.5/600, and the meta in mono 11.5 `ink3`. Right is a baseline-aligned pair: the label (`СУУХ`, `ИРЭХ`) in mono 9/500 tracked 0.14em, then the time at 23/600 mono.
- Optional second line, only when a single row is on screen: separated by a top hairline with 9pt padding, `space-between`, description at 12.5/400 `ink2` on the left, time at 12.5/600 mono `accent` on the right.
- Dot colour: `hold` for waiting, `route` for in transit.

Rows are ordered by the moment that matters, not by which app produced them.

**App grid.** Bands, each with a label row (min-height 22) and a grid.
- Grid: `repeat(auto-fill, minmax(92px, 1fr))`, gap 10 vertical / 14 horizontal — three columns at 402pt.
- Tile: square, max 92, `surface` + blur, 1pt `line`, radius 18, shadow y1 b2. Glyph 34, stroke 1.6, `accent`.
- Under the tile, gap 6: name (13/600 `ink`) over tag (mono 9.5 `ink3`).

**Band rules that must be preserved:**
- Bands are **editorial, fixed by the product** — `АППУУД` when few; `ӨДӨР ТУТАМ` / `БУСАД` from nine on.
- **No folders and no most-recently-used reordering.** A grid that rearranges itself cannot be learned by thumb. Recency belongs to the LIVE section, which sits above the grid already.
- A **search field appears at seven or more icons**, inline on the first band's label row: `surface2` + blur, 1pt `line`, radius 12, padding 5 × 9, 13pt magnifier + `Хайх` in mono 12 `ink3`.
- With one icon only, the coming-soon line is **a hairline and one line of type** (`Такси, хүргэлт, тасалбар — 2026 оны төгсгөлд`, mono 11.5 `ink3`), never an empty placeholder card.

### 2. Wallet (Түрийвч)

Reached from the tab bar. Nav title `Түрийвч` at 28/600, padding 2 × 20 × 16.

- **Balance block**, gap 12: `70,000₮` at 48/600 mono tabular; then one explanatory sentence at 13.5/400 `ink2`, max 30ch — `Хоолны төлбөр эндээс хасагдана. Дутвал зөрүүг нь л асууна.`
- **ЦЭНЭГЛЭХ**: three equal top-up amounts in a `repeat(3, 1fr)` grid, gap 10. Each is a card, padding 15 × 6, centred mono 14/600.
- **ГҮЙЛГЭЭ**: rows separated by top hairlines, padding 14 vertical. Left column is kind (15/500) over source (mono 11.5 `ink3`) — the source names the app the transaction came from, e.g. `Хоол · Модерн Номадс №0971`. Right column is amount (mono 15/600, `ready` for credits, `ink` for debits, real minus sign `−`) over time (mono 11 `ink3`).

### 3. Notifications (Мэдэгдэл)

Two artboards: populated and empty.

- Nav bar: a three-column grid — 20pt back chevron in `accent` on the left, `Мэдэгдэл` centred at 17/600, right cell empty. Padding 4 × 20 × 18. There is no mark-all-read action.
- Rows: top hairline, padding 16 × 12, gap 12, inside a wrapper with `margin: 0 -12px`, radius 12 and `overflow: hidden`.
- **Unread** is a muted blue wash across the row — `unread` = `#E4EDF5` light / `#16232E` dark — plus the heavier title. No dot, and the accent is reserved for the bell badge.
- **Swipe left** on a row reveals `Устгах`: an 88pt-wide `stop`-filled button pinned to the row's right edge, label 14/500 in `onStop` (`#FFFFFF` light / `#2A0B0C` dark). The row's own right padding goes to 100 while open so text truncates rather than sliding out of the clip box. Shown open on the third row of the populated artboard.
- Row content, gap 7: header line with source label + channel chip on the left and time on the right; title (600 when unread, 400 `ink2` when read); body at 13/400 `ink2`.
- **Channel chip** is a separate fact from the source: `SMS` or `АПП`, mono 9/500 tracked 0.12em, 1pt `line2` border, radius 2, padding 3 × 5. Source says where it came from; channel says where to look for it.
- **Empty state** is a paragraph on the ground colour under the same hairline, max 32ch, 14/400 `ink2`. No illustration, no card, no button.

### 4. Profile (Профайл)

- Nav title `Профайл` at 28/600, padding 2 × 20 × 16.
- Identity row, gap 16: 54pt avatar; name 24/600; phone in mono 14 `ink2`; a line of provenance at 11.5/400 `ink3` — `Basu-д 2026 оны 8-р сараас хойш · 3f8c1a92`.
- Fields card: two rows (`Нэр`, `Хэл`), padding 14 × 16, hairline between. Label left in `ink2`, value right in `ink` 500 followed by a 13pt chevron in `ink3`.
- **МЭДЭГДЭЛ** card: three switch rows — `Аппаар` (on), `Мессежээр` (on), `Урамшуулал` (off). Track 51 × 31, radius 16, `accent` when on and `line2` when off, 2pt inset, knob 27 white with `0 1px 2px rgba(0,0,0,.2)`.
- Below the card, at 12/400 `ink3`: order-progress notifications cannot be switched off, and the copy says why — `Захиалгын явцын мэдэгдлийг унтраах боломжгүй — гал тавих мөчийг мэдэхгүй бол урьдчилсан захиалга утгагүй болно.`
- Sign-out: full-width card, padding 15, centred `Гарах` at 15/500 in `stop`.

### 5. Tab bar (all screens)

Three items — home, wallet, profile — pinned to the bottom, `surface` + blur, 1pt top hairline, **66 tall**, content padded 14 from its top. Each item is a **25pt stroked glyph, icon only** — the labels were removed — in `accent` when active and `ink3` when not. Items are equal-width thirds; the tap target is the full third × 44 minimum.

The bar carries the shell only. Apps are never tabs — they stay in the grid.

> **Open trade-off.** The launcher used to carry a wallet strip showing the balance. It was removed when the tab bar landed: at nine icons there was no room for both, and the strip and the tab were the same tap twice. The balance is now one tap away rather than visible on arrival, which is a departure from the original brief's "visible before any app is opened". If that requirement holds, restore the strip and let the grid scroll under the bar.

---

## Icon system

The **Хоол** tile is a supplied raster render, `food-tile.png` — full-bleed inside the 92pt tile at radius 18, no inner margin, no plate border. It sets the direction for the rest; the drawn glyphs below are the current stand-ins and the rules still govern them.

Six glyphs shipped, three more drawn to prove the rule (see the icon sheet at the bottom of the prototype).

**Stroke rules**

- `viewBox` 24 × 24, optical padding 2; the mark lives inside a Ø18 keyline circle.
- Stroke 1.6, round caps, round joins. No fills, no gradients.
- Accent colour only. Never two colours in one glyph.
- Two to four elements. Five means the idea is wrong, not the drawing.
- At most one element may move: ±1.4pt over 3s, opacity .55 → 1. Only the food bowl's steam moves today.
- Plan view or elevation, one per glyph. No perspective.

**Grid metrics**

- Tile 92 × 92 minimum, radius 18 continuous, `surface`, 1pt line, shadow y1 b2.
- Columns `minmax(92, 1fr)`; gap 10 × 14; glyph 34.
- Name 13/600, wraps at Dynamic Type and never truncates. Tag mono 9.5 `ink3`, one word, lower case.

**Drawing the seventh**

1. Name the object, not the action: a bowl, a roof sign, a box. If the noun cannot be drawn in four strokes, the app has the wrong icon.
2. Start from the Ø18 keyline circle. A round glyph touches it; a square one stops 1pt inside it, so the two read at the same weight.
3. Draw at 24, check at 34 and 44. If a detail closes up at 34, remove it — do not thin the stroke.
4. Motion is reserved for a state the app is in, not for delight. Steam moves because a kitchen is hot; a parked taxi does not move.
5. Test beside the bowl and one other glyph. New glyphs fail next to their neighbours, not on their own.
6. The tag under the tile carries specificity. If a glyph needs a second element to say "pre-order", the tag was already doing that job.

## Avatar marks

Generated from the account's eight hex characters — no upload, no storage, no moderation queue.

- Plate: `surface2`, 1pt `line`, radius 28%, padding 12%, a 4 × 4 grid with 9% gaps.
- One cell per hex character, four characters down the left half; the **right half mirrors the left**.
- A value divisible by three leaves its cell empty. Odd values are circles, even values are 1pt-radius squares.
- Value ≥ 8 uses `ink`, below 8 uses `ink2`. The **first** value ≥ 13 takes `accent`; at most one accent cell per avatar.

Symmetry keeps it from reading as noise at 54pt; the empty cells are what make two accounts tellable apart. Six seeds are rendered on the sheet as a spot check.

---

### 6. Live Activity (ActivityKit)

One activity per order, started when the order is confirmed and ended when the party is seated or the order is cancelled. It is not a notification.

**Lock screen card.** Full-width less 14pt side margin, `lockCard` (white at 12%) over an 18pt blur, 1pt `lockLine` border, radius 22, padding 16 × 18, gap 14.

- Header row: 30pt app icon at radius 8; venue at 15/600; `№0971 · 2 хүн` in mono 11.5 `onLock2`. Right side is the seating time at 26/600 mono over `СУУХ` in mono 9 tracked 0.14em.
- Below, gap 7: a **three-segment bar** — three equal 3pt bars, gap 4, radius 2, filled in `accent` up to the current stage and `lockTrack` beyond it. The three segments are the order's only states (Хүлээгдэж байна / Гал дээр / Ширээ бэлэн), so no percentage is ever computed or shown.
- Under the bar: the stage label at 12.5/500 on the left, the fire time at 12.5/600 mono `accent` on the right.

The seating time is the largest element on the card because it is the only number the user acts on.

**Dynamic Island.**

- *Compact*: 37pt pill, radius 19, black. 22pt icon at radius 6 leading, seating time at 15/600 mono trailing.
- *Expanded*: radius 40, black, padding 18 × 20 × 20, gap 15. Same facts as the lock screen card — 34pt icon, venue at 15/600, stage label in mono 11.5 `#8E9AA0`, seating time at 28/600 mono over `СУУХ`, then the three-segment bar with `#2B3236` as the empty track. It shows nothing the card doesn't.
- *Two activities*: the food activity keeps the wide compact slot and the other collapses to a 37pt circular glyph. Whichever is nearer in time takes the wide slot.

`staleDate` is seating time + 30 minutes. Updates arrive by push; see `DATA-MODEL.md` for the payload.

### 7. Home Screen widgets (WidgetKit)

Same timeline as the activity. Both sizes are `surface` + blur, 1pt `line`, radius 24, padding 16.

- **Medium (2 × 4)**, height 158: header row identical in structure to the activity card (28pt icon, venue 14.5/600, `№0971 · 2 хүн` mono 11) with the seating time at 30/600 mono over `СУУХ` on the right; the three-segment bar and the stage / fire-time line at the bottom. Empty track is `line2`.
- **Small (2 × 2)**, 158 × 158: 28pt icon at the top, then the seating time at 34/600 mono tracked −0.02em over `СУУХ · №0971` in mono 9. Nothing else.
- **Empty state** (no live order): the icon and one sentence — `Захиалга алга. Товшиж хоол сонгоно.` at 12.5/400 `ink2`. Never a zeroed layout.

Timeline entries at now, fire time, seating time, and seating + 15 minutes. Tap opens `basu://order/{id}`.

## Interactions & behaviour

Navigation is a flat three-tab shell. Tapping an app icon pushes that service; tapping a LIVE row opens the order it refers to; `Дэлгэрэнгүй`-style inline actions push the detail view. Back is a chevron + `Basu`, not a bare arrow.

- **Live rows** update in place. Adding a second row must not move anything above it.
- **Search** filters the grid within its bands; it appears at ≥ 7 icons and is hidden below that.
- **Mark all read** clears every dot and drops titles to 400 weight.
- **Motion**: the steam loop is 3s ease-in-out, infinite, and is the only ambient animation in the shell. Transitions elsewhere are the platform defaults.
- Minimum tap target 44 × 44 throughout, including the bell and the avatar.

## State

- `balance` — integer MNT; rendered grouped by thousands with `₮` appended.
- `liveOrders[]` — `{ source, title, meta, time, timeLabel, status }`; drives the ИДЭВХТЭЙ section and its ordering. Empty means the whole section is omitted, not shown blank.
- `apps[]` with a band assignment per app; band membership is product configuration, not user state.
- `unreadCount` — drives the bell badge; caps display at `99+`.
- `notifications[]` — `{ source, channel, time, title, body, read }`.
- `prefs` — three booleans; order-progress notifications are not among them and are not user-controllable.
- `accountId` — the eight hex characters the avatar is derived from.

## Assets

None to import. All icons are vector drawings specified above and should become SF Symbols or in-house vectors. No photography, no illustration, no logo file — the wordmark is type.

## Files

- `Basu Shell.dc.html` — all twenty-two artboards, both themes, plus the icon sheet, avatar marks and badge states. Open in a browser.
- `food-tile.png` — the Хоол app icon, 512 × 512, pre-rounded at radius 18/92.
- `support.js` — prototype runtime only; not part of the design.

## Implementation docs in this folder

- `CLAUDE.md` — read-me-first brief and the rules for this codebase.
- `ARCHITECTURE.md` — targets, module layout, stores, ActivityKit / WidgetKit setup, navigation, accessibility.
- `DATA-MODEL.md` — Swift models, endpoints, push payloads, formatting rules.
- `BUILD-PLAN.md` — eleven ordered steps, each with acceptance criteria.
- `DesignTokens.swift` — every colour, font role and metric as code. Drop it into `BasuKit`.
