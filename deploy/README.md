# Nex Map'ni serverga o'rnatish

Bitta server (masalan Contabo, Ubuntu 22.04 yoki 24.04) uchun to'liq o'rnatish:

| Manzil | Nima |
|---|---|
| `https://nexecos.com` va `https://map.nexecos.com` | Sayt (Google uchun) |
| `https://api.nexecos.com` | API va hujjat (`/docs`) |
| `https://tiles.nexecos.com` | Xarita (butun dunyo yoki tanlangan hudud) |

HTTPS sertifikatlari avtomatik olinadi (Caddy + Let's Encrypt).

## 1. DNS

Domen panelida 4 ta **A** yozuv qo'shing, hammasi serveringiz IP manziliga:

| Nom | Turi | Qiymati |
|---|---|---|
| `@` (nexecos.com) | A | server IP |
| `api` | A | server IP |
| `tiles` | A | server IP |
| `map` | A | server IP |

Tekshirish: kompyuterda `ping api.nexecos.com` server IP'sini ko'rsatishi kerak (yangilanishi 5-30 daqiqa oladi).

## 2. Serverga kirish va o'rnatish

```bash
ssh root@SERVER_IP

apt update && apt install -y git
git clone -b ccr-d7693bc1-bb17dd https://github.com/abduraxmonovbobir191-creator/geo-backend.git
cd geo-backend/deploy
bash install.sh
```

`install.sh` Docker'ni o'rnatadi, firewall'ni sozlaydi, maxfiy parollar bilan `.env` yaratadi va hammasini ishga tushiradi.
Bir necha daqiqadan keyin tekshiring:

- https://api.nexecos.com/health → `{"ok":true}`
- https://api.nexecos.com/docs → API hujjati
- https://nexecos.com → sayt

### 2 TB qo'shimcha disk

Agar u alohida disk bo'lsa (masalan `/mnt/storage` ga ulangan), birinchi ishga tushirishdan **oldin** `deploy/.env` faylida
`DATA_DIR`, `TILE_CACHE_DIR` va `BACKUP_DIR` ni o'sha diskka o'zgartiring. Diskni qanday ulashni bilmasangiz,
`lsblk` buyrug'ining natijasini yuboring.

## 3. Xarita

Avval tezkor sinov uchun faqat O'zbekiston (bir necha daqiqa):

```bash
bash download-map.sh uzbekistan
```

Hammasi ishlasa, butun dunyo (~120 GB, internet tezligiga qarab bir necha soat):

```bash
bash download-map.sh world
```

Yuklash uzilsa, buyruqni qayta ishga tushiring: davom ettiradi. Xaritani yangilash uchun ham shu buyruqni oyda bir marta
ishga tushiring.

Tekshirish: https://tiles.nexecos.com/ (xarita ko'rinishi) va https://tiles.nexecos.com/styles/light/5/22/12.png

Ilova shu manzildan foydalanadi: `https://tiles.nexecos.com/styles/light/{z}/{x}/{y}.png` (`dark` uslubi ham bor).

## 4. Manzil qidirish

O'zbekiston bo'yicha qidiruv birinchi ishga tushishda avtomatik import qilinadi (taxminan bir soat):

```bash
docker compose logs -f nominatim      # "Nominatim is ready" chiqsa tayyor
```

Import tugaguncha, shuningdek O'zbekistondan tashqaridagi manzillar uchun API OpenStreetMap'ning ochiq serveridan foydalanadi.
Boshqa hududni qo'shish uchun `.env` dagi `NOMINATIM_PBF_URL` ni o'zgartiring (Geofabrik'dagi istalgan hudud).
Butun dunyo bo'yicha qidiruv ~900 GB disk va 64 GB+ RAM talab qiladi, bu server uchun juda katta.

## 5. Ilovani yuklab olish havolasi

Saytdagi "Android uchun yuklab olish" tugmasi `deploy/site/nex-map.apk` faylini beradi. GitHub Actions'dan APK'ni
yuklab olib, shu nom bilan serverga ko'chiring:

```bash
scp app-release.apk root@SERVER_IP:/root/geo-backend/deploy/site/nex-map.apk
```

## 6. Google'da chiqishi

1. https://search.google.com/search-console ga kiring, `nexecos.com` ni **Domain** sifatida qo'shing.
2. Google bergan TXT yozuvni DNS'ga qo'shing va tasdiqlang.
3. **Sitemaps** bo'limida `https://nexecos.com/sitemap.xml` ni yuboring.

Saytning birinchi ko'rinishi odatda bir necha kundan bir necha haftagacha vaqt oladi.

## 7. Zaxira nusxa (backup)

Har kuni soat 03:17 da ma'lumotlar bazasini saqlash uchun `crontab -e` ga qo'shing:

```
17 3 * * * cd /root/geo-backend/deploy && bash backup.sh >> /var/log/nexmap-backup.log 2>&1
```

## Kundalik buyruqlar

```bash
docker compose ps                     # nima ishlayapti
docker compose logs -f api            # API loglari
bash update.sh                        # yangi kodni olish va qayta ishga tushirish
docker compose --profile maps restart # hammasini qayta ishga tushirish
```

`.env` faylida parollar bor: uni hech kimga bermang va GitHub'ga yuklamang (`.gitignore` da bor).
