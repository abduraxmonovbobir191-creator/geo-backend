# Nex Map backend

Nex Map ilovasi uchun server: xarita, do'stlarning jonli lokatsiyasi (Blink kabi), mashg'ulotlarni
yozish (Strava kabi), joylar, manzil qidirish, chat va boshqa dasturchilar uchun ochiq REST API.

Node.js 20+, Express, PostgreSQL va Socket.IO ishlatiladi.

## Ishga tushirish

Docker bilan (eng oson):

```bash
docker compose up --build
# API:   http://localhost:3000
# Hujjat: http://localhost:3000/docs
```

Docker'siz:

```bash
cp .env.example .env      # DATABASE_URL ni o'zingizning PostgreSQL'ga moslang
npm install
npm start                 # jadvallar birinchi ishga tushishda avtomatik yaratiladi
```

Testlar alohida bazada ishlaydi (`nexmap_test`, yoki `TEST_DATABASE_URL`):

```bash
npm test
```

## Nex ekotizimi (Nex ID, Nexly, Nexgram)

Nex Map bitta ekotizimning qismi: **hisob bitta, Nex ID** (`sub` bo'yicha), Nexly va Nexgram bilan bir xil.

- **Kirish faqat Nex ID orqali** (OIDC + PKCE): ilova `nexmap://auth` ga qaytgan kodni `POST /v1/auth/nexid`
  `{code, codeVerifier, redirectUri}` ga yuboradi, javobda `token` va `logoutUrl`. `POST /v1/auth/logout` Nex ID
  grantini bekor qiladi. Eski parol bilan kirish faqat `LEGACY_PASSWORD_LOGIN=1` bo'lsa ishlaydi (productionda o'chiq, 410 `use_nexid`).
- **Nex Premium** Nex ID'da sotiladi, `GET /v1/me` da `plan`, `perks`, `premiumUrl` keladi (kesh `PLAN_CACHE_MINUTES`,
  Nex ID ishlamasa eski tarif qoladi). Imkoniyatlar `perks` kalitiga qarab ochiladi (`nexmap.api_keys`: 50 ta API kalit).
