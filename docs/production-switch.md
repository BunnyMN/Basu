# Production-д шилжих шалгах хуудас

_Pilot сервер (basu.burzai.cloud) демо горимоос бодит худалдаанд шилжих
өдрийн өмнөх орой хийх ажил. Дараалал чухал; хугацаа ойролцоогоор нэг цаг._

> **2026-09-23-нд шилжсэн.** 1–3-р алхмыг `scripts/deploy.sh` нэг удаа
> өөрөө хийсэн: демо DB-г `/root/basu-demo-final.sql.gz`-д хадгалж хэвээр
> үлдээсэн, шинэ хоосон `basu_prod` үүсгэсэн, `.env`-ийг production болгож
> (хуучныг `.env.demo`), `BANK_KEY` үүсгэсэн, scheduler асаасан. Нэвтрэлт нь
> SMS биш нууц үгээр; ops-д зөвхөн урилгын кодоор орно — эхний admin-ийн
> кодыг deploy өгсөн, дараагийнхыг admin «Гишүүд»-ээс үүсгэнэ. Одоо дутуу:
> Wire түлхүүр (түүнгүй бол цэнэглэлт хаалттай), SMS, PosAPI, backup.
>
> **2026-09-24:** нэвтрэх үндсэн хаалга нь **Google** ба **имэйлээр ирсэн
> код** боллоо (SMS түр хойшилсон); утас + нууц үг хуучин бүртгэлүүдэд
> хэвээр. Хоёулаа `.env`-ийн түлхүүрээр нээгдэнэ — §2a.

## 0. Өмнө нь бэлэн байх ёстой (танаас хамаарна)

- [ ] `OPS_MEMBERS` — ops-ийн гишүүдийн утас, нэр, эрх (`+976…:Нэр:admin`, санхүүгийн хүн `finance`).
- [ ] Имэйл илгээх SMTP (Gmail-ийн app password, эсвэл Resend/Brevo) — нэвтрэх код ба мэдэгдэл имэйлээр явна (§2a).
- [ ] Google OAuth client (Web application) — «Google-ээр нэвтрэх» товч (§2a).
- [ ] CallPro-ийн API түлхүүр — SMS; одоохондоо хойшилсон, имэйл код түүний оронд.
- [ ] Wire (wire.mn) дансны `sk_live_…` түлхүүр ба webhook-ийн `whsec_…`. Wire нь QPay-г дамжуулна; dashboard дээр QPay холболт ба орлого татах данс тохируулсан байх ёстой.
- [ ] PosAPI 3.0 оператор бүртгэл, posNo; эхний нийлүүлэгчийн ТТД зөвшөөрөгдсөн.
- [ ] Эхний нийлүүлэгчийн гэрээ, данс — ops-оор бүртгэнэ (демо өгөгдөл биш).
- [ ] Apple review батлагдсан (App Store-д «Release» дарахад бэлэн).
- [ ] Backup гадагш хадгалах газар (S3-төст данс) ба түлхүүр.
- [ ] `BANK_KEY` — банкны дансыг шифрлэх түлхүүр: `openssl rand -base64 32`. **Энэгүйгээр production данс хадгалахаас татгалзана.** Түлхүүрээ backup-аас тусад нь хадга: хоёулаа хамт алдвал шифрлэлт утгагүй, түлхүүрээ дангаар нь алдвал данс уншигдахгүй.
- [ ] Ops-д дор хаяж **хоёр** гишүүн мөнгө хөдөлгөх эрхтэй (`admin`/`finance`): олголтыг нэг нь батлаад, нөгөө нь шилжүүлнэ.

## 1. Демо өгөгдлийг хадгалж, шинэ DB үүсгэх

```bash
# демог дараа үзүүлэхэд хэрэгтэй: бүтнээр нь хадгална
sudo -u postgres pg_dump -p 5433 basu | gzip > /root/basu-demo-final.sql.gz
# бодит DB — хоосон, зөвхөн миграц, seed ХИЙХГҮЙ
sudo -u postgres createdb -p 5433 basu_prod
```

## 2. `.env` (сервер дээр, `/opt/basu/app/.env`, `chmod 600`)

