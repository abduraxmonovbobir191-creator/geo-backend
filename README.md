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
