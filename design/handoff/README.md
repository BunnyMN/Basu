# Handoff: Basu — launcher shell, wallet, notifications, profile

## Overview

Basu is a Mongolian-language super-app shell for iOS. It launches other services (food pre-order first, more later), holds a shared wallet balance, and collects notifications from every service into one list. This handoff covers the shell only: the launcher at three stages of growth (1, 4 and 9 app icons), the wallet, notifications (populated and empty) and profile, plus the icon system, avatar marks and the bell badge.

Everything is specified in both light and dark theme, at 402 × 874 pt (iPhone 16 logical size).

## About the design files

`Basu Shell.dc.html` in this folder is a **design reference created in HTML** — a prototype showing intended look, copy and behaviour. It is not production code to copy. The task is to recreate these screens in the target codebase's own environment (SwiftUI is the natural target here, since the design is drawn to iOS metrics and uses SF Symbols conventions) using its established patterns, components and libraries. If no environment exists yet, pick the framework and implement there.

`support.js` is the runtime the prototype needs to open in a browser. It is not part of the design; ignore it when implementing.

Open the HTML file directly in a browser to see all fourteen artboards on one pannable canvas. Each artboard has a caption above it and, on the light/dark sections, an annotation below it explaining why the screen is built that way.

## Fidelity

**High-fidelity.** Colours, type sizes, weights, spacing, radii and copy are final and should be matched. Two substitutions were made because the browser cannot use Apple's fonts:

| Design intends | Prototype uses | On implementation |
| --- | --- | --- |
| SF Pro Text / Display | IBM Plex Sans | Use SF Pro (system font) |
| SF Mono | IBM Plex Mono | Use SF Mono |

The prototype's icons are hand-drawn SVG at SF Symbols' metrics. Where an SF Symbol exists for the same object, prefer the symbol.

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

- Radius: **4** on cards and rows, **18** on app icon tiles, **28%** on avatar plates, **8** on the badge pill, **16** on the switch track, **2** on the channel chip.
- Screen padding: **20** horizontal.
- Status bar: **54** tall, clock at 30 from the left edge.
- Tab bar: **78** tall, `1px` top hairline, content padded **10** from its top.
- Content area: bottom padding **82** so nothing sits under the bar.
- Hairline: always **1px** `line`.
- Home indicator: 140 × 5, radius 3, `ink` at 28% opacity, 9 from the bottom.

---

## Screens

### 1. Launcher (Нүүр)

The default screen. Three artboards show it at 1, 4 and 9 icons — same structure, different content, to prove it holds up as the product grows.

**Layout**, top to bottom inside 20pt side padding, gap 9:

1. **Header block**, gap 10.
   - Row: left column holds `УЛААНБААТАР` (section label) over `Basu` (27/600); right side holds the bell and avatar, gap 14, offset 4 from the top.
   - Below: greeting `Сайн байна уу, Батаа` at 17/400 in `ink2`.
2. **ИДЭВХТЭЙ (live) section**, label + rows, gap 7 / 6.
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
- A **search field appears at seven or more icons**, inline on the first band's label row: `surface2` + blur, 1pt `line`, radius 4, padding 5 × 9, 13pt magnifier + `Хайх` in mono 12 `ink3`.
- With one icon only, the coming-soon line is **a hairline and one line of type** (`Такси, хүргэлт, тасалбар — 2026 оны төгсгөлд`, mono 11.5 `ink3`), never an empty placeholder card.

### 2. Wallet (Түрийвч)

Reached from the tab bar. Back affordance at the top left: 20pt chevron + `Basu` in `accent`.

- **Balance block**, gap 12: `ТҮРИЙВЧ` label; `70,000₮` at 48/600 mono tabular; then one explanatory sentence at 13.5/400 `ink2`, max 30ch — `Хоолны төлбөр эндээс хасагдана. Дутвал зөрүүг нь л асууна.`
- **ЦЭНЭГЛЭХ**: three equal top-up amounts in a `repeat(3, 1fr)` grid, gap 10. Each is a card, padding 15 × 6, centred mono 14/600.
- **ГҮЙЛГЭЭ**: rows separated by top hairlines, padding 14 vertical. Left column is kind (15/500) over source (mono 11.5 `ink3`) — the source names the app the transaction came from, e.g. `Хоол · Модерн Номадс №0971`. Right column is amount (mono 15/600, `ready` for credits, `ink` for debits, real minus sign `−`) over time (mono 11 `ink3`).

### 3. Notifications (Мэдэгдэл)

Two artboards: populated and empty.

- Top bar: back link left, `Бүгдийг уншсан` in `accent` right.
- Title `Мэдэгдэл`, 28/600, 18pt bottom padding.
- Rows: top hairline, padding 16 vertical, gap 12. A leading 6pt `accent` dot marks unread (offset 8 from the top); read rows keep a 6pt-wide empty spacer so text stays aligned.
- Row content, gap 7: header line with source label + channel chip on the left and time on the right; title (600 when unread, 400 `ink2` when read); body at 13/400 `ink2`.
- **Channel chip** is a separate fact from the source: `SMS` or `АПП`, mono 9/500 tracked 0.12em, 1pt `line2` border, radius 2, padding 3 × 5. Source says where it came from; channel says where to look for it.
- Unread is expressed by the dot and the heavier title only — never a tinted row background.
- **Empty state** is a paragraph on the ground colour under the same hairline, max 32ch, 14/400 `ink2`. No illustration, no card, no button.

### 4. Profile (Профайл)

- Identity row, gap 16: 54pt avatar; name 24/600; phone in mono 14 `ink2`; a line of provenance at 11.5/400 `ink3` — `Basu-д 2026 оны 8-р сараас хойш · 3f8c1a92`.
- Fields card: two rows (`Нэр`, `Хэл`), padding 14 × 16, hairline between. Label left in `ink2`, value right in `ink` 500 followed by a 13pt chevron in `ink3`.
- **МЭДЭГДЭЛ** card: three switch rows — `Аппаар` (on), `Мессежээр` (on), `Урамшуулал` (off). Track 51 × 31, radius 16, `accent` when on and `line2` when off, 2pt inset, knob 27 white with `0 1px 2px rgba(0,0,0,.2)`.
- Below the card, at 12/400 `ink3`: order-progress notifications cannot be switched off, and the copy says why — `Захиалгын явцын мэдэгдлийг унтраах боломжгүй — гал тавих мөчийг мэдэхгүй бол урьдчилсан захиалга утгагүй болно.`
- Sign-out: full-width card, padding 15, centred `Гарах` at 15/500 in `stop`.

### 5. Tab bar (all screens)

Three items — `Нүүр`, `Түрийвч`, `Профайл` — pinned to the bottom, `surface` + blur, 1pt top hairline, 78 tall. Each item is a 23pt stroked glyph over a 10pt label, gap 5, in `accent` when active and `ink3` when not. Items are equal-width thirds; the tap target is the full third × 44 minimum.

The bar carries the shell only. Apps are never tabs — they stay in the grid.

> **Open trade-off.** The launcher used to carry a wallet strip showing the balance. It was removed when the tab bar landed: at nine icons there was no room for both, and the strip and the tab were the same tap twice. The balance is now one tap away rather than visible on arrival, which is a departure from the original brief's "visible before any app is opened". If that requirement holds, restore the strip and let the grid scroll under the bar.

---

## Icon system

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

- `Basu Shell.dc.html` — all fourteen artboards, both themes, plus the icon sheet, avatar marks and badge states. Open in a browser.
- `support.js` — prototype runtime only; not part of the design.
