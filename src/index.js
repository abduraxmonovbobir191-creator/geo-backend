require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { pool, initDb } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Init DB on start
initDb().catch(console.error);

app.get('/', (req, res) => res.json({ status: 'Geo Backend running' }));
app.get('/health', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  res.json({ ok: true, users: rows[0].count });
});

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join', async (data) => {
    const { userId, name } = data;
    socket.userId = userId;
    await pool.query(
      `INSERT INTO users (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = $2, updated_at = NOW()`,
      [userId, name]
    );
    socket.join(userId);
  });

  socket.on('location:update', async (data) => {
    const { userId, lat, lng } = data;
    await pool.query(
      'UPDATE users SET lat = $1, lng = $2, updated_at = NOW() WHERE id = $3',
      [lat, lng, userId]
    );
    io.emit('location:update', data);
  });

  socket.on('chat:message', async (data) => {
    const { from, to, text } = data;
    await pool.query(
      'INSERT INTO messages (from_user, to_user, text) VALUES ($1, $2, $3)',
      [from, to, text]
    );
    const msg = { from, to, text, timestamp: Date.now() };
    io.to(to).emit('chat:message', msg);
    socket.emit('chat:message', msg);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
