# Geo Backend

Node.js + Express + Socket.io + PostgreSQL

## Setup
1. Install PostgreSQL
2. Create database: `createdb geoapp`
3. Copy `.env.example` to `.env` and set DATABASE_URL
4. `npm install`
5. `npm run dev`

## Tables
- users (id, name, lat, lng)
- messages (from, to, text)
