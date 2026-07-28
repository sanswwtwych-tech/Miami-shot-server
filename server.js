/**
 * Miami Shot — online multiplayer server (optimized)
 * Run: npm install && npm start
 * Default: http://localhost:3000
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const COLS = 20;
const ROWS = 20;
const TICK_MS = 100;
const MIN_SPEED = 65;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
app.use(cors());
app.get('/', (_req, res) => {
  res.type('text').send('Miami Shot server OK · set this URL in the game PHONE LINE panel');
});
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  pingInterval: 20000,
  pingTimeout: 15000,
  maxHttpBufferSize: 1e5,
  perMessageDeflate: false,
});

const rooms = new Map();

function makeCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return rooms.has(code) ? makeCode() : code;
}

function spawnFood(room) {
  const blocked = new Set();
  for (let i = 0; i < room.snakes.length; i++) {
    const s = room.snakes[i];
    if (!s.alive) continue;
    for (let k = 0; k < s.body.length; k++) {
      blocked.add(s.body[k].x + (s.body[k].y << 5));
    }
  }
  for (let n = 0; n < 200; n++) {
    const x = (Math.random() * COLS) | 0;
    const y = (Math.random() * ROWS) | 0;
    if (!blocked.has(x + (y << 5))) {
      room.food = { x, y };
      return;
    }
  }
  room.food = { x: 10, y: 10 };
}

function defaultSkin(idx) {
  return idx === 0
    ? { head: '#ff2d95', body: '#c2185b' }
    : { head: '#00f0ff', body: '#0088aa' };
}

function lobbyPayload(room) {
  const players = room.players;
  const out = new Array(players.length);
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    out[i] = {
      playerIndex: p.playerIndex,
      name: p.name,
      ready: !!p.ready,
      isHost: p.isHost,
    };
  }
  return { code: room.code, players: out };
}

function publicState(room) {
  const snakes = room.snakes;
  const snakeOut = new Array(snakes.length);
  for (let i = 0; i < snakes.length; i++) {
    const s = snakes[i];
    const body = s.body;
    const b = new Array(body.length);
    for (let k = 0; k < body.length; k++) {
      b[k] = { x: body[k].x, y: body[k].y };
    }
    snakeOut[i] = { body: b, alive: s.alive, skin: s.skin };
  }
  const players = room.players;
  const playerOut = new Array(players.length);
  for (let i = 0; i < players.length; i++) {
    playerOut[i] = { playerIndex: players[i].playerIndex, name: players[i].name };
  }
  return {
    scores: [room.scores[0], room.scores[1]],
    food: room.food ? { x: room.food.x, y: room.food.y } : null,
    speed: room.speed,
    snakes: snakeOut,
    players: playerOut,
  };
}

function resetMatch(room) {
  room.scores[0] = 0;
  room.scores[1] = 0;
  room.speed = TICK_MS;
  room.paused = false;
  room.gameOver = false;
  room.snakes = [
    {
      body: [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
      ],
      dir: { x: 1, y: 0 },
      nextDir: { x: 1, y: 0 },
      alive: true,
      skin: (room.players[0] && room.players[0].skin) || defaultSkin(0),
    },
    {
      body: [
        { x: COLS - 3, y: ROWS - 3 },
        { x: COLS - 2, y: ROWS - 3 },
        { x: COLS - 1, y: ROWS - 3 },
      ],
      dir: { x: -1, y: 0 },
      nextDir: { x: -1, y: 0 },
      alive: true,
      skin: (room.players[1] && room.players[1].skin) || defaultSkin(1),
    },
  ];
  spawnFood(room);
}

function stopLoop(room) {
  if (room.loop) {
    clearTimeout(room.loop);
    room.loop = null;
  }
  room._tickRunning = false;
}

function endGame(room, winner) {
  if (room.gameOver) return;
  room.gameOver = true;
  stopLoop(room);
  io.to(room.code).emit('game:over', {
    winner,
    scores: [room.scores[0], room.scores[1]],
  });
}

function stepRoom(room) {
  if (room.paused || room.gameOver) return;

  const snakes = room.snakes;
  const n = snakes.length;
  const occ = room._occ || (room._occ = new Set());
  occ.clear();

  for (let i = 0; i < n; i++) {
    const s = snakes[i];
    if (!s.alive) continue;
    const body = s.body;
    for (let k = 0; k < body.length; k++) {
      occ.add(body[k].x + (body[k].y << 5));
    }
  }

  let speedChanged = false;

  for (let i = 0; i < n; i++) {
    const s = snakes[i];
    if (!s.alive) continue;

    const nd = s.nextDir;
    if (nd && !(nd.x === -s.dir.x && nd.y === -s.dir.y)) {
      s.dir.x = nd.x;
      s.dir.y = nd.y;
    }

    const head = s.body[0];
    const nx = head.x + s.dir.x;
    const ny = head.y + s.dir.y;

    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) {
      s.alive = false;
      continue;
    }

    const key = nx + (ny << 5);
    if (occ.has(key)) {
      s.alive = false;
      continue;
    }

    s.body.unshift({ x: nx, y: ny });
    occ.add(key);

    const food = room.food;
    const ate = food && food.x === nx && food.y === ny;
    if (ate) {
      room.scores[i] += 1;
      spawnFood(room);
      const next = room.speed - 2;
      if (next >= MIN_SPEED && next !== room.speed) {
        room.speed = next;
        speedChanged = true;
      } else if (next < MIN_SPEED) {
        room.speed = MIN_SPEED;
      }
    } else {
      const tail = s.body.pop();
      if (tail) occ.delete(tail.x + (tail.y << 5));
    }
  }

  const s0 = snakes[0];
  const s1 = snakes[1];
  if (s0 && s1 && s0.alive && s1.alive) {
    const h0 = s0.body[0];
    const h1 = s1.body[0];
    if (h0.x === h1.x && h0.y === h1.y) {
      s0.alive = false;
      s1.alive = false;
    }
  }

  const a0 = s0 && s0.alive;
  const a1 = s1 && s1.alive;
  if (!a0 || !a1) {
    let winner = null;
    if (a0 && !a1) winner = 0;
    else if (a1 && !a0) winner = 1;
    io.to(room.code).emit('game:state', publicState(room));
    endGame(room, winner);
    return;
  }

  io.to(room.code).emit('game:state', publicState(room));
  if (speedChanged) scheduleTick(room);
}

function scheduleTick(room) {
  stopLoop(room);
  if (room.gameOver || !rooms.has(room.code)) return;
  room._tickRunning = true;

  const tick = () => {
    if (!room._tickRunning || room.gameOver) return;
    const t0 = Date.now();
    stepRoom(room);
    if (!room._tickRunning || room.gameOver) return;
    const spent = Date.now() - t0;
    const delay = Math.max(16, (room.speed || TICK_MS) - spent);
    room.loop = setTimeout(tick, delay);
  };
  room.loop = setTimeout(tick, room.speed || TICK_MS);
}

function startLoop(room) {
  scheduleTick(room);
}

function tryStart(room) {
  if (room.players.length < 2) return;
  for (let i = 0; i < room.players.length; i++) {
    if (!room.players[i].ready) return;
  }
  resetMatch(room);
  for (let i = 0; i < room.players.length; i++) room.players[i].ready = false;
  io.to(room.code).emit('game:start', publicState(room));
  startLoop(room);
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  stopLoop(room);
  rooms.delete(code);
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.playerIndex = null;

  socket.on('room:create', (payload, ack) => {
    try {
      const name = String((payload && payload.name) || 'P1').slice(0, 12);
      const code = makeCode();
      const room = {
        code,
        players: [],
        snakes: [],
        scores: [0, 0],
        food: null,
        speed: TICK_MS,
        paused: false,
        gameOver: false,
        loop: null,
        _occ: new Set(),
        _tickRunning: false,
      };
      const player = {
        id: socket.id,
        name,
        skin: (payload && payload.skin) || defaultSkin(0),
        playerIndex: 0,
        ready: false,
        isHost: true,
      };
      room.players.push(player);
      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerIndex = 0;
      const lobby = lobbyPayload(room);
      if (typeof ack === 'function') ack({ ok: true, lobby });
      io.to(code).emit('room:update', lobby);
    } catch (e) {
      if (typeof ack === 'function') ack({ ok: false, error: e.message || 'create failed' });
    }
  });

  socket.on('room:join', (payload, ack) => {
    try {
      const code = String((payload && payload.code) || '')
        .trim()
        .toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Room not found' });
        return;
      }
      if (room.players.length >= 2) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Room full' });
        return;
      }
      if (room._tickRunning) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Match in progress' });
        return;
      }
      const name = String((payload && payload.name) || 'P2').slice(0, 12);
      const player = {
        id: socket.id,
        name,
        skin: (payload && payload.skin) || defaultSkin(1),
        playerIndex: 1,
        ready: false,
        isHost: false,
      };
      room.players.push(player);
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerIndex = 1;
      const lobby = lobbyPayload(room);
      if (typeof ack === 'function') ack({ ok: true, lobby });
      io.to(code).emit('room:update', lobby);
    } catch (e) {
      if (typeof ack === 'function') ack({ ok: false, error: e.message || 'join failed' });
    }
  });

  socket.on('room:ready', (payload) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players.find((x) => x.id === socket.id);
    if (!p) return;
    p.ready = !!(payload && payload.ready);
    io.to(code).emit('room:update', lobbyPayload(room));
    tryStart(room);
  });

  socket.on('room:leave', () => leave(socket));

  socket.on('game:dir', (payload) => {
    const code = socket.data.roomCode;
    const idx = socket.data.playerIndex;
    const room = rooms.get(code);
    if (!room || room.gameOver || idx == null) return;
    const dir = payload && payload.dir;
    if (!dir || typeof dir.x !== 'number' || typeof dir.y !== 'number') return;
    if (Math.abs(dir.x) + Math.abs(dir.y) !== 1) return;
    const s = room.snakes[idx];
    if (!s || !s.alive) return;
    s.nextDir = { x: dir.x, y: dir.y };
  });

  socket.on('game:pause', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.gameOver) return;
    room.paused = !room.paused;
    io.to(code).emit('game:pause', { paused: room.paused });
  });

  socket.on('game:restart', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    const host = room.players.find((p) => p.isHost);
    if (!host || host.id !== socket.id) return;
    for (let i = 0; i < room.players.length; i++) room.players[i].ready = true;
    stopLoop(room);
    room.gameOver = false;
    room.paused = false;
    tryStart(room);
  });

  socket.on('game:ping', (t0, ack) => {
    if (typeof ack === 'function') ack(t0);
  });

  socket.on('disconnect', () => leave(socket));
});

function leave(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.data.playerIndex = null;
  if (!room) return;
  room.players = room.players.filter((p) => p.id !== socket.id);
  stopLoop(room);
  room.gameOver = true;
  if (room.players.length === 0) {
    destroyRoom(code);
    return;
  }
  room.players[0].isHost = true;
  room.players[0].playerIndex = 0;
  room.players[0].ready = false;
  io.to(code).emit('room:opponentLeft');
  io.to(code).emit('room:update', lobbyPayload(room));
  io.to(code).emit('game:backToLobby');
}

server.listen(PORT, () => {
  console.log(`Miami Shot server on http://localhost:${PORT}`);
});
