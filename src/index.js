import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { attachRealtime } from './realtime.js';
import { pool } from './db.js';
import { endExpiredPromotions } from './routes/business.js';
import { renewDue } from './lib/shop.js';

await migrate();

const server = http.createServer(createApp());
const io = attachRealtime(server);

server.listen(config.port, () => {
  console.log(`Nex Map API listening on http://localhost:${config.port} (docs at /docs)`);
});

// Subscriptions renew every 10 minutes (one coin charge per due period; the wallet ref makes a retry safe).
const sweep = setInterval(() => renewDue().catch((e) => console.error('renew failed:', e.message)), 600_000);
sweep.unref();
setInterval(() => endExpiredPromotions().catch(() => {}), 600_000).unref(); // a Top position ends when its days are over

function shutdown() {
  io.close();
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
