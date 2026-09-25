# Basu дизайн систем

Веб гадаргуу бүрийн (`src/web/*.html`) нэг дүрмийн ном. Эх сурвалж нь iOS shell-ийн `ios/BasuKit/Sources/BasuKit/DesignTokens.swift` ба `design/handoff/README.md`; энд тэдгээрийг браузер, WKWebView, ширээний дэлгэцэд тохируулан тодорхойлов. Хэрэгжүүлэлт нь `src/web/app.css` (шинэ хувилбар нь `scratchpad/design/app.css`-д, хуудсууд шилжихээс өмнө `src/web/app.css`-ийг орлоно). Хуудас бүрийн `<style>` зөвхөн байрлал (layout) авч үлдэнэ; өнгө, фонт, радиус, товч, чип, карт, мөр, хүснэгт бүгд энэ нэг файлаас ирнэ.

Хоёр тэнхлэг дээр шүүмж нэгдсэн: (1) фонтууд — Golos-ыг 500/700/900 жингээр, IBM Plex Mono-г товч, чип, оролтын талбарт хэрэглэсэн нь «терминал» шиг харагдуулж байна; (2) карт, компонент — хуудас бүр өөрийн товч, чип, радиус, сүүдэртэй (таван гарчгийн загвар, гурван товчны систем, долоон радиус), мөр бүр тусдаа хайрцаг. Доорх систем энэ хоёрыг нэг удаа, дундын давхаргад засна.

---

## 1. Зарчим — «мэргэжлийн, найдвартай» гэдэг энд юу вэ

1. **Юу ч өөрийн агуулгаасаа чанга биш.** Үг нь нэг sans фонт (Golos Text) 400/500/600 жингээр; 600-аас хүнд юу ч байхгүй. Гарчиг том, жин биш хэмжээгээрээ ялгарна. Uppercase зөвхөн mono eyebrow шошгонд.
2. **Тоо бол тоо шиг харагдана.** Мөнгө, цаг, тоо ширхэг, код, утас — бүгд нэг mono фонт (JetBrains Mono, shell-тэй адил), `tabular-nums`, `--ink` өнгөтэй. ₮ тэмдэг sans фонтоор, 0.1em зайтай. Мөнгө хэзээ ч улбар шар биш.
3. **Улбар шар нэг үйлдэлд.** Дэлгэц бүрт нэг primary товч, нэг идэвхтэй цэс, холбоос, focus ring, tile-ийн дүрс, «гал дээр» төлөв. Wordmark, мөнгө, гарчиг, утасны дугаар, картын зураас, KPI — хэзээ ч биш.
4. **Карт бол бүлэг, мөр бол хайрцаг биш.** Хэсэг бүр нэг карт (`--surface`, 1px `--line`, радиус 12, y1/b2 сүүдэр), дотор нь мөрүүд 1px hairline-аар тусгаарлагдана. Карт дотор карт байхгүй; зүүн талын өнгөт зураас байхгүй; хоосон төлөв — hairline ба нэг мөр бичвэр, хоосон карт биш.
5. **Нэг хэмжүүр.** Зай 4pt масштаб, радиус зургаан утга, гүн гурван түвшин, бичвэрийн доод хэмжээ 11px (уншигдах ёстой бүх зүйл ≥12.5px), хүрэлтийн бай ≥44px, оролтын талбар 16px (iOS zoom хийхгүй).

---

## 2. Бичвэр

### 2.1 Фонт

| Үүрэг | Фонт | Жин | Fallback |
|---|---|---|---|
| Sans (бүх үг) | Golos Text | 400 / 500 / 600 — **өөр жин байхгүй** | `-apple-system,"Helvetica Neue",Arial,sans-serif` |
| Mono (тоо, код, eyebrow) | JetBrains Mono | 400 / 500 / 600 | `"IBM Plex Mono",ui-monospace,Menlo,monospace` (Plex шилжилтийн үед л) |

- Google Fonts холбоос хуудас бүрийн `<head>`-д **ижил** байна: `https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap` (CSP `style-src` fonts.googleapis.com, `font-src` fonts.gstatic.com зөвшөөрдөг — `src/api/hardening.ts:19-20`). `app.css` мөн адил `@import`-ыг хамгийн эхний мөрөндөө агуулна: terms/privacy шиг холбоосоо мартсан хуудас ч Golos-оор гарна.
- 700/800/900 жин хүсэх, `font-weight:700`-аас дээш бичих — хориотой (ачаалаагүй жин faux-bold болж «наалдсан» харагддаг).
- Хуудас доторх `html{font-size:15px}` (ops), `html{font-size:16px}` (supplier) заалтыг устгана; root 16px, бүх хэмжээ rem.
- Дараагийн шат (сонголт): iOS апп-д багцалсан TTF-үүдийг `/fonts`-оос өгч (`font-src 'self'` зөвшөөрөгдсөн) WebView Google-ээс хамаарахгүй болгох.

### 2.2 Mono хаана зөвшөөрөгдөх вэ

Зөвшөөрнө (зөвхөн эдгээр): мөнгөн дүн, тоо ширхэг (`×3`), тоолуур, цаг, countdown, огноо (тоогоор), захиалгын № ба код, утасны дугаар, ТТД, данс, pairing/OTP/хүлээлгэн өгөх код, timestamp, meta мөр, eyebrow хэсгийн шошго (1–3 үг), ширээний `.code` таг (bank:out гэх мэт).

Хориотой: товч, оролтын шошго/placeholder, select, чип/төлөвийн үг, nav/tab, гарчиг, өгүүлбэр, шүүлтүүрийн pill, хоёроос олон үгтэй кирилл хэллэг. `app.css`-ийн хуучин `.mono,code,.tick,.chip,.lab,.btn,input,button{mono}` дүрэм `.mono,code,.tick,.mn,.num` + `input[type=tel], input[inputmode=numeric|decimal], input.code` болж хумигдсан.

Өгүүлбэр доторх тоо («3 хоногт», «10%») sans-аар үлдэнэ; зөвхөн мөрийн *объект* болсон тоо mono болно.

### 2.3 Хэмжээний масштаб (root 16px)

| Роль | Token | px | Жин / lh / tracking | Хаана |
|---|---|---|---|---|
| display | `--t-display` | 32 mono | 600 / 1.1 / −.01em | KPI утга, KDS countdown; хүлээлгэн өгөх код 32 (.12em) |
| title-1 | `--t-title` | 28 sans | 600 / 1.15 / −.02em | утасны дэлгэцийн гарчиг, door h2 |
| title-2 | `--t-title-2` | 22 sans | 600 / 1.2 / −.015em | ширээний h1, sheet-ийн гарчиг (20), KDS газрын нэр |
| title-3 | `--t-title-3` | 17 sans | 600 / 1.25 / 0 | card-head, topbar гарчиг, section-title, lane гарчиг |
| row | `--t-row` | 15.5 sans | 600 / 1.3 | мөрийн гарчиг, ticket-ийн бараа, зарын нэр |
| body-lg | `--t-body-lg` | 15 sans | 400–500 / 1.5 | утасны body, товч, мөрийн текст |
| body | `--t-body` | 14 sans | 400 / 1.5 | ширээний body, хүснэгт, callout, toast |
| caption | `--t-cap` | 13 sans | 400 (500 шошго) / 1.4 | мөрийн дэд мөр, талбарын шошго, th, KPI тайлбар, үнийн суурь («1 кг · доод тал нь 15 кг») |
| pill | `--t-pill` | 12.5 sans | 500 / 1 | чип, tab шошго доод тал нь 11 |
| meta | `--t-meta` | 11.5 mono | 400 / 1.35 | timestamp, № · Ширээ, source мөр |
| eyebrow | `--t-eyebrow` | 11 mono | 500 / 1 / .14em uppercase | ИДЭВХТЭЙ, ТҮРИЙВЧ, ОДОО — **цорын ганц uppercase** |
| live-time | `--t-live` | 23 mono | 600 / 1 | мөрийн булангийн цаг (shell-ийн liveTime) |
| amount | — | 15 (мөр) / 17 (жагсаалтын үнэ) / 22 (нийт) / 28–32 (KPI) mono | 600 | `.money` |

Ширээнд (`data-desk`): eyebrow 11.5, meta 12. KDS самбар `.board{font-size:20px}` ба em-ээр томордог (countdown 32, хоол 17–19, meta 13–14).

Доод хязгаар: 11px-ээс жижиг юу ч байхгүй (зөвхөн `.count` доторх тоо 11 mono). Хүн уншиж шийдэх зүйл ≥12.5, худалдан авагч унших ёстой баримт (үнийн суурь, доод захиалга) 13 `--ink-2`.

### 2.4 Кирилл бичвэрийн дүрэм

- Tracking: ≤17px — 0; 22px — −.015em; ≥28px — −.02em. `app.css`-ийн хуучин `h1,h2,h3,4{letter-spacing:-.02em}` устгагдсан; хуудсуудын жижиг гарчиг дээрх −.01/−.02/−.03em бүгд устана.
- Мөр хоорондын зай: body 1.5, prose 1.6 (Й/Ё дээш, Д/Ц/Щ доош гардаг), мөрийн гарчиг 1.3, том гарчиг 1.15.
- Хэмжүүр ≤62ch (`.doc p,.doc li{max-width:62ch}`).
- `hyphens:manual`; `overflow-wrap:anywhere` зөвхөн хаяг/URL дээр, нэр дээр хэзээ ч биш (ops `.row .name small`-аас хасна).
- `text-wrap:balance` h1–h3, `text-wrap:pretty` p/li.
- Uppercase зөвхөн mono eyebrow; «ХООЛТОЙ ХҮМҮҮС ЮУ ГЭСЭН БЭ» гэх мэт өгүүлбэр sentence-case 17/600 `.section-title` болно.
- Дүрс: 24 viewBox, stroke 1.6 (topbar chevron 1.8), round cap, `currentColor`; 18px товчинд, 20 мөрөнд, 24 tab-д, 34 tile-д. Emoji (🚶), текст глиф (★ ✕ ‹ − + ›) дүрс болгон хэрэглэхгүй.

### 2.5 ₮ тэмдэг

`mnt()` тестүүдэд `"28,000₮"` буцаасаар байна. innerHTML руу мөнгө бичих бүх газар `api.js`-д нэмэгдэх `money(value)` туслахыг хэрэглэнэ:

```html
<span class="money">28,000<span class="cur">₮</span></span>
```

`.money` — mono 600 tabular `--ink`; `.cur` — sans 500, `margin-left:.1em`. `textContent` өөрчлөгдөхгүй тул `.price b`, `.row .amount`, `.sum b` дээрх тестийн шалгалт хэвээр. Кредит `data-tone="credit"` (+, `--ready`), буцаалт/суутгал `data-tone="debit"` (жинхэнэ −, `--stop`).

### 2.6 Wordmark

`.wordmark` — sans 27/600/−.025em `--ink` (улбар шар биш, 900 биш); ширээний sidebar-т `[data-size="sm"]` 18/600 + «Ops» 13/500 `--ink-3`. Буцах холбоосын хэлбэр — 20px chevron + «Basu» 15/500 `--accent-ink`, 44px.

---

## 3. Өнгө

### 3.1 Token (light — `:root` дээр үндсэн)

