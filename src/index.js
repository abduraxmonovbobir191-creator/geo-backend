require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

// In-memory store (later replace with PostgreSQL / Redis)
const users = new Map(); // userId -> { lat, lng, name, socketId }
const chats = [];

app.get('/', (req, res) => {
  res.json({ status: 'Geo Backend is running' });
});

// Simple health
app.get('/health', (req, res) => {
  res.json({ ok: true, usersOnline: users.size });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join with user info (later from Nex ID)
  socket.on('join', (data) => {
    const { userId, name } = data;
    users.set(userId, { name, socketId: socket.id, lat: null, lng: null });
    socket.userId = userId;
    socket.join(userId);
    io.emit('users:update', Array.from(users.entries()));
  });

  // Real-time location update
  socket.on('location:update', (data) => {
    const { userId, lat, lng } = data;
    if (users.has(userId)) {
      const user = users.get(userId);
      user.lat = lat;
      user.lng = lng;
      users.set(userId, user);
      // Broadcast to all (or only friends later)
      io.emit('location:update', { userId, lat, lng, name: user.name });
    }
  });

  // Chat message
  socket.on('chat:message', (data) => {
    const msg = {
      from: data.from,
      to: data.to,
      text: data.text,
      timestamp: Date.now()
    };
    chats.push(msg);
    // Send to recipient
    io.to(data.to).emit('chat:message', msg);
    // Echo to sender
    socket.emit('chat:message', msg);
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      users.delete(socket.userId);
      io.emit('users:update', Array.from(users.entries()));
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Geo Backend running on port ${PORT}`);
});