- **Nexly / Nexgram uchun xizmat API** `/internal/v1` (`X-Service-Key` + `X-Nexid-Sub`, `SERVICE_KEYS=nexly:<kalit>,nexgramm:<kalit>`,
  nginx'da ochiq qilinmaydi, foydalanuvchi tokeni bu yerda ishlamaydi):
  `GET /geocode/search|reverse` (post joyi uchun), `POST /users/resolve` (qaysi Nex ID'lar Nex Map'da),
  `GET /users/me/profile` va `/users/me/activities` (profil kartasi, faqat ochiq mashg'ulotlar),
  `GET /activities/{id}/card` (postga havola kartasi), `POST /friends/sync` (o'zaro obunachilar Nex Map do'sti bo'ladi).
  Jonli lokatsiya, ghost rejim va do'stlarga mo'ljallangan mashg'ulotlar bu yerdan **hech qachon** chiqmaydi.

## Obuna va xaridlar (hammasi Stars bilan, Nex ID hamyonida)

Bitta valyuta: **Stars** (hamma Nex ilovasida bir xil). Stars App Store / Google Play orqali sotib olinadi va Nex ID hamyoniga tushadi;
Nex Map hech narsa saqlamaydi, to'lov Nex ID `charge` bilan yechiladi (`ref` bilan, qayta urinish ikki marta yechmaydi).

- `GET /v1/shop`: katalog (`plus` 30 kunlik pass, `themes`, `pins`, `export`, `api_keys`), nima sotib olingani, Stars balansi, hamyon havolasi.
- `POST /v1/shop/buy {sku, price, key}`: **bitta tugma**. `price` ko'rsatilgan narx (o'zgargan bo'lsa 409 `price_changed`), `key` qayta urinishda bir marta
  to'lash uchun. Stars yetmasa 402 `insufficient_funds` + `walletUrl`. **Plus** ishlab turganda yana bosilsa kunlari qo'shiladi (30 + 30).
- Hech narsa o'zi yangilanmaydi (do'kon qoidalari): pass tugasa o'zi to'xtaydi, tugashiga 3 kun qolganda ilova eslatadi, bitta tugma uzaytiradi.
- Sotib olingan narsa **faqat Nex Map'da** ishlaydi: `GET /v1/me` da `entitlements` (Nex ID `perks` + Nex Map xaridlari), Nexly ichidagi Nex Map tabida ham, alohida Nex Map ilovasida ham.
  API kalit bilan xarid qilib bo'lmaydi.
- Narxlar `shop_items` jadvalida (Stars), admin xohlagan payt o'zgartiradi.
- Nexly va Nexgram'da ham shu tugma: `GET /internal/v1/shop`, `POST /internal/v1/shop/buy` (`X-Service-Key` + `X-Nexid-Sub`);
  xarid `purchases.source` da `nexly` / `nexgramm` deb yoziladi.

## Biznes joylar (Yandex / Snap Map uslubida)

- `GET /v1/places/categories`, `GET /v1/places/nearby?lat&lng&radius&category=restaurant&q=&openNow=true`: kategoriya tugmalari, nom bo'yicha qidiruv, "hozir ochiq".
- **Biznes kartochkasi:** tavsif, telefon, sayt, rasmlar, narx darajasi, ish vaqti (`open`), reyting va sharhlar. Reyting va sharhlar pulga bog'liq emas;
  egasi o'z joyiga baho bera olmaydi (`PUT /v1/places/{id}/reviews`).
- **Egasi bo'lish:** `POST /v1/business/places/{id}/claim` (Nex ID tekshiruvi 1+ kerak, birinchi so'ragan oladi). Tahrir: `PATCH /v1/business/places/{id}`.
- **Pullik Top 1–3:** `POST /v1/business/places/{id}/promotions {plan, price, key}`. Narx Nex ID hamyonidan yechiladi (`GET /v1/business/plans`).
  Har bir Top o'rin kategoriya va ~5 km hudud bo'yicha bitta egaga beriladi (band bo'lsa 409 `slot_taken`, pul qaytadi). Ro'yxatda eng tepada
  ko'pi bilan 3 ta, doim `ad: true` belgisi bilan; qolganlar masofa bo'yicha.
- **3D Branded Pin:** logo yoki 3D model linki qo'shilgach `pin_month` sotib olinadi; `brandedPin` faqat muddat davomida ko'rinadi.
- **Statistika (pullik qo'shimcha `biz_stats`):** `GET /v1/business/places/{id}/stats`: ko'rishlar, kartochka ochilishi, pin bosilishi, marshrut, qo'ng'iroq.
  Faqat sonlar saqlanadi, kim ko'rgani saqlanmaydi. Mijoz ilovasi `POST /v1/places/{id}/events {kind}` yuboradi.

## Marshrut va o'z xaritamiz

- `POST /v1/route {from, to, via[], mode: drive|walk|bike, toPlaceId?}`: o'z Valhalla serverimizda marshrut (`ROUTING_URL`), masofa, vaqt, chiziq va qadamlar.
  Javobda `suggestions`: yo'l ustidagi (300 m ichida) sotib olingan Top joylar, doim `ad: true` bilan: "oraliq to'xtash" (Add stop) uchun
  mijoz ilova `via` bilan qayta so'raydi. Piyoda yo'lda takliflar yo'q.
- Xarita ko'rinishi bizniki: `deploy/tileserver/nex-style.mjs` (yorug' va qorong'i, 3D binolar z14+, ochilishda 45° qiyalik).
- Butun dunyo marshrut va qidiruv: `deploy/planet/README.md` (soatbay katta serverda quriladi, asosiy serverga ko'chiriladi).

## Jonli belgilar, kupon, Bump (Waze / Snap Map / Blink)

- **Jonli belgilar:** `POST /v1/alerts {kind, lat, lng, note}` (tirbandlik, YTH, ta'mir, kamera, patrul, navbat, yopiq yo'l, xavf, chuqur), `GET /v1/alerts/nearby?lat&lng&radius`,
  `POST /v1/alerts/{id}/confirm {still}`. Yaqin atrofdagi (150 m) bir xil belgi qayta qo'shilmaydi, tasdiqlanadi. Belgi o'zi tugaydi, tasdiqlansa uzayadi,
  3 ta "yo'q" ovozi uni olib tashlaydi. Ball: belgi +10, tasdiq +2, tasdiqlangan belgi egasiga +1 (xato bo'lsa -1); daraja `GET /v1/me` da (`points`, `level`).
  Kamera va patrul qonuniy bo'lmagan mamlakatda `ALERT_DISABLED_KINDS=camera,police` bilan o'chiriladi.
- **Kupon:** egasi `POST /v1/business/offers {placeId, title, leadFee, quota, days}`, odam `POST /v1/offers/{id}/claim` (bittadan), kassada egasi
  `POST /v1/business/redeem {code}`: har bir ishlatilgan kupon uchun `leadFee` Stars egasidan Nex ID hamyonida bir marta yechiladi (Stars yetmasa 402, kupon amalda qoladi).
- **Footprints:** `GET /v1/me/footprints` (~1 km katak, faqat o'zingizga). **Bump:** ikki do'st bir-biriga aniq joyini ko'rsatib 50 m ichida tursa `friend:bump` (30 daqiqada bir marta).
  **Stiker:** `POST /v1/friends/{id}/poke {emoji, count}` (`friend:poke`).

## Imkoniyatlar

| Bo'lim | Endpointlar |
|---|---|
| Ro'yxatdan o'tish | `POST /v1/auth/register`, `POST /v1/auth/login` |
| Profil | `GET/PATCH /v1/me`, `PUT /v1/me/password`, `GET /v1/me/stats` |
| Lokatsiya | `PUT /v1/me/location`, ghost rejim: `PATCH /v1/me {"ghostMode": true}` |
| Do'stlar | `GET /v1/friends` (lokatsiyasi bilan), so'rov yuborish/qabul qilish/rad etish |
| Mashg'ulotlar | GPS nuqtalarni yuklash, masofa/vaqt/temp/balandlik avtomatik hisoblanadi, feed, kudos |
| Joylar | yaqin atrofdagi joylar, joy qo'shish, check-in |
| Manzil qidirish | `GET /v1/geocode/search`, `GET /v1/geocode/reverse` (OpenStreetMap) |
| Chat | suhbatlar, xabarlar tarixi, xabar yuborish (faqat do'stlarga) |
| API kalitlar | `GET/POST/DELETE /v1/api-keys` |

To'liq ro'yxat, so'rov va javob formatlari: `/docs` (Swagger) yoki `/openapi.json`.

## Ochiq API (boshqa dasturchilar uchun)

1. Nex Map hisobiga kiring va kalit yarating:

   ```bash
   curl -X POST http://localhost:3000/v1/api-keys \
     -H "Authorization: Bearer <login tokeni>" \
     -H "Content-Type: application/json" \
     -d '{"name": "Mening botim", "scopes": ["read", "write"]}'
   ```

   Javobdagi `key` (`nex_...`) faqat bir marta ko'rsatiladi, uni saqlab qo'ying.

2. Har bir so'rovda kalitni yuboring:

   ```bash
   curl http://localhost:3000/v1/friends -H "X-API-Key: nex_..."
   ```

Qoidalar:
- Kalit uni yaratgan foydalanuvchi nomidan ishlaydi.
- `read` ruxsati faqat GET so'rovlarga, `write` ruxsati o'zgartirishlarga kerak.
- Kalitlarni boshqarish va parolni o'zgartirish faqat ilovadan kirgan holda mumkin, kalit bilan emas.
- Limit: bitta kalitga daqiqasiga 120 ta so'rov. Qolgan limit `RateLimit` sarlavhasida keladi, oshib ketsa `429` qaytadi.
- Xatolar doim bir xil formatda: `{"error": {"code": "...", "message": "..."}}`.

## Real-time (Socket.IO)

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:3000', { auth: { token: '<login tokeni yoki nex_ kalit>' } });

socket.emit('location:update', { lat: 41.31, lng: 69.28, battery: 80 }, (ack) => console.log(ack));
socket.on('friend:location', (loc) => console.log('Do\'st joylashuvi', loc));
```

Hodisalar: `friends:online`, `friend:online`, `friend:offline`, `friend:location`, `friend:ghost`,
`friend:request`, `friend:accepted`, `friend:removed`, `friend:checkin`, `message:new`, `message:read`,
`activity:kudos`.

Onlayn holat server xotirasida saqlanadi, shuning uchun hozircha bitta server nusxasi uchun mo'ljallangan.
Bir nechta nusxa kerak bo'lsa Socket.IO Redis adapteri qo'shiladi.

## Tuzilishi

```
src/
  index.js        serverni ishga tushirish
  app.js          Express, marshrutlar, rate limit
  realtime.js     Socket.IO
  openapi.js      API hujjati
  migrations/     SQL sxema
  routes/         har bir bo'lim uchun endpointlar
  lib/geo.js      masofa va mashg'ulot statistikasi hisoblash
test/             avtomatik testlar
```