| Token | Light | Dark | Тайлбар |
|---|---|---|---|
| `--bg` | #E9EBEC | #0E1315 | flat fallback |
| `--ground` | 176° #EFF1F2→#E9EBEC 46%→#DFE3E4 | #141B1E→#0E1315→#0A0E10 | `html` дээр; shell-ийн ground |
| `--surface` / `--surface-2` / `--sunk` | #FFFFFF / #F3F5F6 / #DFE3E4 | #161D20 / #1C2428 / #0A0E10 | карт / оролт, plate / dev strip |
| `--glass` | rgba(255,255,255,.74) | rgba(22,29,32,.74) | зөвхөн chrome (topbar, tabbar, sheet) |
| `--ink` / `--ink-2` | #14181B / #4A555C | #E7ECED / #A2B0B6 | гарчиг, тоо / body |
| `--ink-3` | **#62727A** | **#84949B** | shell-ийн #78868E/#6E7E85-аас өргөсөн: 4.99:1 цагаан дээр, 5.9:1 dark surface дээр. `BasuColor.ink3`-д мөн адил утгыг зөөнө |
| `--line` / `--line-2` | #D2D8DA / #C0C8CB | #283236 / #374348 | hairline / оролтын хүрээ |
| `--accent` | #C64E08 | #FF8A3D | **дүүргэлт**: primary товч, tile дүрс, badge |
| `--accent-ink` | **#A84206** | #FF9B57 | **текст**: холбоос, идэвхтэй tab, accent-soft дээрх чип (5.1:1) |
| `--accent-soft` / `--accent-line` | #FAE7DA / #E9B893 | #33200F / #5E3A1B | идэвхтэй цэсний угаалт, FIRED чип |
| `--on-accent` | #FFFFFF | **#160B03** | accent дүүргэлт дээрх текст (dark-д цагаан 2.35:1 байсан) |
| `--route` (+soft/line) | #1B5B8F / #DFEAF3 / #A8C6DE | #78B0E0 / #16242F / #2E4A61 | хүлээж байна, замд |
| `--ready` | #136A4B / #DCEDE6 / #9CCBB7 | #57C295 / #0F2620 / #1F4A3A | дууссан, кредит, гэрээт |
| `--hold` | #7E6113 / #F1E9D2 / #D9C48A | #DAB65A / #2A2312 / #4E4222 | хүнийг хүлээж байна, хугацаа |
| `--stop` (+`--on-stop`) | #9B2226 / #F7DEDE / #E0A9A9 / #FFFFFF | #F08A8D / #2E1416 / #5A2A2C / #2A0B0C | анхаарал, алдаа, устгах |
| `--unread` | #E4EDF5 | #16232E | уншаагүй/сонгосон мөр — accent биш |
| `--star` | = `--hold` | = `--hold` | од (#E8A13A устгагдана) |
| `--scrim` | rgba(20,24,27,.40) | rgba(4,7,8,.60) | sheet-ийн ард |
| `--shadow` | 0 1px 2px rgba(20,24,27,.05) | 0 1px 2px rgba(0,0,0,.4) | карт (shell-ийн y1 b2) |
| `--shadow-float` | + 0 12px 32px −12px .22 | + 0 14px 36px −12px .7 | toast, popover, dock panel |
| `--shadow-sheet` | 0 −1px 0 line, 0 −16px 40px −20px .30 | … .70 | доороос дээш |

Dark `@media (prefers-color-scheme: dark)` доор `:root:not([data-theme="light"])`-аар (одоогийнх шиг) **ба** `:root[data-theme="dark"]`-аар давхар тодорхойлогдоно — хоёр блок byte-ийн хэмжээнд ижил байх ёстой. `color-scheme` тус бүрт заагдсан тул select, date picker, scrollbar, checkbox хуудасны сэдвийг дагана.

### 3.2 Accent-ийн төсөв

Зөвшөөрөгдөх газар, бүрэн жагсаалт: (1) дэлгэцийн нэг primary товч; (2) идэвхтэй tab / sidebar item (дүрс + текст, `--accent-soft` угаалттай); (3) холбоос, inline үйлдэл (`--accent-ink`); (4) focus ring; (5) stepper-ийн одоогийн цэг ба «гал дээр» төлөв (FIRED / COOKING / PREPARING); (6) launcher tile-ийн дүрс, хонхны badge; (7) сонгосон цагийн slot / шүүлтүүр (soft + accent-ink). Хаана ч өөр газар байхгүй: wordmark (`--ink`), мөнгө, KPI утга, гарчиг, картын зураас, утасны дугаар (`--ink` 500 + утасны дүрс), мөрийн булангийн цаг (`--ink`), demo strip.

### 3.3 Утга бүхий өнгө — нэг утга тус бүрт

| Тон | Утга | Төлөвүүд |
|---|---|---|
| route | системийг / нөгөө талыг хүлээж, замд | PLACED ACCEPTED SCHEDULED PAID DISPATCHED queued info |
| hold | хүнийг хүлээж, хугацаа | ARMED applied due hold needs_account pending |
| accent | амласан, гал дээр | FIRED COOKING PREPARING |
| ready | дууссан, кредит, баталгаажсан | READY SERVED CLOSED HANDED contracted paid on ok issued settled active verified |
| stop | анхаарал, алдаа, устгах | HELD declined failed warn bad late error; danger товч |
| neutral | дууссан сөрөг үр дүн — **сэрэмжлүүлэг биш** | CANCELLED REFUNDED NO_SHOW REJECTED off зогссон, мэдэгдээгүй төлөв |

Тон үргэлж текст + 6px цэг эсвэл soft дүүргэлтээр; хэзээ ч зүүн зураас, бүтэн картын өнгөөр биш. Мөнгө `--ink`; кредит `+` `--ready`; дебит `−` `--ink` (буцаалт `--stop`). KPI утга `data-tone=bad|warn|good`-оор л өнгөтэй.

### 3.4 Гадаргуу, материал

Карт — тунгалаг бус `--surface` + 1px `--line` + `--shadow`, ground градиент дээр. Карт доторх бүлэг — `--surface-2` (`.inset`) эсвэл hairline, хоёр дахь хүрээтэй хайрцаг биш. Glass (`--glass` + `backdrop-filter`) **зөвхөн** topbar, tabbar, sheet + sheet footer, order bar дээр (агуулга доогуур гулсдаг chrome); картын жагсаалт, хүснэгт, ticket дээр WKWebView-д тасалдана. Ширээ (`data-desk`) — `--glass` тунгалаг бус, `--blur:none`. Hover зөвхөн `@media (hover:hover)`; `:active` = `--surface-2` (мөр) / `scale(.985)` (товч); сонгосон = `--unread`.

Газрын зураг (dine, idesh mapbox): `#map{background:var(--bg)}`, MapLibre control-ууд token-оор; dark-д `mapStyle.js`-д харанхуй палитр: ground #141B1E, water #16232E, park #12221B, buildings #1C2428, roads #283236 / #374348 / #4A5860, label `--ink-2` halo #0E1315, pin `var(--accent)` (нээлттэй) / `--ink-3` (хаалттай) `--surface` хүрээтэй, route `--route` `--surface` casing-тай. Энэ хүртэл dark-д 35% ink overlay.

### 3.5 Контраст (шалгасан)

`--ink-3` 4.99:1 цагаан, 4.2:1 ground (ground дээр зөвхөн eyebrow/meta), 5.9:1 dark surface; `--accent-ink` light 6.1:1 цагаан, 5.1:1 accent-soft; dark 7.4:1 accent-soft; `--on-accent` dark 8.3:1; tone текст soft дээр ≥4.8:1 хоёр сэдэвт.

---

## 4. Хэлбэр ба гүн

### 4.1 Радиус (зургаан утга + чип)

| Token | px | Хаана |
|---|---|---|
| `--r-xs` | 4 | inline `code`, link-товчны focus |
| `--r-sm` | 8 | count badge, thumbnail ≤40, skeleton, seg thumb, sidebar item |
| `--r-ctl` | 10 | товч, input, select, textarea, seg track, callout, inset |
| `--r-md` | 12 | карт, мөрийн контейнер, KPI band, table wrap, toast, codebox |
| `--r-sheet` | 16 | sheet-ийн дээд булан |
| `--r-lg` | 18 | launcher tile |
| `--r-chip` | 2 | зөвхөн SMS/АПП сувгийн чип |
| `--r-pill` | 999 | чип, badge, шүүлтүүр |

`--r:var(--r-md)`, `--r-s:var(--r-ctl)` — supplier/ops-ийн хуучин нэрийн alias; хуудасны `:root{--r…}` блокуудыг **устгана**, alias-аар орлуулахгүй. 2/3/4/5/6/14/99px-on-buttons утгууд бүх хуудаснаас арилна.

### 4.2 Хүрээ

Үргэлж 1px `--line`; `--line-2` зөвхөн интерактив ирмэг (input, secondary товч, seg thumb). 1.5px, 2px ring, 3–4px өнгөт зүүн зураас байхгүй (home/idesh карт, supplier ticket, dine note, KDS ticket — төлөв 6px цэг эсвэл KDS-ийн header band руу шилжинэ). Мөрүүд `border-top` (эхнийхээс бусад), тусдаа хүрээтэй мөр байхгүй.

### 4.3 Гүн (гурван түвшин + modal)

0 flat — мөр, td, input, callout, empty, skeleton: сүүдэргүй. 1 card — `--surface` + line + `--shadow`. 2 float — sheet, dock panel, toast, popover: `--glass`/`--surface` + `--shadow-float`/`--shadow-sheet`. 3 modal — `--scrim`. Гүн ерөнхийдөө тонгоор (`--surface-2`), сүүдрээр биш.

### 4.4 Зай (4pt)

`--s-1…--s-8` = 4 8 12 16 20 24 32 48. Утасны gutter 20, ширээ 32; картын/мөрийн padding 12×16 (ширээ 14×20); мөр дотор 8, мөр хооронд 0 (hairline), карт хооронд 12, бүлэг хооронд 24, хэсэг хооронд 32; eyebrow дээр 32 / доор 8; title-3 хэсэг дээр 24 / доор 12; tile grid gap 10 босоо / 14 хэвтээ; KPI band gap 1px; ширээний хоёр багана 16.

### 4.5 Хяналтын өндөр

`--h-sm` 36 (зөвхөн ширээний хүснэгт/toolbar), `--h-md` 44, `--h-lg` 52; `--target` 44 — бүх хүрэх зүйл. Input 44 утсанд (`--ctl-h`), 40 ширээнд; фонт 16px утсанд (`--ctl-fs`), 15 ширээнд.

---

## 5. Бүрэлдэхүүн хэсгүүд

Бүх утга `app.css`-д; энд markup, төлөв, дүрэм.

### 5.1 Товч — `.btn`

```html
<button class="btn" data-v="primary" data-size="lg">28,000₮ төлөх</button>
<button class="btn">Засах</button>                       <!-- secondary -->
<button class="btn" data-v="quiet">Болих</button>        <!-- .btn.quiet мөн ажиллана -->
<button class="btn" data-v="danger">Цуцлах</button>      <!-- хүрээтэй улаан -->
<button class="btn" data-v="danger" data-fill>Захиалгыг цуцлах</button> <!-- зөвхөн баталгаажуулах алхамд -->
<button class="btn" data-v="link">Дахин үзэх</button>
<button class="btn" data-icon aria-label="Хаах"><svg>…</svg></button>
```

- Суурь: inline-flex, sans 15/500, 44px, padding 0 16, radius 10, 1px `--line-2`, `--surface`, `--ink`; svg 18px stroke 1.6.
- Хэмжээ: `sm` 36/13px (ширээний хүснэгтэд л); `lg` 52/16px 600, width 100%.
- primary — `--accent` дүүргэлт, `--on-accent`, 600; hover brightness 1.06. quiet — хүрээгүй `--ink-2`, hover `--surface-2`. danger — тунгалаг, `--stop-line` хүрээ, `--stop` текст, hover `--stop-soft`; `[data-fill]` — `--stop` дүүргэлт, `--on-stop`, 600. link — хүрээгүй 13/500 `--accent-ink`, hover underline.
- `:active{transform:scale(.985)}`; `[disabled]` — `--surface-2`, `--line`, `--ink-3`, opacity 1 (45% opacity-тай улаан «идэвхтэй» шиг харагддаг); `[data-busy]` — текст тунгалаг (textContent хэвээр — тест «Түр хүлээнэ үү…» уншина), 16px spinner, pointer-events none.
- Дүрэм: дэлгэцэд нэг primary; устгах үйлдэл primary-ийн хажууд quiet эсвэл danger, хоёр дахь дүүргэлттэй товч биш; Болих (quiet) + Захиалгыг цуцлах (danger fill).

### 5.2 Карт — `.card`, `.card-head`, `.card-body`, `.inset`

`--surface`, 1px `--line`, radius 12, `--shadow`. `.card-head` — flex, 14×16 (ширээ 14×20), border-bottom, h3 17/600 + `.meta`/нэг `.btn[data-v=link]`. `.card-body` 16 (ширээ 20). Дотор бүлэг `.inset` (`--surface-2`, radius 10). `[data-link]` — cursor + hover/active `--surface-2`. Карт дотор `.card` байхгүй; хоосон жагсаалт `.empty` мөр; KPI band, table wrap картын дотор.

### 5.3 Жагсаалтын мөр — `[data-rows] > .row`

Контейнер атрибут (класс биш) — хуудсуудын одоогийн `.row` (ops, supplier, dine `.review .row`, idesh `.listing .row`) хөндөгдөхгүй.

```html
<div data-rows>
  <div class="section-label">Идэвхтэй</div>
  <a class="row card" href="/dine?order=…" data-source="Хоол" data-chev>
    <span class="lead"><span class="dot" data-tone="route"></span></span>
    <span class="main">
      <span class="title venue">Алтан Тавган</span>
      <span class="sub what">Энэ цагт гал дээр гарна</span>
      <span class="meta code">Хоол · №0970 <span class="chip" data-inline data-s="PAID">Төлсөн</span></span>
    </span>
    <span class="end"><span class="val when" data-size="lg">12:30<small>суух</small></span></span>
  </a>
</div>
<ul data-rows><li><button class="row listing" …>…</button></li></ul>
```

- Контейнер: карт шиг (surface, line, radius 12, shadow, overflow hidden); мөр хооронд `border-top`; `.section-label` дотор 14×16×8.
- Мөр: flex, gap 12, min-height 56, padding 12×16; өөрийн хүрээ/радиус/сүүдэр/зураасгүй (`.card.row` дээр ч `[data-rows]` дүрэм давамгайлж картын харагдац арилна).
- `.lead` — 40px thumbnail (`.thumb`, radius 8, `--surface-2`), `[data-size=lg]` 64, эсвэл `.dot`, эсвэл 20px дүрс `--ink-3`. `.main` — `.title` 15.5/600 (`[data-weight=normal]` 400), `.sub` 13/400 `--ink-2`, `.meta` mono 11.5 `--ink-3` нэг мөр truncate. `.end` — `.val` mono 15/600 `--ink` (`[data-size=lg]` 23), `.val small` sans 11/500 uppercase .12em `--ink-3` доор нь (`time<small>label</small>` зэрэгцээ хэвээр — home-ийн `.when` regex), `.chip`, `[data-chev]` 16px chevron `--ink-3`.
- Төлөв: `a/button.row` hover (hover:hover) ба `:active` `--surface-2`; `[data-off]` гарчиг `--ink-2`, утга `--ink-3` (opacity биш) + neutral чип; `[data-unread]`/`[aria-selected=true]` `--unread`. Ширээ 48/10×16; `[data-dense]` 44.

### 5.4 Талбар — `.field`, `.input`, checkbox/radio, `input.code`, `.affix`

```html
<label class="field"><span>Утас</span><input type="tel" inputmode="tel"><small class="help">Код энэ дугаарт ирнэ</small></label>
<label class="field"><span>Үнэ</span><span class="affix"><input inputmode="numeric" name="price_mnt"><i>₮</i></span></label>
<label class="check"><input type="checkbox" name="delivers"> Хүргэлт хийнэ</label>
<input class="code" inputmode="numeric" maxlength="8" aria-label="Холбох код">
```

- Шошго `.field > span|label` 13/500 `--ink-2`, доор 6. Хяналт: width 100%, min-height `--ctl-h` (44/40), padding 0 14, sans `--ctl-fs` (16/15), `--surface`, 1px `--line-2`, radius 10, `appearance:none`; placeholder `--ink-3`.
- `:focus` — `--accent` хүрээ + `--ring` (3px accent-soft); `[aria-invalid=true]` — `--stop` + stop-soft ring, `.help[data-error]` 13/500 `--stop` `role=alert`; `[disabled]`/`[readonly]` — `--surface-2`, `--ink-3`.
- select — `--chev` data-URI chevron (сэдэв тус бүрт `--ink-3` өнгө), padding-right 40. textarea — min 96, 12×14, resize vertical. date — native picker, `color-scheme` дагана. search — `.input.search` 38px зүүн padding + `--icon-search`.
- Тоон: `input[type=tel]`, `[inputmode=numeric|decimal]`, `input.code` mono tabular. `.affix > i` — sans 14 `--ink-3` баруун 14. `input.code` — 64px, mono 32/600, .32em tracking, төв, `--surface-2`, radius 12 (найман нүд биш).
- checkbox/radio — `appearance:none`, 20px, `--line-2` хүрээ; checked `--accent` + `--check` data-URI (`--on-accent` өнгө сэдэв тус бүрт) / radio inset 4px `--surface` цагираг. `.check` мөр 44px gap 12.
- Бүлэглэл: `.fields` grid (утас 1 багана, ≥640 minmax 200), `.wide`, `.form-group` (hairline + eyebrow), `.form-foot`. Хүрээгүй-хүрээтэй давхар хайрцаг байхгүй: форм картын дотор шууд.
- Хөндөгдөөгүй бүрэн бус форм — тусламж `--ink-3`, анхааруулга зөвхөн талбар хүрсний дараа.

### 5.5 Төлөвийн чип — `.chip` / `.pill`

```html
<span class="chip" data-s="PAID">Төлсөн</span>         <!-- neutral pill + route цэг -->
<span class="chip" data-s="COOKING">Гал дээр</span>     <!-- accent-soft дүүргэлт (өөрөө) -->
<span class="chip" data-s="HANDED" data-inline>Хүлээлгэн өгсөн</span>  <!-- цэг + үг, pill-гүй -->
<span class="chip" data-tone="hold" data-strong>Өнөөдөр</span>
<span class="chip" data-ch>SMS</span>                  <!-- сувгийн чип: mono, radius 2 -->
```

- Суурь: inline-flex, 24px, padding 0 9 0 7, radius 999, 1px `--line`, `--surface-2`, sans 12.5/500 `--ink-2`; `::before` 6px цэг тон өнгөөр (`content:""` — `.chip` textContent яг «Төлсөн» хэвээр). `[data-size=sm]` 20/11.5 (хүснэгтэд).
- Тон `data-s`-ээр (3.3-ын хүснэгт) эсвэл `data-tone=route|hold|accent|ready|stop`. Soft дүүргэлт өөрөө: HELD FIRED COOKING PREPARING warn failed bad late error; `[data-strong]` дурын тоныг дүүргэнэ. Бусад нь neutral pill + цэг: 50 PLACED мөртэй хүснэгт 50 цэнхэр pill биш.
- `[data-inline]` — өндөр/padding/хүрээ/дэвсгэргүй, launcher ба idesh «Миний идэш» мөрийн meta-д.
- Чип зөвхөн төлөвийн үг; нийлүүлэгчийн нэр, огноо чип биш (meta текст); бүх мөрөнд ижил байгаа баримт (Гэрээт) бүлгийн толгойд нэг удаа (DOM-д `.verified` үлдэнэ — тест).
- `.pill` (ops) ижил дүрэмтэй alias. `.filter > button` — 36px sans 14/500, `[aria-pressed=true]` accent-soft + accent-ink + accent-line (ink slab биш). `.badge` — шошго pill (Гэрээт), ready tint, 20px, sentence-case, `data-tone`.

### 5.6 Хүснэгт — `.table` (ширээ)

`.card` (padding 0) > `.table-wrap{overflow-x:auto}` > `table.table`. th sticky, `--surface`, 12.5/500 `--ink-2`, sentence-case, 10×16, border-bottom. td 12×16, border-bottom (сүүлийн мөрөнд үгүй), эхний багана 500. `.num` баруун mono tabular 500; мөнгө `.money`+`.cur`; код/утас mono 13 `--ink-2`; огноо mono 12.5 цагтай («өнөөдөр 11:16»); `—` хамаарахгүй, `0` тэг, баганаар тогтвортой. Чип sm. `tr[data-link]` cursor + hover `--surface-2` + сүүлийн нүдэнд chevron (background-mask), `tabindex=0`, Enter — JS. `[data-dense]` 8×16. Хоосон — `td.empty` нэг мөр, `[data-empty] thead` нуугдана. `.tools` — flex gap 10, `.tools .n` мөрийн тоо mono. Утсанд хүснэгт `.table-wrap` дотроо гулсана, хуудас хэвтээ гулсахгүй.

### 5.7 KPI — `.kpi-band`

```html
<div class="kpis kpi-band">
  <div class="card kpi"><div class="lab">Зочдын түрийвч</div><b>1,024,000<span class="cur">₮</span></b><span>өнөөдөр</span></div>
  <div class="card kpi" data-tone="bad"><div class="lab">Цуцлагдсан</div><b>3</b><span>7 хоногт</span></div>
  <div class="card kpi" data-word data-tone="good"><div class="lab">Ledger</div><b>тэнцсэн</b><span>шалгасан 13:39</span></div>
</div>
```

Нэг карт, нүднүүд 1px hairline grid-ээр (gap 1px, `--line` дэвсгэр), 12 сүүдэр биш. Нүд 16×20, min 104, `.kpi` класс хэвээр (`#now .kpi === 6`, `#money .kpi === 6` тест). Шошго sans 13/500 `--ink-2`; утга mono 28/600 `--ink` (`.cur` .65em), утас 22, `data-span` бүтэн мөр; тайлбар 13 `--ink-3`; `data-tone=bad|warn|good` зөвхөн утгыг өнгөлнө, accent хэзээ ч биш. **Үг бол тоо биш**: `[data-word]` — 8px тон цэг + sans 17/600 үг («тэнцсэн», «Scheduler» textContent хэвээр).

### 5.8 Хэсгийн гарчиг — `.section-label`, `.section-title`, `.eyebrow`/`.lab`/`.sec`

Хоёр л хэлбэр. Eyebrow: mono 11/500 uppercase .14em `--ink-3`, flex space-between, margin 32 0 8 (эхнийх 0), баруун талд `.n` тоо (mono, tracking-гүй) эсвэл `.link` 13/500 accent-ink; 1–3 үг (ИДЭВХТЭЙ, АППУУД, МИНИЙ ИДЭШ, ЯВЦ, ОДОО, ОЛГОЛТ ОЧИХ ДАНС). `.eyebrow`/`.lab` — текстийн загвар; `.sec` — өв (index/idesh `h2.sec`), eyebrow-ийн хэмжээтэй боловч фонтоо хуудаснаас авдаг, шинэ markup `.section-label` хэрэглэнэ. Гарчгийн хэлбэр `.section-title`: sans 17/600 `--ink`, margin 24 0 12, `.n` mono 11.5 `--ink-3` дугаар, `small` 13/400 lead (≤40ch) — асуулт, өгүүлбэр гарчигт (Хэдэн цагт ирэх вэ?, Хоолтой хүмүүс юу гэсэн бэ, Дэлгэцээ холбоно уу). Sans хэзээ ч uppercase, tracking биш. ops `.section > h2`, supplier `.sec`, dine `.slothead`, kds `.lane > h2`, ops `.grp` бүгд эдгээрийн аль нэг болно.

### 5.9 Хуудасны толгой — `.page-head`

Ширээ: flex flex-end space-between, margin-bottom 20; h1 22/600 −.015em; p 13/400 `--ink-2` нэг мөр (≤600px нуугдана); баруун slot — нэг seg эсвэл нэг primary. `.crumb` — 13/500 breadcrumb (эх tab accent-ink › одоогийнх `--ink-2`), буцах товч бүртгэсэн эх рүү. h1 доторх чип `margin-left:10;vertical-align:middle` (inline style биш). Утас: `[data-large]` — padding-top 8+safe, h1 28/600 −.02em, p 14 ≤36ch. Нэг хуудсанд нэг h1; supplier-ийн нэр bar-т span, хуудасны гарчиг h1.

### 5.10 Sheet — `.sheet`, `.scrim`

Fixed bottom, max 88dvh, `--glass` + blur, border-top, radius 16 16 0 0, `--shadow-sheet`, `translateY(102%)`→0 260ms; `.scrim` `--scrim` fade. `> .grip` — 36×5 `--ink` 28% (зөвхөн drag-to-dismiss холбогдсон бол; үгүй бол элементийг хасна). `> header` — grid 1fr 44, 12×20, h2 20/600 (mono class JS-ээр зөвхөн №код бол), `.sub` 13 `--ink-2`, `.x` 44px тойрог `--surface-2` 18px SVG X. `> .body` scroll, overscroll contain, padding-bottom 16. `> footer` — glass, hairline, 12×20+safe, `.summary` мөрүүд (13 `--ink-2` / `.money` 15; `[data-total]` 15 `--ink` + `.money` 17) дараа нь нэг lg primary, secondary quiet доор; `:empty` нуугдана. `[data-busy] > .body` pointer-events none .6. ≥900px `[data-dock]` — баруун 440px panel, radius 0, border-left, `--shadow-float`, scrim нуугдана (газрын зураг амьд). Order bar (dine `.orderbar`) — footer-ийн материал, 64+safe, radius 12 12 0 0, `<span>` дотор, `.when` mono 20/600 `--ink`.

### 5.11 Дээд самбар — `.topbar`, `.stale-strip`

Sticky, grid `minmax(44px,auto) 1fr minmax(44px,auto)`, min-height 52+safe, glass + blur, border-bottom. `.back`/`.home` — 44px, 20px chevron 1.8 + «Basu»/«Буцах» 15/500 `--accent-ink`, тэргүүлэх ирмэгт (in-shell ба бусад — idesh dine-ийн `.in-shell` дүрмийг авна). `.title b` 17/600 ellipsis, `span` 13 `--ink-2`. `.act` — нэг 44px icon товч эсвэл `.conn` (8px цэг + 13/500 Холбогдсон `--ready` / `[data-stale]` `--stop`). `[data-fixed]` (газрын зураг дээр), `[data-wide]`. Stale — `.stale-strip` бүтэн өргөн stop-soft 13/500 + сүүлийн цаг mono. Газрын зураг: badge + home нэг glass cluster зүүн дээд.

### 5.12 Хажуугийн цэс — `.sidebar` (ширээ)

`/sidenav.js`-ийн `deskFrame()` — dashboard ба ширээний өргөнтэй (≥900) supplier хоёулаа нэг frame: `.app.desk-frame` grid `var(--side)` (256) + `.main > .page#view`. `aside.side.sidebar` sticky 100dvh, `--surface`, border-right, 18 12 12. Дээрээс доош:

- `.brand` — Basu 18/600 `--ink` + «Dashboard»/«Нийлүүлэгч» 13/500 `--ink-3`.
- `.ws` ажлын орчин сэлгэгч — `.ws-btn` 54px, `--surface-2`, 1px line, `--r-ctl`: `.ws-mark` 32 (эхний хоёр үсэг; `[data-kind="desk"]` `--ink` дүүргэлт «B», `[data-kind="me"]` дугуй) + нэр 14/600 + мөр 11.5 `--ink-3` («Нийлүүлэгч · Эзэн») + дээш-доош chevron. Нэг л газартай бол `disabled`, chevron-гүй. `.ws-menu` (role=menu) — `width:max(100%,296px)`, `--shadow-float`: «Ажлын орчин» eyebrow, `.ws-opt` 44 (role=menuitemradio, тогтмол дараалал: ширээ → идэвхтэй байгууллага → хүлээгдэж буй → хувийн булан; одоогийнх accent check), `.ws-sep`, `.ws-act` («Байгууллага бүртгүүлэх», «Basu ops эрх хүсэх»). Esc, гадна дарах хаана.
- `nav.tabs` flex column `overflow-y:auto` `flex:1` — Гарах хэзээ ч тасрахгүй. Гарчиггүй дээд бүлэг `.nav-top` (Самбар/Нүүр), дараа модуль бүр `.nav-group[data-group]`: `.grp` товч (eyebrow 11 mono uppercase `--ink-3`, баруун талд 14px chevron, `aria-expanded`), `[data-shut]` → `.grp-items` нуугдана, chevron −90°; эвхэлт `localStorage['basu.nav.shut']`-д (`<kind>:<group>`), нээлттэй хуудасны бүлэг хэзээ ч эвхэгдэхгүй. Мөр `[data-tab]` — `button` эсвэл өөр хуудас руу `a[href]` (нийлүүлэгчийн хуудас), 34px, 14/500 `--ink-2`, svg 18 `--ink-3`, hover `--surface-2`, `[data-on]` accent-soft + accent-ink 600 + svg accent, `aria-current=page`. `.n[data-badge]` count (neutral; `[data-hot]` accent).
- `.acct` hairline дээр: `.av` 32 дугуй эхний үсэг, нэр 13/600, хаяг mono 11.5 ellipsis, `#out` 36 icon → hover stop-soft; supplier дээр хоёр товшилтоор (`[data-confirm]` «Гарах уу?»).

≤900px: `.deskbar` sticky (52+safe): `.nav-open` 44 hamburger + хуудасны нэр 15.5/600 + газрын нэр 11.5; sidebar `position:fixed` drawer `min(86vw,304px)`, `translateX(-104%)` → `[data-open]`, `.nav-scrim` (`--scrim`), `.nav-close`, `html[data-nav-open]{overflow:hidden}`, Esc хаана. Supplier утсан дээр (<900) `.tabbar` хэвээр — таб нь суудлын эрхээр шүүгдэнэ (ажилтан 4, нягтлан 3). Цэсийн мөр, бүлэг бүр серверийн `/v1/access`-ээс ирнэ — хуудас өөрөө жагсаалт зохиохгүй (ADR 0003). Ширээний өргөнтэй supplier `data-theme="light"`-д зүүгдэнэ — dashboard-тай нэг харагдана.

### 5.13 Toast — `#toast`

Fixed, `bottom:calc(24px + var(--toast-lift) + safe)`, ink дэвсгэр `--ink-inverse` текст, 12×16, radius 12, sans 14/500, `--shadow-float`; `[data-kind=bad]` `--stop`/`--on-stop`; `[data-kind=good]` `--ready` цэг (ops 8 удаа дууддаг, өнөөдөр загваргүй). Tab bar-тай хуудас `.has-tabbar` (`--toast-lift:var(--tabbar-h)`). 3200ms; хүн хадгалах код/дүн toast-д хэзээ ч ганцаараа байхгүй.

### 5.14 Хоосон төлөв — `.empty`

Hairline + нэг мөр: padding 20×16, border-top, 14/400 `--ink-2`, зүүн зэрэгцүүлэлт, `b` 600 `--ink`, сонголтоор нэг secondary sm `.btn` (Зар нэмэх). `.card.empty` картын харагдацаа алдана (дэвсгэр/хүрээ/сүүдэргүй) — скриптүүд `<div class="card empty">` үүсгэсээр байж болно. `[data-center]` ≤32ch төв (KDS lane). Дүрсгүй. `…` ачааллын текст skeleton-оор солигдоно.

### 5.15 Skeleton — `.skel`, `.skel-row`

`--surface-2` блок, radius 8, shimmer (`prefers-reduced-motion` үед хөдөлгөөнгүй). `.skel-row` — 56px, 40px plate + `.skel-lines` (60%/40%) + 48px баруун. Ирэх мөрийн геометрийг хуулна, гурван мөр; контейнерт `role=status aria-busy=true`; амжилтгүй бол `.empty` өгүүлбэр + «Дахин ачаалах» secondary sm. Home `#live` token байгаа үед skeleton-оор зайгаа хадгална (grid үсрэхгүй); `[data-any]` hook хэвээр.

### 5.16 Avatar — `.avatar`

30 (`sm`) / 40 / 54 (`lg`), radius 28%, `--surface-2` plate + line; `[data-mark]` — 4×4 толин тусгал grid (`api.js` `avatar(seed,size)`: %3 хоосон, сондгой тойрог, тэгш дөрвөлжин, ≥8 `--ink`, эхний ≥13 accent); үсэг fallback 600 `--ink-2`. Зураг биш, хүн тус бүрт өнгө биш.

### 5.17 Count — `.count`

18px, min 18, radius 8, `--accent`/`--on-accent`, mono 11/600 (eyebrow-тэй адил доод хязгаар дээр); `[data-tone=neutral]` `--surface-2`, `[data-tone=stop]` stop-soft; `[data-float]` дүрсний баруун дээд; 99+ JS-ээр; хоосон бол нуугдана.

### 5.18 Segmented — `.seg`

`--surface-2` track, 1px `--line`, radius 10, padding 3; товч 32px (утас `[data-fill]` 40) 13/500 `--ink-2`; `[data-on]`/`[aria-pressed=true]` `--surface` + `--line-2` + `--shadow` 600. Тон: `[data-on=yes]`/`[data-tone=ready]` ready-soft, `no`/stop stop-soft (dine Тийм/Үгүй). Хугацаа, scope, KDS lane (тоо `.count`-оор). Товчны текст яг монгол үг (тест текстээр дардаг).

### 5.19 Tab bar — `.tabbar` (утас)

Fixed bottom 64+safe, glass, border-top, grid; товч 44, дүрс 24 stroke 1.6, шошго 11/500 (**харагдана**, icon-only strip биш), `[data-on]` accent-ink + svg accent, `:active` `--surface-2`, `.count` дүрсний дээр. ≤5; тавдахь «Бусад». Агуулга `.has-tabbar`.

### 5.20 Callout — `.callout`, `.note[data-k]`

Flex, 18px дүрс, 12×14, radius 10, `--surface-2` + line (default info); `data-k=info|warn|stop|ok` tone soft/line/text; зүүн зураасгүй; `b` 600 block. info — е-баримт, нөхцөл; warn — бодит эрсдэл (гал тогоо хаалттай, хоцорсон); stop — алдаа. Ops alerts — `.alerts[data-rows] > .alert` нэг картын мөрүүд (цэг + өгүүлбэр + Очих quiet sm бүр дээр); «бүх зүйл сайн» нэг ok мөр.

### 5.21 Stepper — `.stepper` (dine/idesh `.timeline`, ops/supplier `.story`)

`ul.timeline.stepper > li[data-done|data-next]`: grid 20 1fr auto, padding 10 0; цэг `li::after` (12px, pending `--line-2` цагираг, done `--ready` + surface ring, next 2px accent), холбогч `li::before` 1px `--line`; idesh-ийн `.d` (svg + i) `display:none`. `.w` 15/400 `--ink-3` → done `--ink`, next 500; `.s` 13 `--ink-2`; `.t` mono 13 `--ink-3` баруун, зөвхөн бодит үйл явдлын цаг, «·» биш (хоосон нүд). Story: `[data-stepper] li[data-k=stop|route|ready]` цэгийн тон (цуцлалт улаан, замд цэнхэр, өгсөн ногоон).

### 5.22 Dot, Codebox, Chevron

`.dot` 6px `--ink-3` + `data-tone`. `.codebox` — 16, radius 12, `--surface-2`, line, төв; `b` mono 32/600 .12em `--ink`; eyebrow дээр, 13 `--ink-2` тайлбар доор; хатуу, dashed биш; ширээнд copy quiet sm. `.chev` — 16px mask chevron `--ink-3`.

### 5.23 Demo цагийн strip — `.clockbar`

`api.js mountClock` markup хэвээр (тестүүд `data-to/data-advance/data-tick`-ээр дардаг), гарц хэвээр (`/dev/clock` хариулбал л, shell дотор хэзээ ч биш). Загвар: 32px, `--surface-2`, dashed доод хүрээ, mono 11.5 шошго, цаг mono 13/600, товч 24px sans 12/500 ghost, `[data-hot]` `--ink` дүүргэлт (accent биш), нэг мөр `overflow-x:auto`. Дээд талд үлдээсэн шалтгаан: dine sheet, idesh screen-foot, supplier tabbar, dine orderbar дөрвүүлээ доод ирмэгт амьдардаг; доод pill-д хувиргах бол `api.js`-д нэг toggle (2 мөр) хэрэгтэй — нээлттэй асуулт.

### 5.24 Баримт — `.doc` (terms, privacy)

`.doc` 560 багана, `.doc-card` нэг карт (≤480 ирмэгээс ирмэг), h1 28/600, h2 17/600 hairline дээр + `.n` mono дугаар (текст дэх «1.» хэвээр, span-аар харагдац тусгаарлана), p/li 15/400/1.6 `--ink-2` ≤62ch, `ol` mono counter, `.doc-meta` (dt eyebrow / dd) — ХҮЧИНТЭЙ / ХУВИЛБАР / ОПЕРАТОР / ХОЛБОО БАРИХ, `.doc-summary` (мөнгөний дүрмүүд mono утгаар), `.toc`, `.en` hairline + EN eyebrow, `.back` 44 chevron. Topbar (5.11) — `history.length>1 ? history.back() : '/idesh'` нэг inline модуль (CSP hash — restart).

---

## 6. Сэдвийн бодлого (theme policy)

| Гадаргуу | Сэдэв | Шалтгаан |
|---|---|---|
| home, dine, idesh, terms, privacy | системийг дагана (light default, dark `prefers-color-scheme`, `data-theme=dark` ч ажиллана) | iOS shell-ийн SwiftUI дэлгэцүүд утасны тохиргоог дагадаг; харанхуй апп дотор гэрэлтэй WebView хамгийн харагдахуйц оёдол. `color-scheme:light dark`, `<meta name=theme-color>` хоёр (#E9EBEC / #0E1315), `maximum-scale=1` устгана. Газрын зураг — dark палитр ирэх хүртэл overlay. |
| supplier | системийг дагана; ≥900px `data-desk` (тунгалаг бус bar, blur-гүй) | хашаанд өдөр гэрэлтэй утас, лангуун дээр орой харанхуй tablet; `color-scheme`-ээр select/date/radio нийцнэ |
| kds | системийг дагана (tablet-ийн тохиргоо л унтраалга), самбар 20px суурь | гал тогооны гэрэл ээлжээр өөр; band тон 15–32px хоёр сэдэвт уншигдана |
| dashboard (/dashboard, ops.html) | **зөвхөн light**: `<html data-theme="light" data-desk>` + `color-scheme:light` | эзний хүсэлт; өдөржин монитор дээр нягт хүснэгт цагаан дээр найдвартай; screenshot хуваалцах нэг палитр; 14 tab × 2 сэдэв шалгах зардал. Ижил token файл — light талдаа нэг систем. |

Хоёр dark блок (media-guarded ба `[data-theme=dark]`) зэрэгцээ, ижил байх ёстой; хуудасны палитр, сүүдэр, радиус байхгүй.

---

## 7. Хуудас бүрийн шилжилт

Ерөнхий: (а) фонт холбоосыг ижил болгох; (б) `maximum-scale=1` устгах, theme-color нэмэх; (в) хуудасны `:root` token, `.btn/.chip/.lab/.card/.field/.seg/--shadow` дахин тодорхойлолтыг устгах; (г) hover-ыг `(hover:hover)` дор, `:active` нэмэх; (д) inline `<script type="module">` өөрчлөгдвөл API restart (`scratchpad/restart-api.sh` эсвэл серверийг дахин эхлүүлнэ) — CSP hash сервер эхлэхэд тооцогдоно; тест `src/test/pages.test.ts` хуудас бүрийн дараа.

### 7.0 app.css + api.js (эхэлж)

- `src/web/app.css`-ийг `scratchpad/design/app.css`-ээр солино (token, base, `[hidden]`, `color-scheme`, dark ×2, `data-desk`, бүх компонент).
- `api.js`: `money(value)` (innerHTML; `mnt()` хэвээр), `avatar(seed,size)`, `toast(msg,'good')` (CSS бэлэн), `mountClock` markup хэвээр. Гадаад файл — CSP hash өөрчлөгдөхгүй; дуудсан хуудасны inline модуль өөрчлөгдвөл restart.
- Шилжилтийн үед хуудсуудын өөрийн `<style>` давамгайлсаар (specificity, дараалал) — шинэ файл өмнөх хуудсуудыг эвдэхгүй; ялгаа: `[hidden]` reset (idesh `#refund-why`, supplier `.field[data-for]` алдаа засагдана), `.chip::before` цэг supplier чипэнд гарна, `.card.empty` картын харагдацаа алдана, ops `.kpis` gap 12 хэвээр (`.kpi-band` класс нэмэгдтэл), товч/оролт mono-оос sans руу (dine slot, kds pair input өөрийн mono-той хэвээр).

### 7.1 home — `index.html`

Толгой: `.wordmark` 27/600 `--ink` (900 accent биш); «Улаанбаатар» wordmark-ийн `small` eyebrow (эсвэл footer — эзний шийдвэр); `#hello` DOM-д хэвээр, 15/400 `--ink-2`, `#live[data-any]` үед CSS-ээр нуугдана. Live: `#live-list` → `[data-rows]` контейнер (`.card` **биш** — тест `.card` 0 гэж тоолно), `.section-label` дотор; `a.card` мөр бүр `.row` + `.lead .dot[data-tone]` + `.main` (`.venue.title` 15.5/600, `.what.sub`, `.code.meta` + `.chip[data-inline]`) + `.end .val.when[data-size=lg]` 23/600 `--ink` (`${time}<small>${label}</small>` зэрэгцээ, `.when small` sans 11 uppercase); `data-chev`; skeleton 3 мөр token байвал (`data-loading` → `.live[data-loading]{display:block}`). Огноо `9/20` хэвээр (`.when` regex); dayCorner — тест өөрчлөх шийдвэрийн дараа. Tiles: 92 / radius 18 / glyph 34 stroke 1.6 accent / grid `repeat(3,minmax(92px,1fr))` gap 10 14 / name 13/600 / tag mono 11 (9.6 биш) / `:active scale(.97)`; `li > a.app > .tile svg` хэвээр. Footer: hairline + 44px мөрүүд Үйлчилгээний нөхцөл · Нууцлалын бодлого (13/500 `--ink-2`); «Гал тогооны дэлгэц →» CSS-ээр демо гарцын ард (устгах — эзний шийдвэр). Viewport `maximum-scale` устгана, `.wrap` дээд safe-area; desktop — 560 багана ground дээр, footer доор.

### 7.2 dine — `dine.html` + `mapStyle.js`

Chrome: badge + «‹ Basu» → нэг `.topbar[data-fixed]` (back тэргүүлэх ирмэг, `#badge` гарчиг 17/600 + `span` 13 дэд мөр — `#badge span` хэвээр). Газрын зураг token (3.4), control radius 10, scrim token, pin `getComputedStyle(...).getPropertyValue('--accent')`. Sheet (5.10): title = ресторан 20/600 (`#sheet-name` — status дээр `№NNNN` mono, тест), `#sheet-sub` 13, `.x` 44, glass footer + `.summary` (хоол × тоо, slot, нийт `.money` 17) + нэг lg primary (`.sheet footer button` эхнийх = төлөх, «Цагаа сонгоно уу»/«…төлөх» текст хэвээр), `[data-busy]` POST үед (stepper/slot идэвхгүй, `renderFoot` no-op); grip зөвхөн drag холбогдвол. Меню мөр `[data-rows]` + `.row`: 56 thumb radius 8 `--surface-2` хүрээгүй (`.item img` src хэвээр), `.name` 15.5/500, `.meta` 13 `--ink-2` «12 мин» (станцгүй; тест `/\d+ мин/`), `.price` `.money` 15/600 `--ink`, stepper 40px radius 10 SVG − +, `.qty span` mono; sold — `--ink-2` + neutral чип. Slot: header дор sticky glass strip, `.section-title` «Хэдэн цагт ирэх вэ?», 44px pill `.slot` sans 15/500 mono тоо, `[aria-pressed=true]` accent + `--on-accent`, `[disabled]` `--ink-3` line-through. Status: raw enum `.lab` → `.dot` + eyebrow (HEADLINE үг) (JS нэг мөр), `.big` sans 24/600 `--ink` (served ready), цаг mono 32/600 + 13 тайлбар; `.timeline.stepper` (5 li, `data-done`, «·» → хоосон); footer — Хөдөллөө primary, «Үнэгүй цуцлах — HH:MM хүртэл» danger хүрээтэй доор, review Илгээх footer primary (`can_review`), Шинэ захиалга secondary. Од — 24px SVG `--star`/`--ink-3`, 44 бай; Тийм/Үгүй `.seg`. `.note[data-k]` (`#map .note` flow-д, `a[href=/kds]` хэвээр). `.orderbar` span-ууд. ≥900 `.sheet[data-dock]`. Escape: description/by/name `escapeHtml`. #E8A13A, #fff, rgba литерал → token; JS inline style → класс.

### 7.3 idesh — `idesh.html`

Жин 900/800→600 (h1 28, `.listing .name` 15.5, `.status .big` 28→24/600), tracking ≤17 = 0, 27 хэмжээ → масштаб, ≤11 юу ч байхгүй (үнийн суурь 13 `--ink-2`, «АВАХ» 11 sans). `#home` topbar back хэлбэр (тэргүүлэх ирмэг, `.in-shell` дүрэм). `#tally` эхний `.section-label`-ийн `.n` (текст хэвээр). `.trust` — нэг карт, гурван hairline мөр (`.trust div` ×3, nested div байхгүй); ≥640 гурван багана 1px-ээр. `#mine-list` `[data-rows]`, `button.card` → `.row` (гарчиг = IDESH_HEADLINE үг 15.5/600, зар 13, `.when` mono 15/600 + «авах» 11 sans, № meta, `.chip[data-inline]`, chev). `.kinds` → `.filter`. `#listings` `ul[data-rows]`, `li > button.listing.row`: `.art` 64 radius 8 (`.art > img` src хэвээр; ижил stock зураг — эзний шийдвэр), `.name.title`, `.from` 13 + `.verified` `.badge` tint, `.bits` нэг 12.5 мөр, `.price b` `.money` 17/600 `--ink` (`--price` accent устана), `.price small` 13 `--ink-2`, `.left` sm чип (low hold / gone neutral), chev, `:active`. Screen: `.bar` → `.topbar` (гарчиг 17/600, нийлүүлэгч дэд мөр), `.screen-foot` glass, `.sum b` `.money` 22, `#next`/`#pay` `.btn[data-v=primary]` (radius 10, sans 15/600), `#next` ›→SVG, `.why` neutral (`--ink-3`) хүртэл; `.step` (яг 4 блок) — hairline хэсэг + `.section-title` `.n`, `.choice` мөр + 20px radio (`role=radio`, `aria-checked`, `data-r` хэвээр), `.qty` 44 radius 10 SVG; нэг input skin (`#refund` мөн), date native; `.mapbox` `--surface-2` + token pin; `.review` hairline мөр, `.total` `--surface-2` `.money` 22; `.promise` энгийн жагсаалт; `#terms` — навигацийн өмнө `state.form` sessionStorage-д (target=_blank shell-д Safari руу гаргадаг — ServiceView). Status: `.status` карт, `.mark` 48 tone-soft, `.big` 24/600 (текст яг), `.cap` 14, `.timeline.stepper` (4 li, `data-done` 2), `.handcode` → `.codebox` (`b` /^\d{4}$/), `.panel` ×3 `.panel + .panel{border-top:0;margin-top:0}` радиус эхний/сүүлийнх (эхний `.panel .mono` = төлсөн нийт — ops тест), tel `--ink` 500 + дүрс, `.assure` CSS-ээр нуугдана (устгах — эзэн). ≥900 max 960, 2 багана grid, screen 560 panel + scrim. `maximum-scale` устгана; skeleton `#listings`, `#mine`.

### 7.4 supplier — `supplier.html`

`:root{--r;--r-s;--pad;--shadow}`, `html{font-size}`, `.btn/.chip/.lab/.field/.card/.empty/.seg/.tabs/.bar` дахин тодорхойлолт (~80 дүрэм) устгана; `.btn.quiet` alias-аар ажиллана. Wordmark `--ink`; утас `--ink` 500 + дүрс; мөнгө `money()` `--ink` баруун; payout `--ready` зөвхөн төлөгдсөн мөрөнд. Door: карт 420, h2 22/600, нэг өгүүлбэр 15 `--ink-2`, field 44, нэг lg primary, `input.code`; демо (`#demo`, `.demo`, `.venues`) хумигдсан «Демо» `.inset` dashed бүлэг (`.venues button` текст, `.pair input`/`button` эхнийх хэвээр); door бүрийн доор Нөхцөл · Нууцлал + тусламжийн утас (оператор/ТТД — эзнээс). `#apply` — хоёр `.form-group` (ТАНЫ ТУХАЙ / ОЛГОЛТ ОЧИХ ДАНС) нэг картын дотор hairline-аар, данс mono, `#submit` lg, `[name]`/`#back` хэвээр. Frame: `.bar` → `.topbar` (нэр 17/600, `#conn` + үг, `#out` quiet icon + баталгаажуулалт), `.tabs` → `.tabbar` (11/500 шошго), ≥900 `.tabs.sidebar` (`data-desk` matchMedia нэг мөр), `.side` дахь `#conn` → `.conn` класс (`querySelectorAll`), хоёр `h1#supplier` → нэг h1 + `.supplier-name` span. Today: stats бүгд 0 бол нуугдана (JS `renderHome`), үгүй бол `.kpi-band`; lane `.section-title` + `.count`; ticket карт (5.2) — header band lane tone-soft (цэг + lane үг 12.5/500, № mono 15/600, огноо mono 12.5 `--hold` due), `.what` 15.5/600, who/where шошготой мөр, мөнгө хоёр мөр (Нийт `.money` 15; Танд очих `.money` 15 `--ready`), нэг lg primary + quiet Цуцлах; `.reasons` `.inset` + radio (5.4), Болих quiet + confirm `danger[data-fill]`, disabled (5.1); `renderBoard()` `.reasons` нээлттэй үед rebuild-ийг алгасна (JS, restart). Orders: `.tools` search + `.seg`; `.list[data-rows]` + `.order.row` (span, chev, `.amt` `.money` + тайлбар танд/суутгал), ≥900 хүснэгт. Stall: мөр `[data-rows]`, mono тоо + sans тайлбар, Засах secondary sm + Зогсоох quiet sm; `.new` дөрвөн `.form-group` (Юу / Үнэ, нөөц / Хэзээ, хүргэлт / Тэмдэглэл), `.affix` ₮/кг, хүргэлтийн төлбөр checkbox хүртэл disabled, `[data-for]` `[hidden]`-ээр. Money: `.kpi-band` + settlement мөрүүд нэг картад + нөхцөл fact мөр. Profile: fact мөр дээр, дараа field, `#save` lg. `.story.stepper` тон. `.has-tabbar`.

### 7.5 kds — `kds.html`

Самбар: `.board{font-size:20px}` em масштаб; хуудасны `.top` → `.topbar` (`.ticket > .top` scope, дараа JS-д `.t-top`), «Гал тогоо» eyebrow + `#venue` 22/600 (textContent яг), `#conn` цэг + үг `role=status` (`data-stale` → `.stale-strip`), цаг mono 24/600, `#swap` secondary sm. Lane: карт биш — 24px gutter-тэй багана (`repeat(3,minmax(280px,1fr))`), гарчиг 17/600 + `.count[data-tone=neutral]`, өндөр viewport, хоосон `.empty[data-center]` + сүүлийн шинэчлэл mono (`.none` класс хэвээр). Ticket `.card` radius 12 padding 0 — 44px header band lane tone-soft (route / accent / ready), `[data-late]` → stop-soft + `−3 мин хоцорсон` 15/600, `[data-attention]` → stop-soft + `.why` 15/600 sentence-case (текст хэвээр); band-д № mono 20/600, «Ширээ A3» sans 15/600 pill, `.cd` mono 32/600 `--ink` + mono 11.5 тайлбар (хүлээн авах хүртэл / гал дээр тавих / хоцорсон / бэлэн болсон); тэмдэгтэй минут <0, «ОДОО» яг 0 (JS); body 12×16: meta sans 13 `--ink-2` (зочны нэр sans), «СУУСАН» ready цэг pill, мөр «qty × нэр» (qty mono 18/600 эхэнд, нэр 17/400), thumbnail-гүй. Товч: lg primary 56px 16/600, «+5 мин» secondary, «Татгалзах» danger sm доор; шошго яг, `data-lane/late/attention` хэвээр; `:active`, `[data-busy]`. Pairing: `.pair` карт 420, h2 22/600, `input.code`, Холбох lg, нэг тайлбар; hint `<ul><li><code>код</code> нэр</li></ul>` (`el()` firstElementChild алдаа — JS), demo + venues хумигдсан «Хөгжүүлэгчийн горим» (`.venues button` текст хэвээр). ≤820 sticky `.seg[data-fill]` lane сонгох (гурван `.lane` DOM-д, класс-аар нуугдана — тест 3). Poll: ticket id-аар reconcile, 200ms fade. theme-color, apple-touch-icon.

### 7.6 dashboard — `ops.html`

`<html lang="mn" data-theme="light" data-desk>`; `:root{--r…--shadow;--side}`, `html{font-size:15px}`, `.btn/.pill/.lab/.field/.seg/.card/.table` дахин тодорхойлолт устгана (`.pill` = чип). `aside.side.sidebar` (5.12, `.tabs` scroll, `.me`/`.out` pinned, `aria-label`/`aria-current`); ≤900 `.tabbar` + «Бусад» sheet (`button[data-tab]` бүгд DOM-д). `.page-head` 5.9, seg толгойд нэг удаа. Overview: `#alerts` `.alerts[data-rows]` (`button[data-go]` мөр бүр), `#now`/period `.kpis.kpi-band` (`.kpi` ×6), мөнгө `money()` `--ink` (`.money` accent дүрэм устана), үг-KPI `[data-word]` («тэнцсэн», «Scheduler» — `#money .kpi`, `#integrations .kpi` тест). Хүснэгт 5.6 бүгд `.table-wrap`-д (утасны overflow засагдана), sticky th, `.num` mono, утас mono, нэр 500, огноо цагтай, чип sm, `tr[data-link]` + `<a>` код нүд + tabindex. `.card.row` (suppliers/venues/pay) — эхний шатанд `.rows[data-rows]` + `.row` hairline мөр хэлбэрээр (**хүснэгт болгохгүй** — `#applied .row`, `#all .row[data-state]`, `#pay .row .amount`, `[data-a=paid]` тест), ≤720 нэг багана, `.btns` доор, `overflow-wrap:anywhere` `.name small`-аас хасна (нэг үсэг/мөр алдаа), баримт `.facts` шошго/утга, нэг харагдах secondary + `⋯` overflow (бүх `button[data-a]` DOM-д), Батлах primary + Татгалзах quiet зөвхөн хүсэлтийн мөрөнд, `.drawer/.stall/.terms/.code` hook хэвээр. System — integrations статус мөрүүд (цэг + нэр + үг + сүүлд mono), техник (node, migration, ledger key) хумигдсан «Техникийн мэдээлэл» `.code` mono; account type монгол үг + raw key mono `--ink-3` хоёр дахь мөр. Money — reconciliation нэг статус мөр + дэлгэгдэх данс. Back — бүртгэсэн эх (tab + id) + `.crumb`. Select/date 5.4, `#q` autofocus устгана, toast good. `prompt()/confirm()` → sheet — **тусдаа commit**, `window.prompt` stub-тай тест (paid reference) хамт; order-detail `#money` → `#settlements` (Money tab-ийн `#money` хэвээр — тест) тесттэй хамт. Skeleton `…`-ийн оронд; хоосон thead нуугдана. Light-only хэвээр.

### 7.7 terms + privacy

Фонт холбоос нэмнэ (өнөөдөр Helvetica). Давхардсан inline CSS → `app.css` `.doc` (5.24). `.topbar` (sticky glass, chevron back, гарчиг 17/600) — terms back `history.length>1 ? history.back() : '/idesh'` (privacy → `/`), нэг жижиг inline модуль (hash, restart; тест эдгээр хуудсыг нээдэггүй). `.doc-card`, h1 28/600, `.doc-meta` (ХҮЧИНТЭЙ / ХУВИЛБАР / ОПЕРАТОР / ХОЛБОО БАРИХ — утга **эзнээс**, privacy-ийн имэйл `mailto:`), terms-д `.doc-summary` (Үнэ — эцсийнх; Нядлахаас өмнө — 100% буцна; Нядалсны дараа — 10% суутгана; Ирээгүй — 3 хоногт; Буцаалт — банкны данс руу — байгаа текстийг иш татна) + `.toc` 7 хэсэг, зөвшөөрлийн өгүүлбэр `.sub` 15 `--ink-2` (13.7 `--ink-3` биш), h2 `.n` mono counter (текст хэвээр), p/li 15/400/1.6 ≤62ch, `ol` mono counter, hairline хэсэг, scroll-margin, `.back` 44 SVG chevron, safe-area доод, theme-color, `.en` EN eyebrow; хоёр хуудас бие биедээ холбогдоно. Копи, `/terms`, `/privacy`, `href="/idesh"`, `href="/"` хэвээр.

---

## 8. Шилжилтийн дараалал ба шалгалт

Эрсдэл багаас их рүү; шат бүрийн дараа `npm test` (`src/test/pages.test.ts`), inline модуль хөндвөл API restart, 390 ба 1400 screenshot хоёр сэдэвт:

1. **app.css + api.js** (дундын давхарга; token/фонт/жин/радиус/mono/accent/карт — эзний гомдлын бүх зүйл эндээс засагдана)
2. **terms + privacy** (тестгүй, JS-гүй, фонт нэн даруй засагдана)
3. **home** (жижиг, нэг тестийн блок, `.card`/`.when`/`.chip` дүрэм)
4. **kds** (lane/товчны тест, hint-ийн JS, band)
5. **idesh** (олон тест, гол нь CSS; `.trust`/`.step`/`.timeline` тоо)
6. **supplier** (тест + JS: renderBoard алгасалт, `#conn`/`#supplier` давхардал)
7. **dine** (газрын зураг, sheet, JS: status label, slot, busy, summary)
8. **dashboard** (хамгийн их JS ба тест; хүснэгт, overflow цэс, confirm sheet, origin back — тусдаа commit-уудаар)

Хоёр дахь шат (JS): KDS reconcile, supplier `.reasons` алгасалт, idesh terms sessionStorage, ops prompt→sheet + tables + origin back, dayCorner + тест, `/fonts` self-host, dark map.

---

## 9. Эзний шийдэх асуултууд

1. Terms/privacy meta: операторын хуулийн нэр, ТТД, хувилбар, холбоо барих (privacy `basuappmn@gmail.com` vs профайлын `tuslah@basu.mn`, `basu.burzai.cloud` vs `basu.mn`) — юу ч зохиохгүй.
2. Home: «Өнөөдөр юу хийх вэ?», «Улаанбаатар», «Гал тогооны дэлгэц →» — CSS-ээр нуух уу, устгах уу (текст устгах нь эзний шийдвэр).
3. Idesh зарын зураг: төрөл×нэгж тус бүрийн зураг (бүтэн мал / кг) эсвэл нийлүүлэгчийн бодит зураг, үгүй бол зураггүй мөр — давтагдсан stock render итгэл алдуулна.
4. Supplier cancel confirm: «Цуцлах» хоёр удаа vs «Захиалгыг цуцлах» (копи өөрчлөлт).
5. Demo цагийн strip: дээд нам strip (одоогийн) vs доод pill (`api.js`-д 2 мөр toggle).
6. `--ink-3` (#62727A/#84949B), `--accent-ink` (#A84206) — `DesignTokens.swift`-д зөөх үү (shell ба WebView нэг саарал)?
7. Ops зөвхөн light, supplier/kds систем дагана — батлах уу; ops утсанд гэрэлтэй гарна.
8. Фонтыг `/fonts`-оос self-host хийх үү (офлайн/Google хамааралгүй)?
9. `9/20` огноо: хэвээр (тест) эсвэл «Ня 20 · 9-р сар» + тест өөрчлөх?
10. Ширээний JS ажлын хугацаа (prompt→sheet, хүснэгт+overflow, origin back) — хоёр дахь шат гэж хүлээн зөвшөөрөх үү?

---

## Хавсралт А. Эвдэж болохгүй зүйлс

Бүх хуудсанд: (1) хуудас бүр яг нэг `<script type="module">…</script>` (атрибутгүй — тест `/<script type="module">([\s\S]*?)<\/script>/` эхнийхийг авна); import `import { … } from '/api.js';` / `'/mapStyle.js';` / `'/sidenav.js';` хэлбэрээр (тест гурвууланг нь inline хийнэ; `sidenav.js` import-гүй, дээд түвшний нэр бүр `nav`/`NAV`-аар эхэлнэ) мөрийн төгсгөлд (regex `/^\s*import[\s\S]*?from\s*'\/[\w.]+';?$/m`); хоёр дахь inline script hash-лагдана, тест ажиллуулахгүй. (2) `src/api/hardening.ts` inline script бүрийг сервер эхлэхэд SHA-256 хийнэ — JS өөрчлөгдвөл restart; `hardening.test` хуудас бүрт нэг hash. (3) `localStorage` түлхүүр `basu.guest`, `basu.device` (`all-kitchens` sentinel), `basu.supplier` (`all-suppliers`), `basu.ops`, `basu.ops.tab/.period/.money/.notify` (`basu.ops.tab` = ширээний сүүлийн хуудас), `basu.dash.ws` (сүүлийн ажлын орчин), `basu.dash.page.<orgId>`, `basu.nav.shut`; `sessionStorage ops.code.<id>`. (4) `#toast` (api.js үүсгэнэ, `role=status`, `data-show`, `data-kind=bad`) — тест timeout дээр уншина. (5) `html.in-shell` (api.js shell дотор). (6) `.clockbar` markup: `.lab` «Демо цаг», `#clock-now.now.mn`, `button[data-to|data-advance|data-tick][data-hot]`. (7) Бүх монгол копи үг үсгээрээ хэвээр; `№`, `·`, `₮` (`mnt()`), `—`.

### home (`index.html`)
- Тест: `.app` яг 2 (basu.guest байхгүй үед) — `app` классыг өөр зүйлд хэрэглэхгүй; `.app[data-app="dine"]` `<a href="/dine">`, текст «Хоол», дотор `.tile svg`; `[data-app="idesh"]` `/idesh`, «Идэш», `.tile svg`; `.card` 0 (гарсан үед) — `.card` зөвхөн live мөрөнд, контейнер/grid-д биш; dine захиалгатай бол эхний `.card` `<a>` текст = ресторан, href `/^\/dine\?order=[0-9a-f-]{36}$/`; `.card[data-source="Идэш"]` href `/^\/idesh\?order=[0-9a-f-]{36}$/`, `card.querySelector('.chip').textContent === 'Төлсөн'` (PAID; зөвхөн үг), `.when` textContent `/^\d{1,2}\/\d{1,2}авах$/` (`${row.time}<small>${row.label}</small>` зэрэгцээ, зайгүй).
- JS: `#apps` (ul, append + `[data-app="supplier"]`), `#live` (`dataset.any` / `removeAttribute`), `#live-list` (`replaceChildren`), `#hello` (хэрэглэгддэггүй, үлдээж болно); tile `<li> > a.app[data-app][href] > .tile(svg) + .name + .tag` (`closest('li').remove()`); мөр `a.card[href][data-source] > span.who > .venue .what .code(«${source} · №${code}» + span.chip[data-s]) ; span.when`; `.live:not([data-any]){display:none}`; `data-app` dine|idesh|supplier, `data-source` Хоол|Идэш, `data-s` төлөв, `data-any` тоо.
- Копи: «Улаанбаатар», «Өнөөдөр юу хийх вэ?», «Идэвхтэй», «Аппууд», «Гал тогооны дэлгэц →»; «Хоол» «Идэш» «Нийлүүлэгч»; «урьдчилсан» «өвлийн» «миний зар»; SUB; «бэлэн» «гал» «суух» «буцаалт» «ирэх» «авах»; `${title} ×${qty} · ${cap}`. Холбоос `/dine /idesh /supplier /kds`. Boot: `mountClock(() => loadLive())`, `loadLive()`, 4000ms poll (hidden алгасна, pagehide clear), 401 → `store.guestToken=null`. `<link rel="stylesheet" href="/app.css">` + Google Fonts (өөр гадаад CSS хориотой). `<html lang="mn">`, `<title>Basu</title>`.

### dine (`dine.html`)
- ID: map, badge (`$('badge').querySelector('span')` — `<span>` хүү), home, scrim, sheet, sheet-name, sheet-sub, sheet-walk, sheet-close, sheet-body, sheet-foot, orderbar, ob-code, ob-what, ob-when; `#toast`, `#clock-now`.
- Атрибут: `data-open` (#sheet, #scrim, #orderbar — тест `hasAttribute`), `data-s` (.status), `data-done` (.timeline li), `data-sold` (.item), `data-d="-1"|"1"` (.qty button — тест `.item` дотор `button[data-d="1"]`), `aria-pressed`/`disabled` (.slot), `data-on` yes|no (.stars, .ontime), `data-a` yes|no, `data-size="sm"` (.stars), `data-v` primary|danger, `data-size=lg`, `data-good`, toast/clockbar атрибут, `html.in-shell`.
- Класс (тест): `.item` (>3; «Цуйван»/«Хуушуур»/«Салат»), `.item img` (`/^\/dishes\/\w+\.svg$/`), `.item .meta` (`/\d+ мин/`), `.item .price` (₮), `.sheet`, `.sheet footer button` (жинхэнэ `<footer>` доторх **эхний** товч = төлөх; «Цагаа сонгоно уу» → «…төлөх» «28,000₮»; `$('sheet-foot').querySelector('button')`), `.slot` (текст 12:30/13:15/13:00/13:30/12:45), `.status`, `.timeline li` (яг 5), `.sheet .note`, `.sheet .item` (хаалттай = 0), `#map .note`, `.note a[href="/kds"]`, `#map canvas, #map`.
- Текст: `${n}/${n} ресторан`, «Цуйван», «мин алхаад», «гал дээр гарахаас өмнө», «Цагаа сонгоно уу», «төлөх», «28,000₮», `/№\d{4}/`, `#ob-code` `/^№\d{4}$/`, `#sheet-name` = `№NNNN`, «Ширээ», «Үнэгүй цуцлах», «захиалга авахгүй байна», «нэг ч гал тогоо холбогдоогүй», «Нэвтэрч орно уу» **байхгүй**; `#sheet-sub` status дээр ресторны нэртэй.
- Map: `window.__map`, `window.__style`, `new maplibregl.Map/NavigationControl/GeolocateControl`, stub арга (on, addControl, addImage, addSource, getSource, addLayer, easeTo, getCanvas; geolocate.on/trigger; source.setData), `fitBoundsOptions.pitch > 0`, source `venues` ({id, open, label}), layer `venue-pin` (click), ≥3 `route-*` layer, `line-dasharray` тоон массив. `scripts/probe-route.mjs`: `__map.getSource('venues')`, `fire('click')`, `#sheet-name`, `#sheet-walk`, `#sheet-close`.
- Бүтэц: `.sheet > header/footer` жинхэнэ таг (`footer:empty`), `.status > .lab .big .cap + ul.timeline > li > span.t + span.w`, `.review > .row/.ontime/textarea`, `.said > .summary/.one/.none`, `.stars > button`, `.rating > i/em`, `.walk > span/b/.guess`, `.qty > button/span/button`, `.slots > .slot`, `.slothead`, `p.empty`, `p.terms > b`, `.note > b/span/a`, `.orderbar > div > .code/.what + .when`.
- Копи JS-д: «Цэс ачаалж байна…», «Хэдэн цагт ирэх вэ?», «Хоол гал дээр гарахаас өмнө үнэгүй цуцална.», «Цагаа сонгоно уу», «… төлөх», «Түр хүлээнэ үү…», «Дууссан», «Одоогоор захиалга авахгүй байна», «Одоогоор нэг ч гал тогоо холбогдоогүй» (+/kds), «Үнэгүй цуцлах», «Хөдөллөө», «Шинэ захиалга», «Е-баримт»/«Сугалаа», «Хоол ямар байв?»/«Таны үнэлгээ», «Дараагийн хүнд тусална. Заавал биш.»/«Өөрчилж болно.», «Хоол цагтаа ирсэн үү?», «Тийм»/«Үгүй», «Сэтгэгдэл (заавал биш)», «Илгээх»/«Шинэчлэх»/«Илгээж байна…», «Хоолтой хүмүүс юу гэсэн бэ», «N үнэлгээ», «N% цагтаа ирсэн», «цагтаа ирээгүй», «Одоогоор бичсэн сэтгэгдэл алга.», «үнэлгээ алга», STEPS, «Ширээ N», «мин алхаад», «захиалга авч байна»/«хаалттай», «ойролцоогоор», «Үдийн хоол», «Ирэхээс чинь өмнө гал тавина», «‹ Basu», aria «Хаах»/«Хасах»/«Нэмэх»/«N од»/«Basu нүүр»/«Ресторан», HEADLINE.

### idesh (`idesh.html`)
- ID (статик): list, home, tally, mine, mine-list, kinds, listings, screen, screen-back, screen-title, screen-sub, screen-body, screen-foot; (JS): step-qty, qty, sumline, step-receive, step-when, when, step-where, address, phone, mapbox, maptip, next, pay, terms, refund, bank, banks, account, holder, otp-step, otp, refund-why, send-account, toast.
- Класс: wrap top sub home tally trust mine sec card who venue what code chip when kinds listings listing art name from verified bits row left price empty screen bar back bar-title screen-body screen-foot foot-row sum why btn hero head about facts lab money step q n help qty sumline choice dot txt tag field mapbox tip note review r total mono promise terms status mark big cap timeline d w s handcode panel line v badge assure t.
- Атрибут: `#mine[data-any]`; `.kinds button[data-kind][aria-pressed]`; `.listing[data-kind][data-id][data-gone]`; `.left[data-low|data-gone]`; `#screen[data-open]`; `.qty button[data-d][disabled]`; `.choice[role=radio][data-r=pickup|delivery][aria-checked][disabled]`; `[role=radiogroup]`; `.status[data-s]`; `.chip[data-s]`; `.timeline li[data-done][data-next]`; `.why[data-calm]`; `.btn[data-v=primary][data-size=lg]`; `#screen-foot`-д `[data-v="danger"]` **хэзээ ч** байхгүй; `.card[data-order]`; `#otp-step[hidden]`; `#refund-why[hidden]`; `#when[min][value]`; `#address/#phone/#bank/#account/#holder/#otp` утга/`input`; `#send-account[disabled]`; `#next[disabled]`.
- Тоо: `.trust div` === 3 (nested div байхгүй); `.step` 3 (pickup) / 4 (delivery); `.timeline li` 4 (pickup); `.timeline li[data-done]` 2 (PREPARING); `.listing` ≥ seed; `.art img` шууд хүү, src `/^\/idesh\/(sheep|goat|beef|horse)\.jpg$/`; `#step-where #address`; `.review .total b`; `.panel a[href^="tel:"]`; `#screen-foot a[href^="tel:"]`; `#screen-foot .why/.sum span/.sum b`; шинэ status дэлгэцийн **эхний** `.panel .mono` = төлсөн нийт (ops тест).
- Текст: `#tally` `/^\d+ зар · \d+ гэрээт нийлүүлэгч$/`; `.from .verified` «Гэрээт»; `.price b` ₮-ээр төгсөнө; `.price small` «кг»; `.bits` `/-р сарын \d+-нөөс/`; `.left` `/үлдсэн|Дууссан/`; «бүтэн», «Хүргэлттэй»; `#kinds` «Үхэр»; `.choice[data-r=pickup]` aria-checked true default; `#when` `/^\d{4}-\d{2}-\d{2}$/`; `#screen-title` = зарын нэр / `/^№\d{4}$/`; `#screen-sub` нэртэй; `.status .big` яг «Захиалга баталгаажлаа» / «Мах бэлтгэгдэж байна» / «Мөнгө буцаасан»; `.status .cap` «банкны данс»; `.handcode b` `/^\d{4}$/`; `#screen-foot a[href^=tel:]` «залгах»; `#screen-foot .why` «Хаяг»; `#screen-foot .sum span` «хүргэлт»; `#refund` дансны цифр + «Basu ажлын өдөрт»; `.review .total b` ₮.
- Зан үйл: `document.body.style.overflow`, `history.pushState({screen})`/popstate, `?order=`, `basu.guest`, `.screen[data-open]`, `[hidden]` (#otp-step, #refund-why — reset нь засвар), `.foot-row`/`.why` renderFoot бүрт дахин, `#screen-body/#screen-foot` replaceChildren; `<script src=maplibre>` src хэвээр.

### supplier (`supplier.html`)
- `#root`; нэг module block, `import { … } from '/api.js';` нэг мөр.
- Тест: `.door #back` (sign-in, apply, application картад); `.venues button` («Бүх нийлүүлэгч» + нэрс), `button[data-watched]`, `.tag`; `.pair h2` яг «Дэлгэцээ холбоно уу»; `.pair input` 8 оронтой prefill, `.door.pair` дотор **эхний** input = код, **эхний** button = «Холбох»; `a#become` `.links`-д; `.ticket` (`№${code}`, «Танд очих», «Өөрөө ирж авна»), `.ticket[data-lane]` paid|preparing|ready|dispatched (paid→preparing), товч «Бэлтгэж эхлэх»; `.ticket [data-a="cancel"]`; `.reasons` ticket дотор; `.reasons [data-a="confirm"]` disabled хүртэл; `.reasons input[value="guest_asked"]` (change bubbling `.reasons`); `.reasons .money` «бүтнээр»; `[data-a="keep"]`; `#board[data-ready]`; 3000ms poll (`#board` байвал; replaceChildren + scrollY); `.tabs button[data-tab="stall"]`; `.tabs button[data-tab]` 5 (эзэн, менежер, дэлгэц) / 4 (ажилтан — Мөнгөгүй) / 3 (нягтлан: orders money profile) / 1 (all-suppliers) — `/v1/supplier/seat`-ийн эрхээр; `data-on`; `#out` (утсан дээр; ширээнд `.acct #out`); `?org=<id>` → `x-basu-org` толгой, dashboard-ын session; `.stall .row[data-listing]`, `.stall .row .name`; `.new h3` яг «Шинэ зар нэмэх»; `.new [name=title|price_mnt|approx_kg|quantity|origin]`; `#add`; `#apply`, `#apply [name=name|tin|address|about]`, `#submit`; `#application .status[data-s="applied"]`, `#application .big` яг «Хүлээгдэж байна»; `#supplier` textContent = нэр (эхнийх; JS querySelectorAll).
- ID: signin, send, back (×4), demo, become, apply, submit, banks, application, pair-now, again, supplier, conn, out, out-side, view, today-line, home, board, q, orders, act, stall, money, otp-step, save, add. name: phone, code; name, tin, address, about, bank_name, bank_account, bank_holder; kind, unit, title, price_mnt, approx_kg, min_qty, quantity, origin, ready_from, delivery_fee_mnt, delivers, note; price, quantity, ready; otp_code; reason-<orderId>.
- Класс: .otp .foot .card .demo .hint .venues .tag .stack .group.lane h3 .n .ticket .btns (inline display) .reasons .money .tabs .seg .seg button[data-scope][data-on] .list .order[data-order] .order-page .story .head .rows .row[data-listing][data-off][data-editing] .nums .num .name .new .grid .wide .money-sum .stat b.money .terms .line[data-settlement] .amt.paid .profile .empty .status .big/.cap .code .shell .bar .view .tabs .side .out .brand .conn[data-stale] .back a.tel .chip(.day)[data-s] .id .top .what .who .where .pay .grace .tools .stall .orders .t .s .right .q.
- data-: v, size, s (PAID PREPARING READY DISPATCHED HANDED CLOSED CANCELLED REFUNDED paid due applied contracted declined ''), a (cancel keep confirm edit toggle back save), lane, due, for (whole|kg)+hidden, on, tab, scope, watched, listing, editing, off, order, settlement, stale, ready, show/kind.
- `hidden`: .otp, #otp-step, label.field[data-for] — `[hidden]` reset заавал. Текст: «Код авах»→«Нэвтрэх», «Холбох», «Хүсэлт илгээх», «Энэ кодоор холбох», «Дахин хүсэлт гаргах», «Бэлтгэж эхлэх», «Бэлэн боллоо», «Замд гаргах», «Хүлээлгэн өгсөн», «Цуцлах», «Болих», «Засах», «Зогсоох»/«Идэвхжүүлэх», «Хадгалах», «Зар нэмэх», «Гарах»/«Солих», Өнөөдөр/Захиалга/Зар/Мөнгө/Профайл, Идэвхтэй/Дууссан/Бүгд, «Бүх нийлүүлэгч», LANES, REASON/REASON_SHORT/STATE_WORD/EVENT_WORD, «Танд очих», «Өөрөө ирж авна», «бүтнээр». Бүтэц: renderTicket `.reasons`-ыг `article.ticket`-ийн хүү; openOrder `#act`-д renderTicket, `.btns` хасна; renderRow мөрийг байрандаа солино; renderStall `#stall` + `.head`; show() `#view` цэвэрлээд 0 руу.

### kds (`kds.html`)
- Тест: `.lane` яг 3 (самбар дээр; 4 дэх байхгүй, өөр газар класс хэрэглэхгүй); текст «Ирж явна», «Гал дээр», «Бэлэн»; `.ticket` бүр нэг элемент, текст = хоолны нэр («Хуушуур») + товчны шошго, `ticket.querySelectorAll('button')`, `clickText(kds,'.ticket button','Одоо тавь')`; шошго яг «Хүлээн авах», «Татгалзах», «Одоо тавь», «+5 мин», «Бэлэн боллоо» (+«Гардуулсан») текстээр; `.ticket[data-lane="cooking"]`; `.venues button` (`.venues` дотор `<button>`, текст «захиалга авч байна», нэр, «Бүх гал тогоо»); `.pair` = pairing дэлгэц, `.pair input` `/^\d{8}$/` prefill (`/dev/pairing-codes devices[0].code`), `.pair button` «Холбох» — `card.querySelector('input'/'button')` **эхнийх**; «Таблетаа холбоно уу»; `#venue` textContent **яг** нэр / «Бүх гал тогоо» (зай, дүрс, тоо байхгүй); `#swap` click → pairing; `basu.device`, `all-kitchens`.
- JS: `#root` (replaceChildren), `.board`, `.stack`, `.btns`, `#swap`, `#conn` (textContent «холболт тасарсан», `dataset.stale`); data-lane, data-attention, data-late, data-watched, data-stale, data-v, data-size; классууд pair hint or venues tag top(хуудас + ticket) clock mn swap conn board lane stack none ticket id cd why where meta lines btns btn.
- Копи: «Таблетаа холбоно уу», «Менежерээс авсан 8 оронтой кодоо оруулна уу.», «Холбох», «Холбоогүй ресторанны кодууд:», «эсвэл демо горимоор», «Бүх гал тогоо», «{n} ресторан», «захиалга авч байна», «хаалттай», «Ресторан алга. npm run seed ажиллуулна уу.», «Гал тогоо», «Солих», «холбогдсон», «холболт тасарсан», «—», «✓», «ОДОО», «{n} мин», «№{code}», «Багтаамж дүүрсэн — гараар шийд», «{n} хүн», «Ширээ {t}», «СУУСАН», «×{qty}», товчнууд; `<title>Гал тогоо — Basu</title>`; placeholder «········», aria «Холбох код».
- API: `/dev/pairing-codes`, `/dev/venues`, `POST /v1/kds/pair`, `POST /dev/kds-token`, `GET /v1/kds/tickets` / `/dev/kds/tickets`, `POST /v1/kds/tickets/:id/{accept|reject|fire-now|hold|ready|served}` (+/dev), хариу `{now, watching, lanes:{incoming,cooking,ready}}`, ticket талбарууд. 3000ms poll (hidden/deviceToken), pagehide clear, mountClock(refreshBoard), 401 → pairing, scroll хадгална, `input.select()`, Enter.

### dashboard (`ops.html`)
- ID: root, view, out, send, org-list, org-new, front, ask, ask-open, save-name, sessions, revoke-others, save-org, org-log, org-kpis, desk-roles, alerts, banner, now, cross, msgs, q (view бүрт нэг), guests, idesh-rows, acts, why, note, reason, venues, restaurant, supplier, day, lunches, reviews, orders, money (Money tab **ба** order-detail settlements — сүүлийнхийг тесттэй хамт л солино), run, csv, kind, from, to, topupState, receiptState, transfers, topups, receipts, notify, messages, channel, state, system, integrations, settings, save-settings, applied, all, new, add, pay, audit, members, add-member, back (×3), toast.
- Класс (JS): .app (frame guard), .tabs, .tabs button, .page-head (seg append), .seg, .seg button, .kpis, .rows (#applied/#all), .btns, .drawer, .stall, .terms, .pair, .card(.empty), tbody, h2 (flowSection), .pair input/button.
- data-: tab, on (boolean tabs/seg; **'true'/'false'** menu button[data-item]), badge, hot, p, m, n, scope, go, level, tone, guest, link, order, lunch, venue, state (applied|contracted|declined|on|off), supplier, settlement, kind (payout|refund), paid, message, integration, key, item, retry, sid, device, off, s, v (primary|danger|quiet), size (sm|lg), a (approve decline bank-verify code listings active terms close save tablet menu revoke cancel no-show resend hand paid), toast show/kind.
- name: phone, code; name, phone, tin, address, lat, lon, bank_name, bank_account, bank_holder; commission_pct…; phone, name, role.
- Тест: `.pair input` эхнийх prefill token; `.pair button` «Нэвтрэх»; `.tabs button[data-tab="<key>"]` (pay suppliers guests venues lunches money notify system overview); `[data-tab="overview"][data-on]`; `.tabs .grp` эхнийх «Платформ»; `.ws-btn` байгууллагын нэр + «Нийлүүлэгч · Ажилтан»; `.tabs a[data-tab="idesh.orders"]` href `/supplier?org=<id>#orders`; `.nav-group[data-group="dine"]` нийлүүлэгчид байхгүй; `.table.roles th.yours`; `tr[data-member]`, `[name=contact]`, `[data-find]`, `[data-found] select`, `[data-add-go]`; `#org-log li` «… нэмэгдсэн · нягтлан»; `#now .kpi` === 6; `#alerts .alert` текст; `#alerts button[data-go="suppliers"]`; `#now` «Зочдын түрийвч»; `#cross` «Борлуулалт»; `#banner`; `#applied .row` («Завхан», «Түмэн-Өлзий», «+97688010011»), `[data-a="approve"]` мөрөнд; `#all .row[data-state="contracted"]`; `#pay .row` («Буцаалт», `№<code>`, «5012345678», «KB-2026-001»), `.row .amount` **яг** = форматласан нийт, `[data-a="paid"]`, `data-paid`, `window.prompt` stub; `#guests tr[data-guest]` («+97699001122»), `#q` input event; `.detail .facts`; `.page-head` утастай; `.facts` «Түрийвч»; `.section > h2` «Түрийвчийн хуулга», «Хоолны захиалга», «Идэшний захиалга», «Мэдэгдэл», «Хоол», «Явц»; `.section table tbody tr` > 0; `#venues [data-venue]` («Өнөөдөр»), `button[data-a="tablet"]`, `button[data-a="menu"]`, `#venues .drawer tbody tr`, `#venues .drawer button[data-item]` === «Нуух»; `#lunches tr[data-lunch]`; `.detail .story`; `.page-head h1` «№»; `#money .kpi` === 6, эхнийх «тэнцсэн»; `#money table` «QPay · клиринг»; `#run`; `.page-head .seg button` «Гүйлгээ»; `#transfers tr` («→»); `#csv` === «CSV татах»; `#messages li[data-message]` `/SMS|Push/`; `#integrations [data-integration]` === 4; `#integrations .kpi` эхнийх «Scheduler»; `#settings input[data-key="desk_banner"]`, `#save-settings`, «Демо».
- Копи: «Нэвтрэх», «Код авах», «Гарах», Basu/Хоол/Идэш/Ширээ, tab шошго, «CSV татах», «Нуух»/«Харуулах», «Батлах», «Татгалзах», «Шилжүүлсэн», «Очих», «Зарлал.», «Хадгалах», хэсгийн гарчгууд, KPI «Зочдын түрийвч», «Scheduler», «Ledger» «тэнцсэн», STATE_WORD/DINE_WORD/EVENT_WORD/REASON/ROLE_WORD/TEMPLATE_WORD/MSG_WORD/KIND_WORD/TOPUP_WORD/RECEIPT_WORD/ACTION/REPORT_WORD, «№», « · ».
- Бүтэц: `view.lastElementChild.replaceWith/remove()` (loading `.empty` сүүлийн хүү), members `tr.lastElementChild.append(button)` (5 дахь td сүүлд), `card.append(drawer)` `.card.row`-д, `row.append(.code)`, ICON svg, mountClock import **байхгүй**, loader бүр `getElementById` + `tab !== key` guard — id яг.

### terms / privacy
- Тестгүй, JS-гүй (script нэмвэл hash — restart). `server.ts:873-874` `/terms`, `/privacy` → `sendFile('terms.html'/'privacy.html')` (нэр, зам хэвээр; iOS `ProfileView.swift` `https://basu.mn/terms|privacy`; `idesh.html` `<a href="/terms" id="terms">`). Back: terms `href="/idesh"`, privacy `href="/"` (ServiceView `isHome`). Head: `lang="mn"`, viewport-fit=cover, `/app.css`, titles «Өвлийн идэш · Үйлчилгээний нөхцөл», «Basu · Нууцлалын бодлого». Копи: бүх h1/h2/p/li, «10%», «3 хоногт», «2026 оны намраас», «Хүчинтэй: 2026 оны 9-р сарын 10», «basu.burzai.cloud», `basuappmn@gmail.com` (×2), 6 `<ol>` дүрэм, 11 `<ul>` баримт, англи хураангуй. Семантик: `<main>`, h1>h2, `<ol>`, `<ul>`, `<section class="en">`, `<b>`.

## Хавсралт Б. Шүүгчдийн хассан зүйлс (давтахгүй)

11px-ээс жижиг веб шошго (native 10/9.5/9); 16px-ээс жижиг оролт утсанд; 40/32px товч утсанд + `::before` hit-area; dot-only чип default (supplier/KDS/ширээнд); `dayCorner` тестгүйгээр; ops статус-KPI-г `.kpi`-гүй мөр болгох; `@import`-only фонт; `background-attachment:fixed`; карт/жагсаалт дээр blur; `.kpi` negative-margin, seg thumb float сүүдэр; CANCELLED/REFUNDED/NO_SHOW/REJECTED улаан цэг; demo strip-ийг hostname-аар гаргах; бүх холбоос #A84206 (зөвхөн текст — дүүргэлт #C64E08 хэвээр); `#money` бүх нэрийг солих; ops мөрүүдийг эхний шатанд `<table>` болгох; idesh `.art img` хасах; `target=_blank` terms; бүх товч 600; accent-soft дээр #C64E08 текст; хуудасны `:root` блок үлдээх; монгол текст устгах; JS зан үйлийн өөрчлөлтийг эхний CSS шаттай хамт.