```
BASU_MODE=production
NODE_ENV=production
DATABASE_URL=postgres://…:5433/basu_prod
PORT=3210
OPS_MEMBERS=+97688102856:Баярцогт:admin,+976XXXXXXXX:Нэр:finance
BANK_KEY=              # openssl rand -base64 32 — банкны дансны шифрлэлт
# OPS_TOKEN — устгана: production-д ямар ч утга хүчингүй
SMTP_URL=              # smtps://…@smtp.gmail.com:465 — нэвтрэх код, мэдэгдэл (§2a)
MAIL_FROM=             # "Basu <…@gmail.com>"
GOOGLE_CLIENT_ID=      # …apps.googleusercontent.com (§2a)
GOOGLE_CLIENT_SECRET=  # GOCSPX-… — зөвхөн сервер дээр
CALLPRO_…=            # SMS — хойшилсон
WIRE_SECRET_KEY=       # sk_live_… — Wire → QPay
WIRE_WEBHOOK_SECRET=   # whsec_… — байхгүй бол апп өөрөө асууж шалгана
WIRE_RETURN_URL=https://basu.burzai.cloud/
POSAPI_URL=http://127.0.0.1:7080
APNS_TEAM_ID= APNS_KEY_ID= APNS_KEY_FILE=/opt/basu/apns.p8 APNS_ENV=production
```

Шалгах: `.env`-д OPS_TOKEN алга, `BANK_KEY` байгаа, файл root-only.

## 2a. Имэйл код ба Google нэвтрэлт

Хоёулаа `.env`-ийн мөрөөр нээгдэнэ; тавиагүй бол товч нь хуудсан дээр
харагдахгүй, утас + нууц үг ганцаараа үлдэнэ. Тавьсны дараа
`systemctl restart basu-api`, дараа нь
`curl -s https://basu.burzai.cloud/v1/auth/methods` — `"email":true,"google":true`.

**Имэйл (SMTP).** Хамгийн хурдан нь Gmail:

1. Илгээх Gmail данс (жишээ нь `basu.noreply@gmail.com`) → Google Account →
   Security → 2-Step Verification асаана.
2. Security → **App passwords** → нэр «Basu» → 16 үсэгтэй нууц үг гарна.
3. Сервер дээр `/opt/basu/app/.env`:
   ```
   SMTP_URL=smtps://basu.noreply%40gmail.com:xxxxxxxxxxxxxxxx@smtp.gmail.com:465
   MAIL_FROM="Basu <basu.noreply@gmail.com>"
   ```
   `@`-г `%40` болгож бичнэ; app password-ын зайг хасна. `MAIL_FROM` нь
   тэр Gmail хаяг өөрөө байх ёстой — өөр хаяг бичвэл Gmail сольчихно.

Gmail өдөрт ~500 захидал илгээнэ — pilot-д хангалттай. Цааш нь Resend эсвэл
Brevo (`burzai.cloud` домэйн дээр SPF/DKIM баталгаажуулаад `noreply@…`):
зөвхөн `SMTP_URL`, `MAIL_FROM` солигдоно, код өөрчлөгдөхгүй.

**Google.** console.cloud.google.com:

1. Шинэ project «Basu» → **APIs & Services → OAuth consent screen**:
   External; App name «Basu»; support email; App domain —
   `https://basu.burzai.cloud`, Privacy policy `…/privacy`, Terms `…/terms`;
   Authorised domains `burzai.cloud`. Scopes: зөвхөн `openid`, `email`,
   `profile` (эдгээр нь Google-ийн шалгалт шаарддаггүй). Дуусаад
   **Publish app** — «Testing» хэвээр бол зөвхөн туршигчид нэвтэрнэ.
2. **Credentials → Create credentials → OAuth client ID** → *Web
   application* → Authorised redirect URIs:
   `https://basu.burzai.cloud/v1/auth/google/callback` (яг ингэж).
3. Гарсан Client ID ба Client secret-ийг `.env`-д:
   ```
   GOOGLE_CLIENT_ID=….apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-…
   ```

Secret-ийг чатаар, commit-оор, deploy-ийн лог руу хэзээ ч бүү дамжуул — repo
ба Actions-ийн лог нээлттэй.

