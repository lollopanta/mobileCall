const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  // Force websocket transport for better stability on mobile
  transports: ['websocket', 'polling']
});

const PORT = 3000;
const users = {};

io.on('connection', (socket) => {
  console.log(`[CONNECT] ID: ${socket.id} | IP: ${socket.handshake.address}`);

  socket.on('join', (username) => {
    users[socket.id] = username;
    console.log(`[JOIN] ${username} (ID: ${socket.id})`);
    io.emit('user-list', Object.entries(users).map(([id, name]) => ({ id, name })));
  });

  socket.on('offer', (data) => {
    console.log(`[OFFER] from ${users[socket.id]} to ${data.to}`);
    io.to(data.to).emit('offer', {
      from: socket.id,
      fromName: users[socket.id],
      offer: data.offer,
      isVideo: data.isVideo
    });
  });

  socket.on('answer', (data) => {
    io.to(data.to).emit('answer', { from: socket.id, answer: data.answer });
  });

  socket.on('ice-candidate', (data) => {
    io.to(data.to).emit('ice-candidate', { from: socket.id, candidate: data.candidate });
  });

  socket.on('call-rejected', (data) => {
    io.to(data.to).emit('call-rejected', { from: socket.id });
  });

  socket.on('end-call', (data) => {
    io.to(data.to).emit('end-call', { from: socket.id });
  });

  socket.on('disconnect', (reason) => {
    const username = users[socket.id];
    console.log(`[DISCONNECT] ID: ${socket.id} (${username || 'unknown'}) | Reason: ${reason}`);
    delete users[socket.id];
    io.emit('user-list', Object.entries(users).map(([id, name]) => ({ id, name })));
  });

  socket.on('error', (error) => {
    console.error(`[SOCKET ERROR] ID: ${socket.id} |`, error);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server running on http://0.0.0.0:${PORT}`);
});
