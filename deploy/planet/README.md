# Butun dunyo: marshrut va qidiruv (o'z serverimizda)

Hech qanday tashqi API yo'q: marshrut **Valhalla**, manzil qidirish **Nominatim**, xarita plitkalari **planet.pmtiles**.
Og'ir qism (qurish) soatbay katta serverda **bir marta** bajariladi, tayyor ma'lumot asosiy serverga ko'chiriladi.

## 1. Soatbay serverda (256 GB RAM, 2 TB NVMe, 32+ yadro)

```bash
git clone -b claude/nex-ecosystem-nexid https://github.com/abduraxmonovbobir191-creator/geo-backend.git
cd geo-backend/deploy/planet
WORK=/srv/nexmap-build bash build-world.sh       # Valhalla, keyin Nominatim; uzilsa qayta ishga tushiring
```

Skript o'zi tekshiradi: RAM >= 96 GB, bo'sh joy >= 1.4 TB, disk NVMe/SSD. Planet faylini (~85 GB) yuklab, ketma-ket quradi.
Taxminiy vaqt (32 yadro): Valhalla 6-15 soat, Nominatim 1-3 kun. Jarayonni kuzatish:
`docker logs -f nexmap-valhalla-build` va `docker logs -f nexmap-nominatim-build`.
Faqat bittasini qurish: `bash build-world.sh valhalla` yoki `nominatim`.

## 2. Asosiy serverga ko'chirish

```bash
bash export-world.sh root@ASOSIY_SERVER /srv/nexmap     # /srv/nexmap = asosiy serverdagi DATA_DIR
```

Tugagach soatbay serverni o'chirishingiz mumkin.

## 3. Asosiy serverda yoqish

`deploy/.env` ga qo'shing: `ROUTING_URL=http://valhalla:8002`, so'ng:

```bash
docker compose --profile routing up -d valhalla
docker compose up -d api
curl -s http://localhost:3000/health
```

Nominatim: `${DATA_DIR}/nominatim` ko'chirilgach `docker compose up -d nominatim` (baza bor bo'lsa import qaytadan qilinmaydi).
Planet plitkalari uchun asosiy serverda `bash download-map.sh world`.

## Eslatma
Skriptlar haqiqiy serverda hali sinalmagan: birinchi daqiqalarda jurnalni kuzating va xato chiqsa menga yuboring.
Disk va xotira kam bo'lsa skript boshidayoq to'xtaydi (pulni behuda ketkazmaslik uchun).