**Apple** (iPhone апп): серверт тусгай түлхүүр хэрэггүй — Apple-ийн нийтийн
түлхүүрээр шалгана. Зөвхөн `APPLE_BUNDLE_IDS` (анхдагч `mn.basu.app`).

## 3. Миграц ба процессууд

```bash
cd /opt/basu/app && npm run db:migrate:dist          # basu_prod дээр
systemctl restart basu-api
systemctl enable --now basu-scheduler                 # демо горимд унтарсан байсан, одоо заавал
systemctl status basu-api basu-scheduler --no-pager
journalctl -u basu-api -n 30 --no-pager               # «production mode», provider бүр бодит гэж хэлэх ёстой
```

## 4. Гаднаас шалгах

```bash
npm run check:prod -- https://basu.burzai.cloud
```

Бүх мөр ✓ байх ёстой: демо замууд 404, толгойнууд, ops хаалга 401, гадаад
дугаарт код явахгүй. Дараа нь гараар:

- [ ] Өөрийн имэйлээр `/idesh`-д нэвтрэх — код **бодит имэйлээр** ирнэ (Spam-ийг шалга), 123456 ажиллахгүй.
- [ ] «Google-ээр нэвтрэх» → Google-ийн данс сонгоод буцаад ирэхэд нэвтэрсэн байна; хаягийн мөрөнд `#auth=` үлдэхгүй.
- [ ] `/dashboard`-т гишүүний утсаар нэвтрэх, нэр, эрх зөв харагдана.
- [ ] Нийлүүлэгчийг ops-оор бүртгэж, дансыг «баталгаажуулах», зар нэмэх. Дараа нь `psql -c "select bank_account from idesh.supplier"` — `v1:` -ээр эхэлсэн байх ёстой, цифр харагдвал `BANK_KEY` тавигдаагүй.
- [ ] Зочны утсаар нэг захиалга: QPay нэхэмжлэл, төлбөр, нийлүүлэгчид SMS + push, е-баримт.
- [ ] Цэнэглэлтийг **төлөхөөс өмнө** «шалгах» — түрийвч дүүрэхгүй, «Төлбөр хараахан хийгдээгүй» гэж хариулах ёстой. Дүүрвэл бодит provider холбогдоогүй байна.
- [ ] Webhook: Wire dashboard-аас туршилтын event илгээгээд `journalctl` дээр хүлээж авсан эсэхийг харах.
- [ ] Нийлүүлэгч дэлгэцээс бэлтгэж → бэлэн → хүлээлгэн өгсөн; маргааш нь олголт ops-д гарна.
- [ ] Олголтыг нэг гишүүн **батлаад**, өөр гишүүн **шилжүүлсэн** гэж тэмдэглэнэ. Баталсан хүн өөрөө шилжүүлэх гэвэл татгалзана — энэ нь дүрэм ажиллаж байгаагийн шалгуур.

## 5. Backup

```bash
# /etc/cron.d/basu-backup — өдөр бүр 03:00, шифрлэж гадагш
0 3 * * * root pg_dump -p 5433 basu_prod | gzip | age -r <public-key> > /root/backup/basu-$(date +\%F).sql.gz.age && <гадагш хуулах команд>
```

- [ ] Эхний backup гараар ажиллуулж, өөр машин дээр сэргээж үзсэн.
- [ ] 30 хоногийн хадгалалт, хуучныг устгах.

## 6. Апп

- [ ] App Store Connect → Release (гарах өдөр).
- [ ] TestFlight-ийн туршигчид production сервертэй build авсан эсэх (build нь `https://basu.burzai.cloud`-ыг үргэлж заадаг — сервер л солигдоно).

## 7. Буцах зам

Асуудал гарвал `.env`-д `BASU_MODE=demo`, `DATABASE_URL=…/basu` (демо DB), `systemctl restart basu-api`, `systemctl stop basu-scheduler` — демо буцаад ирнэ. Production DB хэвээр үлдэнэ.

## Дараа нь (1-р үе)

Backup-ийн шифрлэлт ба сэргээх туршилт, дансны талбарын шифрлэлт, аппд бүртгэл устгах, лог/сэрэмжлүүлэг — `docs/security-and-admin-architecture.md` §7.
