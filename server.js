/**
 * Miami Shot — online multiplayer server (sketch / playable)
 * Run: npm install && npm start
 * Default: http://localhost:3000
 *
 * Client events expected by the HTML game:
 *  room:create { name, skin } -> ack { ok, lobby }
 *  room:join   { code, name, skin } -> ack { ok, lobby }
 *  room:ready  { ready }
 *  room:leave
 *  game:dir    { dir: {x,y} }
 *  game:pause
 *  game:restart
 *  game:ping   (ack RTT)
 *
 * Server emits:
 *  room:update, room:opponentLeft
 *  game:start, game:state, game:over, game:pause, game:backToLobby
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const COLS = 20;
const ROWS = 20;
const TICK_MS = 120;
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
});

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return rooms.has(code) ? makeCode() : code;
}

function emptyCell(room, x, y) {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
  for (const s of room.snakes) {
    if (!s.alive) continue;
    if (s.body.some((p) => p.x === x && p.y === y)) return false;
  }
  if (room.food && room.food.x === x && room.food.y === y) return false;
  return true;
}

function spawnFood(room) {
  for (let i = 0; i < 400; i++) {
    const x = (Math.random() * COLS) | 0;
    const y = (Math.random() * ROWS) | 0;
    if (emptyCell(room, x, y)) {
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
  return {
    code: room.code,
    players: room.players.map((p) => ({
      playerIndex: p.playerIndex,
      name: p.name,
      ready: !!p.ready,
      isHost: p.isHost,
    })),
  };
}

function publicState(room) {
  return {
    scores: room.scores.slice(),
    food: room.food ? { ...room.food } : null,
    speed: room.speed,
    snakes: room.snakes.map((s) => ({
      body: s.body.map((p) => ({ x: p.x, y: p.y })),
      alive: s.alive,
      skin: s.skin,
    })),
    players: room.players.map((p) => ({
      playerIndex: p.playerIndex,
      name: p.name,
    })),
  };
}

function resetMatch(room) {
  room.scores = [0, 0];
  room.speed = TICK_MS;
  room.paused = false;
  room.gameOver = false;
  room.snakes = [
    {
      body: [
        { x: 4, y: 10 },
        { x: 3, y: 10 },
        { x: 2, y: 10 },
      ],
      dir: { x: 1, y: 0 },
      nextDir: { x: 1, y: 0 },
      alive: true,
      skin: room.players[0]?.skin || defaultSkin(0),
    },
    {
      body: [
        { x: 15, y: 10 },
        { x: 16, y: 10 },
        { x: 17, y: 10 },
      ],
      dir: { x: -1, y: 0 },
      nextDir: { x: -1, y: 0 },
      alive: true,
      skin: room.players[1]?.skin || defaultSkin(1),
    },
  ];
  spawnFood(room);
}

function stopLoop(room) {
  if (room.loop) {
    clearInterval(room.loop);
    room.loop = null;
  }
}

function endGame(room, winner) {
  if (room.gameOver) return;
  room.gameOver = true;
  stopLoop(room);
  io.to(room.code).emit('game:over', {
    winner, // 0 | 1 | null draw
    scores: room.scores.slice(),
  });
}

function stepRoom(room) {
  if (room.paused || room.gameOver) return;

  for (let i = 0; i < room.snakes.length; i++) {
    const s = room.snakes[i];
    if (!s.alive) continue;
    // apply buffered dir (no reverse into self)
    const nd = s.nextDir || s.dir;
    if (!(nd.x === -s.dir.x && nd.y === -s.dir.y)) s.dir = { x: nd.x, y: nd.y };

    const head = s.body[0];
    const nx = head.x + s.dir.x;
    const ny = head.y + s.dir.y;

    // wall
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) {
      s.alive = false;
      continue;
    }

    // self / other collision
    let hit = false;
    for (let j = 0; j < room.snakes.length; j++) {
      const other = room.snakes[j];
      if (!other.alive) continue;
      for (let k = 0; k < other.body.length; k++) {
        // allow head-on: both die later
        if (other.body[k].x === nx && other.body[k].y === ny) {
          // if only tail of self and not growing, classic snake allows — keep strict
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) {
      s.alive = false;
      continue;
    }

    s.body.unshift({ x: nx, y: ny });
    const ate = room.food && room.food.x === nx && room.food.y === ny;
    if (ate) {
      room.scores[i] += 1;
      spawnFood(room);
      // slight speed-up
      room.speed = Math.max(70, room.speed - 2);
    } else {
      s.body.pop();
    }
  }

  // head-on same cell
  const h0 = room.snakes[0]?.alive ? room.snakes[0].body[0] : null;
  const h1 = room.snakes[1]?.alive ? room.snakes[1].body[0] : null;
  if (h0 && h1 && h0.x === h1.x && h0.y === h1.y) {
    room.snakes[0].alive = false;
    room.snakes[1].alive = false;
  }

  const a0 = room.snakes[0]?.alive;
  const a1 = room.snakes[1]?.alive;
  if (!a0 || !a1) {
    let winner = null;
    if (a0 && !a1) winner = 0;
    else if (a1 && !a0) winner = 1;
    else winner = null;
    io.to(room.code).emit('game:state', publicState(room));
    endGame(room, winner);
    return;
  }

  io.to(room.code).emit('game:state', publicState(room));
}

function startLoop(room) {
  stopLoop(room);
  room.loop = setInterval(() => stepRoom(room), room.speed || TICK_MS);
}

function tryStart(room) {
  if (room.players.length < 2) return;
  if (!room.players.every((p) => p.ready)) return;
  resetMatch(room);
  room.players.forEach((p) => {
    p.ready = false;
  });
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
      const name = String(payload?.name || 'P1').slice(0, 12);
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
      };
      const player = {
        id: socket.id,
        name,
        skin: payload?.skin || defaultSkin(0),
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
      const code = String(payload?.code || '')
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
      if (room.loop) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Match in progress' });
        return;
      }
      const name = String(payload?.name || 'P2').slice(0, 12);
      const player = {
        id: socket.id,
        name,
        skin: payload?.skin || defaultSkin(1),
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
    p.ready = !!payload?.ready;
    io.to(code).emit('room:update', lobbyPayload(room));
    tryStart(room);
  });

  socket.on('room:leave', () => {
    leave(socket);
  });

  socket.on('game:dir', (payload) => {
    const code = socket.data.roomCode;
    const idx = socket.data.playerIndex;
    const room = rooms.get(code);
    if (!room || room.gameOver || idx == null) return;
    const dir = payload?.dir;
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
    room.players.forEach((p) => {
      p.ready = false;
    });
    stopLoop(room);
    room.gameOver = false;
    room.paused = false;
    // back to lobby ready flow — auto re-ready both for quick rematch
    room.players.forEach((p) => {
      p.ready = true;
    });
    tryStart(room);
  });

  socket.on('game:ping', (t0, ack) => {
    if (typeof ack === 'function') ack(t0);
  });

  socket.on('disconnect', () => {
    leave(socket);
  });
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
  // promote host
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
