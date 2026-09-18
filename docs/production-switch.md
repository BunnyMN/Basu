# Production-д шилжих шалгах хуудас

_Pilot сервер (basu.burzai.cloud) демо горимоос бодит худалдаанд шилжих
өдрийн өмнөх орой хийх ажил. Дараалал чухал; хугацаа ойролцоогоор нэг цаг._

## 0. Өмнө нь бэлэн байх ёстой (танаас хамаарна)

- [ ] `OPS_MEMBERS` — ops-ийн гишүүдийн утас, нэр, эрх (`+976…:Нэр:admin`, санхүүгийн хүн `finance`).
- [ ] CallPro-ийн API түлхүүр (бодит OTP явахгүй бол хэн ч нэвтэрч чадахгүй — **энэгүйгээр шилжиж болохгүй**).
- [ ] QPay merchant `username`, `password`, `invoice_code` (production).
- [ ] PosAPI 3.0 оператор бүртгэл, posNo; эхний нийлүүлэгчийн ТТД зөвшөөрөгдсөн.
- [ ] Эхний нийлүүлэгчийн гэрээ, данс — ops-оор бүртгэнэ (демо өгөгдөл биш).
- [ ] Apple review батлагдсан (App Store-д «Release» дарахад бэлэн).
- [ ] Backup гадагш хадгалах газар (S3-төст данс) ба түлхүүр.

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
# OPS_TOKEN — устгана: production-д ямар ч утга хүчингүй
CALLPRO_…=            # SMS
QPAY_USERNAME= QPAY_PASSWORD= QPAY_INVOICE_CODE=
POSAPI_URL=http://127.0.0.1:7080
APNS_TEAM_ID= APNS_KEY_ID= APNS_KEY_FILE=/opt/basu/apns.p8 APNS_ENV=production
```

Шалгах: `.env`-д OPS_TOKEN алга, файл root-only.

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

- [ ] Өөрийн утсаар `/supplier`-т нэвтрэх — код **бодит SMS**-ээр ирнэ, 123456 ажиллахгүй.
- [ ] `/dashboard`-т гишүүний утсаар нэвтрэх, нэр, эрх зөв харагдана.
- [ ] Нийлүүлэгчийг ops-оор бүртгэж, дансыг «баталгаажуулах», зар нэмэх.
- [ ] Зочны утсаар нэг захиалга: QPay нэхэмжлэл, төлбөр, нийлүүлэгчид SMS + push, е-баримт.
- [ ] Нийлүүлэгч дэлгэцээс бэлтгэж → бэлэн → хүлээлгэн өгсөн; маргааш нь олголт ops-д гарна.

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
