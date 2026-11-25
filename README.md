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

## Obuna va xaridlar (hammasi Nex ID hamyonida)

Pul faqat Nex ID'da: Nex Map tanga sotmaydi va saqlamaydi, har bir to'lov Nex ID hamyonidan `charge` bilan yechiladi
(`ref` bilan, qayta urinish ikki marta yechmaydi). Tanga sotib olish: `walletUrl` (Nex ID).

- `GET /v1/shop`: katalog (`plus` obuna, `themes`, `pins`, `export`, `api_keys`), nima sotib olingani, Nex ID balansi.
- `POST /v1/shop/buy {sku, price, key}`: **bitta tugma**. `price` ko'rsatilgan narx (o'zgargan bo'lsa 409 `price_changed`),
  `key` qayta urinishda bir marta to'lash uchun. Tanga yetmasa 402 `insufficient_funds` + `walletUrl`.
- `POST /v1/shop/subscriptions/{sku}/cancel | resume`: bekor qilish to'langan davr oxirigacha ishlaydi; yangilanish har 10 daqiqada
  tekshiriladi, tanga yetmasa obuna tugaydi.
- Sotib olingan narsa **faqat Nex Map'da** ishlaydi: `GET /v1/me` da `entitlements` (Nex ID `perks` + Nex Map xaridlari).
  API kalit bilan xarid qilib bo'lmaydi.
- Narxlar `shop_items` jadvalida (tanga), admin xohlagan payt o'zgartiradi.
- Nexly va Nexgram'da ham shu tugma: `GET /internal/v1/shop`, `POST /internal/v1/shop/buy` (`X-Service-Key` + `X-Nexid-Sub`).
  Ilova foydalanuvchidan tasdiq olgandan keyingina chaqiradi; xarid `purchases.source` da `nexly` / `nexgramm` deb yoziladi.

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
