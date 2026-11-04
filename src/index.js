import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { attachRealtime } from './realtime.js';
import { pool } from './db.js';

await migrate();

const server = http.createServer(createApp());
const io = attachRealtime(server);

server.listen(config.port, () => {
  console.log(`Nex Map API listening on http://localhost:${config.port} (docs at /docs)`);
});

function shutdown() {
  io.close();
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
