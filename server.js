// ============================================================
// 星辉秘境 · 三分天下  联机版 · 服务端
// 结构：常量 → 房间管理 → 战争迷雾序列化 → Socket 事件 → 调度骨架
// 后两节补：游戏核心逻辑 → AI → 启动入口
// ============================================================
'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

/* ==================== 常量 ==================== */
const COLS = 25, ROWS = 14;
const VIEW_RADIUS = 3;           // 战争迷雾视野（曼哈顿距离）
const DIRS = [[0,-1],[0,1],[-1,0],[1,0]];
const TEAMS = ['A', 'B', 'C'];
const HIGH_SHRINE_CAP = 60;
const MAP_STONES = 20;
const MAP_FORESTS = 40;
const MAP_RIFTS = 3;

const TEAM_COLORS = {
  A: '#2563eb',
  B: '#ef4444',
  C: '#22c55e'
};

const CLASS_DEFS = {
  shield:    { shortName: '盾卫', fullName: '圣盾守卫', move: 2, icon: 'game-icons:checked-shield' },
  archer:    { shortName: '弓手', fullName: '秘林弓手', move: 2, icon: 'game-icons:bow-arrow' },
  greatsword:{ shortName: '巨剑', fullName: '巨剑战士', move: 3, icon: 'game-icons:crossed-swords' },
  shadow:    { shortName: '影刃', fullName: '影刃行者', move: 3, icon: 'game-icons:cloak-dagger' },
  spear:     { shortName: '龙枪', fullName: '龙枪守卫', move: 2, icon: 'game-icons:glaive' },
  runesmith: { shortName: '符文', fullName: '符文匠师', move: 3, icon: 'game-icons:rune-stone' },
  priest:    { shortName: '祭司', fullName: '生命祭司', move: 2, icon: 'game-icons:heart-plus' },
};

const SHRINE_DEFS = [
  { x: 3, y: 3, isHigh: false },
  { x: 21, y: 3, isHigh: false },
  { x: 12, y: 12, isHigh: false },
  { x: 12, y: 3, isHigh: true }
];

const HOME_SHRINE_COORDS = {
  A: { x: 3, y: 3 },
  B: { x: 21, y: 3 },
  C: { x: 12, y: 12 }
};

const NEUTRAL_SPRINGS = [
  { x: 9, y: 3 },
  { x: 15, y: 3 },
  { x: 12, y: 6 }
];

const FIXED_POSITIONS = {
  A: [
    { cls: 'shield', x: 3, y: 3 },
    { cls: 'priest', x: 2, y: 2 }, { cls: 'priest', x: 2, y: 4 },
    { cls: 'archer', x: 4, y: 0 }, { cls: 'archer', x: 4, y: 6 },
    { cls: 'shadow', x: 2, y: 0 }, { cls: 'shadow', x: 2, y: 6 },
    { cls: 'spear', x: 3, y: 1 }, { cls: 'spear', x: 3, y: 5 },
    { cls: 'greatsword', x: 3, y: 2 }, { cls: 'greatsword', x: 3, y: 4 },
    { cls: 'runesmith', x: 6, y: 0 }, { cls: 'runesmith', x: 6, y: 2 },
    { cls: 'runesmith', x: 6, y: 4 }, { cls: 'runesmith', x: 6, y: 6 }
  ],
  B: [
    { cls: 'shield', x: 21, y: 3 },
    { cls: 'priest', x: 22, y: 2 }, { cls: 'priest', x: 22, y: 4 },
    { cls: 'archer', x: 20, y: 0 }, { cls: 'archer', x: 20, y: 6 },
    { cls: 'shadow', x: 22, y: 0 }, { cls: 'shadow', x: 22, y: 6 },
    { cls: 'spear', x: 21, y: 1 }, { cls: 'spear', x: 21, y: 5 },
    { cls: 'greatsword', x: 21, y: 2 }, { cls: 'greatsword', x: 21, y: 4 },
    { cls: 'runesmith', x: 18, y: 0 }, { cls: 'runesmith', x: 18, y: 2 },
    { cls: 'runesmith', x: 18, y: 4 }, { cls: 'runesmith', x: 18, y: 6 }
  ],
  C: [
    { cls: 'shield', x: 12, y: 12 },
    { cls: 'priest', x: 11, y: 13 }, { cls: 'priest', x: 13, y: 13 },
    { cls: 'archer', x: 9, y: 11 }, { cls: 'archer', x: 15, y: 11 },
    { cls: 'shadow', x: 9, y: 13 }, { cls: 'shadow', x: 15, y: 13 },
    { cls: 'spear', x: 10, y: 12 }, { cls: 'spear', x: 14, y: 12 },
    { cls: 'greatsword', x: 11, y: 12 }, { cls: 'greatsword', x: 13, y: 12 },
    { cls: 'runesmith', x: 9, y: 9 }, { cls: 'runesmith', x: 11, y: 9 },
    { cls: 'runesmith', x: 13, y: 9 }, { cls: 'runesmith', x: 15, y: 9 }
  ]
};

const SPAWN_ZONES = [
  { x0: 2, x1: 6, y0: 0, y1: 6 },
  { x0: 18, x1: 22, y0: 0, y1: 6 },
  { x0: 9, x1: 15, y0: 9, y1: 13 }
];

/* ==================== 房间管理 ==================== */
const rooms = new Map();      // code -> room
const tokenIndex = new Map(); // token -> { code, team }

function genRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

function createRoom(socket, nick) {
  let code, attempts = 0;
  do { code = genRoomCode(); attempts++; } while (rooms.has(code) && attempts < 200);
  const token = genToken();
  const room = {
    code,
    hostToken: token,
    slots: {
      A: { type: 'human', token, nick: (nick || '房主').slice(0, 12), socketId: socket.id, connected: true },
      B: { type: 'ai',    token: null, nick: 'AI-B', socketId: null, connected: true },
      C: { type: 'ai',    token: null, nick: 'AI-C', socketId: null, connected: true }
    },
    status: 'lobby',
    game: null,
    seq: 0,
    aiTimer: null,
    turnLock: false
  };
  rooms.set(code, room);
  tokenIndex.set(token, { code, team: 'A' });
  socket.data.roomCode = code;
  socket.data.token = token;
  socket.data.team = 'A';
  socket.join(code);
  return { room, token };
}

function joinRoom(socket, code, nick) {
  const room = rooms.get(code);
  if (!room) return { ok: false, error: '房间不存在' };
  if (room.status !== 'lobby') return { ok: false, error: '游戏已开始，无法加入' };
  const emptyTeam = TEAMS.find(t => room.slots[t].type === 'empty');
  if (!emptyTeam) return { ok: false, error: '房间已满或没有开放真人槽位' };
  const token = genToken();
  const slot = room.slots[emptyTeam];
  slot.type = 'human';
  slot.token = token;
  slot.nick = (nick || ('玩家' + emptyTeam)).slice(0, 12);
  slot.socketId = socket.id;
  slot.connected = true;
  tokenIndex.set(token, { code, team: emptyTeam });
  socket.data.roomCode = code;
  socket.data.token = token;
  socket.data.team = emptyTeam;
  socket.join(code);
  return { ok: true, token, team: emptyTeam, room };
}

function setSlot(socket, team, type) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return { ok: false, error: '房间不存在' };
  if (socket.data.token !== room.hostToken) return { ok: false, error: '只有房主能设置' };
  if (room.status !== 'lobby') return { ok: false, error: '游戏已开始' };
  if (!TEAMS.includes(team)) return { ok: false, error: '槽位无效' };
  if (!['ai', 'empty'].includes(type)) return { ok: false, error: '类型无效' };
  const slot = room.slots[team];
  if (slot.type === 'human') return { ok: false, error: '该槽位已有玩家' };
  slot.type = type;
  slot.nick = type === 'ai' ? ('AI-' + team) : null;
  return { ok: true, room };
}

function lobbyState(room, forTeam) {
  const slots = {};
  for (const t of TEAMS) {
    const s = room.slots[t];
    slots[t] = { type: s.type, nick: s.nick || null, connected: s.connected !== false };
  }
  return {
    code: room.code,
    slots,
    status: room.status,
    you: forTeam,
    isHost: forTeam && (room.slots[forTeam].token === room.hostToken)
  };
}

function broadcastLobby(room) {
  for (const t of TEAMS) {
    const slot = room.slots[t];
    if (slot.type !== 'human' || !slot.socketId) continue;
    io.to(slot.socketId).emit('lobby', lobbyState(room, t));
  }
}


function serializeFor(team, room, seq, events) {
  const game = room.game;
  const units = [];
  for (const u of game.units) {
    units.push({
      id: u.id, team: u.team, cls: u.cls, x: u.x, y: u.y,
      hp: u.hp, alive: u.alive, hasActed: u.hasActed,
      hasMovedThisRound: u.hasMovedThisRound,
      isVigilant: u.isVigilant, isCrippled: u.isCrippled
    });
  }
  return {
    seq,
    you: team,
    phase: game.phase,
    round: game.round,
    score: game.score,
    units,
    shrines: game.shrines.map(s => ({ x: s.x, y: s.y, isHigh: s.isHigh, owner: s.owner })),
    springs: game.springs.map(s => ({ x: s.x, y: s.y, uses: s.uses, type: s.type })),
    obstacles: Array.from(game.obstacles),
    forests: Array.from(game.forests),
    rifts: game.rifts.map(r => ({ x: r.x, y: r.y })),
    log: game.log.slice(0, 30),
    events: events || [],
    actingUnitId: game.aiFocusId || null,
    turnLocked: room.turnLock,
    gameOver: !!game.gameOver,
    winner: game.winner || null,
    highShrinePool: game.highShrinePool,
    highShrineClosed: game.highShrineClosed,
    turnInRound: game.turnInRound,
    selectedUnitId: game.selectedUnitId || null
  };
}

function broadcast(room) {
  if (!room.game) return;
  const seq = ++room.seq;
  const events = room.game.events || [];
  for (const t of TEAMS) {
    const slot = room.slots[t];
    if (slot.type !== 'human' || !slot.socketId) continue;
    io.to(slot.socketId).emit('state', serializeFor(t, room, seq, events));
  }
  room.game.events = [];
}

/* ==================== 调度骨架 ==================== */
// 一次行动结束后的统一调度：先广播结果 → 若需要切回合 → 延迟 → switchTurn → 若下一家是 AI → 调度 AI
function afterAction(room, result) {
  broadcast(room);
  if (!result || !result.needsTurnEnd) return;
  if (room.game.gameOver) { finalizeGame(room); return; }

  room.turnLock = true;
  setTimeout(() => {
    room.turnLock = false;
    switchTurn(room.game);
    broadcast(room);
    if (room.game.gameOver) { finalizeGame(room); return; }
    scheduleAI(room);
  }, 1000);
}

function scheduleAI(room) {
  if (room.status !== 'playing' || room.game.gameOver) return;
  const slot = room.slots[room.game.phase];
  if (slot.type !== 'ai') return;

  clearTimeout(room.aiTimer);
  room.aiTimer = setTimeout(() => {
    if (room.status !== 'playing' || room.game.gameOver) return;
    const currentTeam = room.game.phase;
    if (room.slots[currentTeam].type !== 'ai') return;

    let result;
    try {
      result = aiTakeOneAction(room.game, currentTeam);
    } catch (e) {
      console.error('AI error:', e);
      result = null;
    }
    // AI 的 finishAction 内部已把事件入队，且返回 needsTurnEnd
    if (result && result.needsTurnEnd) {
      afterAction(room, result);
    } else if (result && result.actionEnded) {
      // 裂隙传送等直接结束行动，也走切回合
      afterAction(room, { needsTurnEnd: true });
    } else {
      // AI 没动，兜底：强行 doWait
      const u = room.game.units.find(x => x.alive && x.team === currentTeam && !x.hasActed);
      if (u) {
        const r2 = doWait(room.game, u);
        afterAction(room, r2);
      } else {
        afterAction(room, { needsTurnEnd: true });
      }
    }
  }, 1600);
}

function finalizeGame(room) {
  room.status = 'over';
  clearTimeout(room.aiTimer);
  // 最终广播（把 gameOver/winner 传出去）
  broadcast(room);
  broadcastLobby(room);
}

/* ==================== Socket 事件 ==================== */
io.on('connection', (socket) => {
  socket.on('ping_check', (cb) => {
    if (typeof cb === 'function') cb();
  });

  socket.on('create_room', ({ nick } = {}) => {
    if (socket.data.roomCode) return;
    const { room, token } = createRoom(socket, nick);
    socket.emit('room_created', {
      code: room.code, token, team: 'A',
      lobby: lobbyState(room, 'A')
    });
  });

  socket.on('join_room', ({ code, nick } = {}) => {
    if (socket.data.roomCode) return;
    if (!code) return socket.emit('join_error', '请输入房间码');
    const res = joinRoom(socket, code.toUpperCase(), nick);
    if (!res.ok) return socket.emit('join_error', res.error);
    const room = res.room;
    socket.emit('joined', {
      code: room.code, token: res.token, team: res.team,
      lobby: lobbyState(room, res.team)
    });
    broadcastLobby(room);
  });

  socket.on('reconnect_token', ({ code, token } = {}) => {
    if (socket.data.roomCode) return;
    const idx = tokenIndex.get(token);
    if (!idx || idx.code !== code) return socket.emit('reconnect_failed', '登录信息无效');
    const room = rooms.get(code);
    if (!room) return socket.emit('reconnect_failed', '房间已关闭');
    const slot = room.slots[idx.team];
    if (slot.type !== 'human') return socket.emit('reconnect_failed', '槽位已变更');
    if (slot.socketId && slot.socketId !== socket.id) {
      const old = io.sockets.sockets.get(slot.socketId);
      if (old) { try { old.emit('kicked_by_reconnect'); old.disconnect(true); } catch (e) {} }
    }
    slot.socketId = socket.id;
    slot.connected = true;
    socket.data.roomCode = code;
    socket.data.token = token;
    socket.data.team = idx.team;
    socket.join(code);

    socket.emit('reconnected', {
      code, token, team: idx.team, status: room.status,
      lobby: lobbyState(room, idx.team)
    });
    broadcastLobby(room);

    if (room.status === 'playing' || room.status === 'over') {
      const snap = serializeFor(idx.team, room, ++room.seq, []);
      socket.emit('state', snap);
      if (room.status === 'playing' && room.game && room.game.phase === idx.team) {
        room.turnLock = false;
      }
    }
  });

  socket.on('set_slot', ({ team, type } = {}) => {
    const res = setSlot(socket, team, type);
    if (!res.ok) return socket.emit('action_error', res.error);
    broadcastLobby(res.room);
  });

  socket.on('start_game', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.token !== room.hostToken) return socket.emit('action_error', '只有房主能开始');
    if (room.status !== 'lobby') return socket.emit('action_error', '游戏已开始');
    if (TEAMS.some(t => room.slots[t].type === 'empty')) return socket.emit('action_error', '有槽位未分配');
    const humans = TEAMS.filter(t => room.slots[t].type === 'human').length;
    if (humans < 1) return socket.emit('action_error', '至少需要 1 名真人玩家');

    room.status = 'playing';
    room.game = createGame(room);
    room.seq = 0;
    room.turnLock = false;

    for (const t of TEAMS) {
      const s = room.slots[t];
      if (s.type === 'human' && s.socketId) {
        io.to(s.socketId).emit('game_started', { you: t });
      }
    }
    broadcast(room);
    broadcastLobby(room);
    scheduleAI(room);
  });

  socket.on('action', (action) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing' || !room.game) return;
    if (room.game.gameOver) return;
    const team = socket.data.team;
    if (!team) return;
    if (room.game.phase !== team) return socket.emit('action_error', '还未轮到你');
    if (room.turnLock) return socket.emit('action_error', '行动处理中');

    let result;
    try {
      result = runAction(room.game, team, action || {});
    } catch (e) {
      console.error('action error:', e);
      return socket.emit('action_error', '动作执行异常');
    }
    if (result && result.error) return socket.emit('action_error', result.error);
    afterAction(room, result);
  });

  socket.on('leave_room', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    for (const t of TEAMS) {
      const s = room.slots[t];
      if (s.socketId === socket.id) {
        if (s.type === 'human') {
          s.type = 'empty';
          s.token = null;
          s.socketId = null;
          s.nick = null;
          s.connected = true;
          tokenIndex.delete(socket.data.token);
        }
        break;
      }
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.token = null;
    socket.data.team = null;
    broadcastLobby(room);
    socket.emit('left_room');
  });

  socket.on('leave_game', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const team = socket.data.team;

    if (room.status === 'playing' && team && room.slots[team].type === 'human') {
      const slot = room.slots[team];
      slot.type = 'ai';
      slot.nick = 'AI-' + team;
      slot.socketId = null;
      slot.token = null;
      slot.connected = true;
      if (socket.data.token) tokenIndex.delete(socket.data.token);

      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.token = null;
      socket.data.team = null;

      broadcastLobby(room);
      broadcast(room);
      socket.emit('left_room');

      if (room.game && !room.game.gameOver && room.game.phase === team && !room.turnLock) {
        scheduleAI(room);
      }
      return;
    }

    for (const t of TEAMS) {
      const s = room.slots[t];
      if (s.socketId === socket.id) {
        if (s.type === 'human') {
          s.type = 'empty';
          s.token = null;
          s.socketId = null;
          s.nick = null;
          s.connected = true;
          tokenIndex.delete(socket.data.token);
        }
        break;
      }
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.token = null;
    socket.data.team = null;
    broadcastLobby(room);
    socket.emit('left_room');
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    for (const t of TEAMS) {
      const s = room.slots[t];
      if (s.socketId === socket.id) {
        s.socketId = null;
        s.connected = false;
        break;
      }
    }
    broadcastLobby(room);
  });
});

/* ==================== 游戏核心逻辑 ==================== */
// 工具
function log(game, msg) {
  game.log.unshift(msg);
  if (game.log.length > 80) game.log.pop();
}
function key(x, y) { return x + ',' + y; }
function inBounds(x, y) { return x >= 0 && x < COLS && y >= 0 && y < ROWS; }
function unitAt(game, x, y) { return game.units.find(u => u.alive && u.x === x && u.y === y); }
function shrineAt(game, x, y) { return game.shrines.find(s => s.x === x && s.y === y); }
function springAt(game, x, y) { return game.springs.find(s => s.x === x && s.y === y); }
function isObstacle(game, x, y) { return game.obstacles.has(key(x, y)); }
function inForest(game, x, y) { return game.forests.has(key(x, y)); }
function inRift(game, x, y) { return game.rifts.some(r => r.x === x && r.y === y); }
function isEnemy(a, b) { return a !== b; }

function springUsableBy(spring, team) {
  if (spring.type === 'neutral') return spring.uses > 0;
  return false;
}

function getMove(u) {
  if (u.isCrippled) return 0;
  if (u.hp <= 1) return 1;
  let m = CLASS_DEFS[u.cls].move;
  if (u.hp === 2) m = Math.max(1, m - 1);
  return m;
}

function isEnemyZoc(game, x, y, team) {
  return game.units.some(u => u.alive && u.team !== team && Math.abs(u.x - x) + Math.abs(u.y - y) === 1);
}

// 地图生成
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function checkConnectivity(game) {
  const targets = [];
  SHRINE_DEFS.forEach(s => targets.push(key(s.x, s.y)));
  NEUTRAL_SPRINGS.forEach(s => targets.push(key(s.x, s.y)));
  const starts = [key(3, 3), key(21, 3), key(12, 12)];
  const vis = new Set(starts);
  const q = starts.slice();
  while (q.length) {
    const k = q.shift();
    const [x, y] = k.split(',').map(Number);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const nk = key(nx, ny);
      if (vis.has(nk) || game.obstacles.has(nk)) continue;
      vis.add(nk); q.push(nk);
    }
  }
  return targets.every(t => vis.has(t));
}

function generateMap(game) {
  let valid = false;
  let attempts = 0;
  while (!valid && attempts < 300) {
    attempts++;
    game.obstacles = new Set();
    game.forests = new Set();
    game.rifts = [];
    game.shrines = SHRINE_DEFS.map((s, idx) => {
      let owner = null;
      if (idx === 0) owner = 'A';
      else if (idx === 1) owner = 'B';
      else if (idx === 2) owner = 'C';
      return { x: s.x, y: s.y, isHigh: s.isHigh, owner: owner };
    });
    game.springs = NEUTRAL_SPRINGS.map(sp => ({ x: sp.x, y: sp.y, type: 'neutral', uses: 10 }));

    const prot = new Set();
    SPAWN_ZONES.forEach(z => {
      for (let x = z.x0; x <= z.x1; x++) for (let y = z.y0; y <= z.y1; y++) prot.add(key(x, y));
    });
    game.shrines.forEach(s => {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const nx = s.x + dx, ny = s.y + dy;
        if (inBounds(nx, ny)) prot.add(key(nx, ny));
      }
    });
    game.springs.forEach(s => prot.add(key(s.x, s.y)));

    const candidates = [];
    for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) {
      if (!prot.has(key(x, y))) candidates.push({ x, y });
    }
    shuffle(candidates);

    for (let i = 0; i < MAP_STONES && i < candidates.length; i++) {
      game.obstacles.add(key(candidates[i].x, candidates[i].y));
    }
    let fCount = 0;
    for (let i = MAP_STONES; i < candidates.length && fCount < MAP_FORESTS; i++) {
      const k = key(candidates[i].x, candidates[i].y);
      if (!game.obstacles.has(k)) { game.forests.add(k); fCount++; }
    }

    let riftAttempts = 0;
    while (game.rifts.length < MAP_RIFTS && riftAttempts < 3000) {
      riftAttempts++;
      const rx = Math.floor(Math.random() * COLS);
      const ry = Math.floor(Math.random() * ROWS);
      const k = key(rx, ry);
      if (prot.has(k)) continue;
      if (game.obstacles.has(k)) continue;
      if (game.rifts.some(r => Math.abs(r.x - rx) + Math.abs(r.y - ry) < 5)) continue;
      game.forests.delete(k);
      game.rifts.push({ x: rx, y: ry });
    }

    valid = checkConnectivity(game);
  }
  if (!valid) {
    game.obstacles = new Set();
  }
}

// 单位
function createUnits(game) {
  game.units = [];
  let id = 0;
  ['A', 'B', 'C'].forEach(team => {
    FIXED_POSITIONS[team].forEach(u => {
      game.units.push({
        id: id++, team: team, cls: u.cls, x: u.x, y: u.y,
        hp: 4, alive: true, hasActed: false, hasMovedThisRound: false,
        shieldUsedThisRound: false, isVigilant: false, isCrippled: null
      });
    });
  });
}

// 可达性
function getReachable(game, unit) {
  const reach = new Map();
  reach.set(key(unit.x, unit.y), true);
  const visited = new Set([key(unit.x, unit.y)]);
  if (unit.isCrippled) return reach;

  const ignoreZoc = unit.cls === 'shadow' && unit.hp >= 3;
  const startInZoc = !ignoreZoc && isEnemyZoc(game, unit.x, unit.y, unit.team);
  const maxSteps = startInZoc ? 1 : getMove(unit);
  let frontier = [[unit.x, unit.y, 0]];
  while (frontier.length) {
    const next = [];
    for (const [x, y, step] of frontier) {
      if (step >= maxSteps) continue;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const k = key(nx, ny);
        if (visited.has(k) || isObstacle(game, nx, ny)) continue;
        if (unitAt(game, nx, ny)) continue;
        visited.add(k); reach.set(k, true);
        const inZoc = !ignoreZoc && isEnemyZoc(game, nx, ny, unit.team);
        if (!inZoc) next.push([nx, ny, step + 1]);
      }
    }
    frontier = next;
  }
  return reach;
}

function getAttackTargets(game, unit) {
  const res = [];
  if (unit.hp <= 1) return res;
  for (const e of game.units) {
    if (!e.alive || e.team === unit.team) continue;
    if (inForest(game, e.x, e.y)) {
      const dx0 = Math.abs(e.x - unit.x), dy0 = Math.abs(e.y - unit.y);
      if (dx0 + dy0 !== 1) continue;
    }
    const dx = e.x - unit.x, dy = e.y - unit.y;
    const dist = Math.abs(dx) + Math.abs(dy);
    if (unit.cls === 'archer') {
      let range = 2;
      if (unit.hp >= 3 && !unit.hasMovedThisRound) range = 3;
      if (dist >= 2 && dist <= range) res.push(e);
    } else if (unit.cls === 'spear') {
      if (dx === 0 || dy === 0) {
        if (dist === 1) res.push(e);
        else if (dist === 2) {
          const mx = unit.x + dx / 2, my = unit.y + dy / 2;
          const midUnit = unitAt(game, mx, my);
          if (!isObstacle(game, mx, my) && (!midUnit || midUnit.team === unit.team)) {
            res.push(e);
          }
        }
      }
    } else {
      if (dist === 1) res.push(e);
    }
  }
  return res;
}

// 核心动作
function dealDamage(game, target, amount, pierce = false) {
  if (!pierce && target.cls === 'shield' && target.hp >= 3 && !target.hasMovedThisRound && !target.shieldUsedThisRound) {
    target.shieldUsedThisRound = true;
    log(game, '圣盾壁垒触发：' + CLASS_DEFS[target.cls].fullName + '免疫本次伤害');
    game.events.push({ type: 'popup', x: target.x, y: target.y, text: '免疫', color: TEAM_COLORS[target.team] });
    game.events.push({ type: 'fx', cls: 'shield', team: target.team, x: target.x, y: target.y });
    return;
  }
  target.hp -= amount;
  if (target.hp < 4) target.isVigilant = false;

  if (target.hp <= 0) {
    target.hp = 0; target.alive = false;
    target.isCrippled = null;
    game.events.push({ type: 'popup', x: target.x, y: target.y, text: '-' + amount, color: '#ef4444' });
    game.events.push({ type: 'sound', name: 'death' });
    log(game, (target.team === 'A' ? '蓝方' : target.team === 'B' ? '红方' : '绿方') + CLASS_DEFS[target.cls].fullName + '陨落');
  } else {
    game.events.push({ type: 'popup', x: target.x, y: target.y, text: '-' + amount, color: '#ef4444' });
    game.events.push({ type: 'sound', name: 'hit' });
    game.events.push({ type: 'hit', unitId: target.id });
  }
}

function tryKnockback(game, attacker, target) {
  if (attacker.hp < 3) return;
  const dx = target.x - attacker.x, dy = target.y - attacker.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return;
  const nx = target.x + dx, ny = target.y + dy;
  if (!inBounds(nx, ny) || isObstacle(game, nx, ny) || unitAt(game, nx, ny)) {
    game.events.push({ type: 'popup', x: target.x, y: target.y, text: '击退受阻', color: '#94a3b8' });
    return;
  }
  target.x = nx; target.y = ny;
  game.events.push({ type: 'popup', x: nx, y: ny, text: '击退', color: '#0ea5e9' });
  game.events.push({ type: 'sound', name: 'knock' });
  log(game, CLASS_DEFS[target.cls].fullName + '被击退1格');
}

function handleKillScore(game, winnerTeam) {
  game.score[winnerTeam] += 3;
  log(game, (winnerTeam === 'A' ? '蓝方' : winnerTeam === 'B' ? '红方' : '绿方') + '击杀英雄，获得 3 分！');
  checkGameOver(game);
}

function doMove(game, u, x, y) {
  if (u.hasMovedThisRound || u.isCrippled) return { error: '不可移动' };
  game.moveOrigin = { unitId: u.id, x: u.x, y: u.y };
  u.x = x; u.y = y;
  u.hasMovedThisRound = true;

  if (inRift(game, x, y)) {
    log(game, CLASS_DEFS[u.cls].fullName + '踏入了虚空裂隙！');
    const empties = [];
    for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) {
      if (!isObstacle(game, i, j) && !unitAt(game, i, j) && !inRift(game, i, j)) empties.push({ x: i, y: j });
    }
    if (empties.length > 0) {
      const dest = empties[Math.floor(Math.random() * empties.length)];
      game.events.push({ type: 'popup', x: x, y: y, text: '传送', color: '#7c3aed' });
      game.events.push({ type: 'fx', cls: 'portal', team: u.team, x: x, y: y, tx: dest.x, ty: dest.y });
      u.x = dest.x; u.y = dest.y;
      game.events.push({ type: 'popup', x: dest.x, y: dest.y, text: '降临', color: '#7c3aed' });
    }
    game.events.push({ type: 'sound', name: 'collapse' });
    log(game, '虚空裂隙紊乱，行动被迫结束。');
    return finishAction(game, u, 'wait', { forceEnded: true });
  }

  game.events.push({ type: 'sound', name: 'move', cls: u.cls });
  return { needsTurnEnd: false, ended: false };
}

function doAttack(game, a, d) {
  const prevAlive = d.alive;
  if (a.cls === 'archer') game.events.push({ type: 'fx', cls: 'archer', team: a.team, x: a.x, y: a.y, tx: d.x, ty: d.y });
  else if (a.cls === 'shadow') game.events.push({ type: 'fx', cls: 'shadow', team: a.team, x: d.x, y: d.y });
  else if (a.cls === 'runesmith') game.events.push({ type: 'fx', cls: 'runesmith', team: a.team, x: d.x, y: d.y });

  let pierce = false;
  if (a.cls === 'runesmith' && a.hp >= 3 && d.alive && d.cls === 'shield') {
    const dx = d.x - a.x, dy = d.y - a.y;
    const nx = d.x + dx, ny = d.y + dy;
    if (inBounds(nx, ny) && !isObstacle(game, nx, ny) && !unitAt(game, nx, ny)) pierce = true;
  }

  dealDamage(game, d, 1, pierce);

  if (a.cls === 'shadow' && a.hp >= 3 && d.alive) {
    d.isCrippled = a.team;
    log(game, `【致残】${CLASS_DEFS[d.cls].fullName}被刺客致残，无法移动！`);
  }
  if (a.cls === 'runesmith' && a.hp >= 3 && d.alive) tryKnockback(game, a, d);
  if (prevAlive && !d.alive) handleKillScore(game, a.team);
  log(game, (a.team === 'A' ? '蓝方' : a.team === 'B' ? '红方' : '绿方') + CLASS_DEFS[a.cls].fullName + '攻击' + CLASS_DEFS[d.cls].fullName);
  return finishAction(game, a, 'attack');
}

function doWait(game, u) {
  log(game, (u.team === 'A' ? '蓝方' : u.team === 'B' ? '红方' : '绿方') + CLASS_DEFS[u.cls].fullName + '驻守调息');
  game.events.push({ type: 'sound', name: 'wait' });
  return finishAction(game, u, 'wait');
}

function doHeal(game, p, t) {
  if (p.hp < 3) return { error: '生命不足' };
  t.hp = Math.min(4, t.hp + 1);
  if (t.isCrippled) {
    t.isCrippled = null;
    log(game, `【解除致残】${CLASS_DEFS[t.cls].fullName} 恢复了行动能力。`);
  }
  log(game, '生命祷言：' + CLASS_DEFS[t.cls].fullName + '恢复1点生命');
  game.events.push({ type: 'popup', x: t.x, y: t.y, text: '+1', color: '#10b981' });
  game.events.push({ type: 'fx', cls: 'priest', team: p.team, x: t.x, y: t.y });
  return finishAction(game, p, 'heal');
}

function doCapture(game, u, s) {
  s.owner = u.team;
  log(game, (u.team === 'A' ? '蓝方' : u.team === 'B' ? '红方' : '绿方') + '占领了' + (s.isHigh ? '高级圣坛' : '圣坛'));
  game.events.push({ type: 'sound', name: 'capture' });
  return finishAction(game, u, 'capture');
}

function doGreatswordSpecial(game, u) {
  if (u.hp < 3) return { error: '生命不足' };
  let obstacleCount = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    if (dx === 0 && dy === 0) continue;
    if (isObstacle(game, u.x + dx, u.y + dy)) obstacleCount++;
  }
  const maxTargets = Math.max(0, 3 - obstacleCount);
  const around = game.units.filter(e => e.alive && e.team !== u.team && Math.abs(e.x - u.x) <= 1 && Math.abs(e.y - u.y) <= 1);
  for (let i = around.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [around[i], around[j]] = [around[j], around[i]]; }
  const chosen = around.slice(0, maxTargets);

  game.events.push({ type: 'fx', cls: 'greatsword', team: u.team, x: u.x, y: u.y });

  if (chosen.length === 0) log(game, '裂地横扫没有命中目标');
  else {
    log(game, '裂地横扫命中' + chosen.length + '名敌军');
    for (const t of chosen) { const prev = t.alive; dealDamage(game, t, 1); if (prev && !t.alive) handleKillScore(game, u.team); }
  }
  return finishAction(game, u, 'attack');
}

function doSpearSpecial(game, u, dx, dy) {
  if (u.hp < 3) return { error: '生命不足' };
  const hits = [];
  for (let d = 1; d <= 2; d++) {
    const tx = u.x + dx * d, ty = u.y + dy * d;
    if (!inBounds(tx, ty)) break;
    if (isObstacle(game, tx, ty)) break;
    const t = unitAt(game, tx, ty);
    if (t) {
      if (t.team !== u.team) {
        hits.push(t);
        if (d === 1) {
          const bx = tx + dx, by = ty + dy;
          if (inBounds(bx, by) && !isObstacle(game, bx, by)) {
            const b = unitAt(game, bx, by); if (b && b.team !== u.team) hits.push(b);
          }
        }
        break;
      } else { if (d === 2) break; continue; }
    }
  }
  game.events.push({ type: 'fx', cls: 'spear', team: u.team, x: u.x, y: u.y, dx, dy });
  if (hits.length === 0) log(game, '贯穿突刺没有命中目标');
  else {
    log(game, '贯穿突刺命中' + hits.length + '名敌军');
    for (const t of hits) { const prev = t.alive; dealDamage(game, t, 1); if (prev && !t.alive) handleKillScore(game, u.team); }
  }
  return finishAction(game, u, 'attack');
}

function finishAction(game, u, actionType, opts) {
  u.hasActed = true;
  game.moveOrigin = null;
  if (actionType === 'wait' && u.hp === 4 && !(opts && opts.forceEnded)) {
    u.isVigilant = true;
    log(game, CLASS_DEFS[u.cls].fullName + '进入凝神戒备。');
  } else {
    u.isVigilant = false;
  }

  for (const enemy of game.units) {
    if (enemy.alive && enemy.team !== u.team && enemy.isVigilant && enemy.hp === 4) {
      const targets = getAttackTargets(game, enemy);
      if (targets.includes(u)) {
        log(game, CLASS_DEFS[enemy.cls].fullName + '触发戒备反击！');
        const prevAlive = u.alive;
        dealDamage(game, u, 1);
        if (enemy.cls === 'runesmith' && u.alive) tryKnockback(game, enemy, u);
        if (prevAlive && !u.alive) handleKillScore(game, enemy.team);
        enemy.isVigilant = false;
      }
    }
  }

  checkGameOver(game);
  if (game.gameOver) return { needsTurnEnd: false, gameOver: true };
  return { needsTurnEnd: true };
}

function settleScoreAndHeal(game, team) {
  let scoreGained = 0;
  for (const s of game.shrines) {
    if (s.owner === team) {
      if (s.isHigh) {
        const remain = HIGH_SHRINE_CAP - game.highShrinePool;
        if (remain > 0) {
          const gain = Math.min(2, remain);
          game.highShrinePool += gain;
          scoreGained += gain;
        }
      } else {
        scoreGained += 1;
      }
    }
  }
  if (scoreGained > 0) game.score[team] += scoreGained;

  for (const spring of game.springs) {
    if (springUsableBy(spring, team)) {
      const u = unitAt(game, spring.x, spring.y);
      if (u && u.team === team && u.hp < 4) {
        u.hp++;
        game.events.push({ type: 'popup', x: u.x, y: u.y, text: '+1', color: '#10b981' });
        game.events.push({ type: 'fx', cls: 'priest', team: team, x: u.x, y: u.y });
        spring.uses--;
      }
    }
  }
}

function closeHighShrine(game) {
  if (game.highShrineClosed) return;
  const hs = game.shrines.find(s => s.isHigh);
  if (!hs) { game.highShrineClosed = true; return; }
  game.highShrineClosed = true;
  game.shrines = game.shrines.filter(s => !s.isHigh);
  log(game, '⭐ 高级圣坛星辉耗尽，坍缩为普通空地！');
  game.events.push({ type: 'sound', name: 'collapse' });
}

function switchTurn(game) {
  if (game.gameOver) return;
  const curIdx = TEAMS.indexOf(game.phase);
  game.phase = TEAMS[(curIdx + 1) % 3];
  game.moveOrigin = null;

  game.units.forEach(u => { u.hasActed = false; });
  game.units.forEach(u => {
    if (u.team === game.phase) {
      u.hasMovedThisRound = false;
      u.shieldUsedThisRound = false;
    }
  });

  let clearedCount = 0;
  game.units.forEach(u => {
    if (u.alive && u.isCrippled === game.phase) { u.isCrippled = null; clearedCount++; }
  });
  if (clearedCount > 0) log(game, `【回归】${clearedCount} 名英雄恢复行动能力。`);

  settleScoreAndHeal(game, game.phase);

  game.turnInRound++;
  if (game.turnInRound >= 3) {
    game.turnInRound = 0;
    if (!game.highShrineClosed && game.highShrinePool >= HIGH_SHRINE_CAP) closeHighShrine(game);
  }

  if (game.phase === 'A') {
    game.round++;
    log(game, `—— 大回合 ${game.round} 开始 ——`);
  }

  checkGameOver(game);
}

function checkGameOver(game) {
  if (game.gameOver) return;

  const winnerByScore = TEAMS.find(t => game.score[t] >= 150);
  if (winnerByScore) {
    game.gameOver = true; game.winner = winnerByScore;
    log(game, `${winnerByScore} 方率先达到 150 分，获得胜利！`);
    game.events.push({ type: 'sound', name: 'win' });
    return;
  }

  const aliveTeams = TEAMS.filter(t => game.units.some(u => u.alive && u.team === t));
  if (aliveTeams.length === 1) {
    game.gameOver = true; game.winner = aliveTeams[0];
    log(game, `${aliveTeams[0]} 方是最后的幸存者，获得胜利！`);
    game.events.push({ type: 'sound', name: 'win' });
    return;
  }
  if (aliveTeams.length === 0) {
    game.gameOver = true; game.winner = null;
    log(game, `三方全部覆灭，平局！`);
  }
}

// 开局
function createGame(room) {
  const humanTeams = TEAMS.filter(t => room.slots[t].type === 'human');
  const startTeam = humanTeams.length > 0
    ? humanTeams[Math.floor(Math.random() * humanTeams.length)]
    : 'A';

  const game = {
    units: [], shrines: [], springs: [], obstacles: new Set(), forests: new Set(), rifts: [],
    phase: startTeam, round: 1,
    score: { A: 0, B: 0, C: 0 },
    log: [], events: [],
    gameOver: false, winner: null,
    moveOrigin: null,
    highShrinePool: 0, highShrineClosed: false, turnInRound: 0,
    aiConsecutive: { A: { id: null, count: 0 }, B: { id: null, count: 0 }, C: { id: null, count: 0 } },
    aiFocusId: null
  };

  generateMap(game);
  createUnits(game);
  const teamNames = { A: '蓝方', B: '红方', C: '绿方' };
  log(game, `三分秘境开启！${teamNames[startTeam]}(${startTeam}) 先手。`);
  settleScoreAndHeal(game, startTeam);

  return game;
}

// 行动分发
function runAction(game, team, action) {
  if (game.gameOver) return { error: '游戏已结束' };
  if (game.phase !== team) return { error: '还未轮到你' };
  const t = action.type;

  if (t === 'cancel_move') {
    const u = game.units.find(x => x.id === action.unitId && x.alive && x.team === team);
    if (!u) return { error: '单位不存在' };
    if (!u.hasMovedThisRound) return { error: '未移动' };
    if (!game.moveOrigin || game.moveOrigin.unitId !== u.id) return { error: '无可撤销的移动' };
    u.x = game.moveOrigin.x;
    u.y = game.moveOrigin.y;
    u.hasMovedThisRound = false;
    game.moveOrigin = null;
    return { needsTurnEnd: false };
  }

  const getU = (id) => game.units.find(x => x.id === id && x.alive && x.team === team);

  if (t === 'move') {
    const u = getU(action.unitId);
    if (!u) return { error: '单位不存在' };
    if (u.hasActed) return { error: '单位已行动' };
    if (u.hasMovedThisRound) return { error: '本回合已移动' };
    if (u.isCrippled) return { error: '被致残，无法移动' };
    const reach = getReachable(game, u);
    if (!reach.has(key(action.x, action.y))) return { error: '不可达' };
    return doMove(game, u, action.x, action.y);
  }

  if (t === 'attack') {
    const a = getU(action.unitId);
    if (!a) return { error: '单位不存在' };
    if (a.hasActed) return { error: '单位已行动' };
    const d = game.units.find(x => x.id === action.targetId && x.alive);
    if (!d) return { error: '目标不存在' };
    if (!getAttackTargets(game, a).includes(d)) return { error: '不可攻击' };
    return doAttack(game, a, d);
  }

  if (t === 'wait') {
    const u = getU(action.unitId);
    if (!u) return { error: '单位不存在' };
    if (u.hasActed) return { error: '单位已行动' };
    return doWait(game, u);
  }

  if (t === 'heal') {
    const p = getU(action.unitId);
    if (!p) return { error: '单位不存在' };
    if (p.hasActed) return { error: '单位已行动' };
    if (p.cls !== 'priest') return { error: '非祭司' };
    if (p.hp < 3) return { error: '生命不足' };
    const t2 = game.units.find(x => x.id === action.targetId && x.alive && x.team === team);
    if (!t2) return { error: '目标不存在' };
    if (t2.hp >= 4) return { error: '目标满血' };
    if (Math.abs(t2.x - p.x) + Math.abs(t2.y - p.y) !== 1) return { error: '不相邻' };
    return doHeal(game, p, t2);
  }

  if (t === 'capture') {
    const u = getU(action.unitId);
    if (!u) return { error: '单位不存在' };
    if (u.hasActed) return { error: '单位已行动' };
    const s = game.shrines.find(x => x.x === action.x && x.y === action.y);
    if (!s) return { error: '无圣坛' };
    if (s.owner === u.team) return { error: '已是友方' };
    const same = u.x === s.x && u.y === s.y;
    const adjacent = Math.abs(u.x - s.x) + Math.abs(u.y - s.y) === 1;
    if (!same && !(u.cls === 'runesmith' && u.hp >= 3 && adjacent)) return { error: '无法占领' };
    return doCapture(game, u, s);
  }

  if (t === 'greatsword') {
    const u = getU(action.unitId);
    if (!u) return { error: '单位不存在' };
    if (u.hasActed) return { error: '单位已行动' };
    if (u.cls !== 'greatsword') return { error: '非巨剑' };
    return doGreatswordSpecial(game, u);
  }

  if (t === 'spear') {
    const u = getU(action.unitId);
    if (!u) return { error: '单位不存在' };
    if (u.hasActed) return { error: '单位已行动' };
    if (u.cls !== 'spear') return { error: '非龙枪' };
    if (u.hp < 3) return { error: '生命不足' };
    const dx = action.dx, dy = action.dy;
    if (!((dx === 0 && Math.abs(dy) === 1) || (dy === 0 && Math.abs(dx) === 1))) return { error: '方向无效' };
    return doSpearSpecial(game, u, dx, dy);
  }

  return { error: '未知动作' };
}/* ==================== AI ==================== */
function targetScore(game, t) {
  let s = 5 - t.hp;
  if (t.hp === 1) s += 50;
  if (t.cls === 'priest') s += 3;
  if (t.cls === 'archer') s += 2;
  if (t.cls === 'runesmith') s += 1;

  const maxOpp = Math.max(...TEAMS.filter(team => team !== t.team).map(team => game.score[team]));
  if (game.score[t.team] > 0 && game.score[t.team] >= maxOpp) s += 20;

  const sp = springAt(game, t.x, t.y);
  if (sp && sp.type === 'neutral' && sp.uses > 0 && t.hp > 1) {
    s -= 25 + sp.uses * 2;
  }
  return s;
}

function pickBest(game, ts) {
  return ts.slice().sort((a, b) => targetScore(game, b) - targetScore(game, a))[0];
}

// 移动评分：从单机版 aiActivate 后半段抽取
function evaluateBestMove(game, u, currentTeam) {
  const reach = getReachable(game, u);
  let bestMove = null, bestScore = -Infinity;
  const unownedShrines = game.shrines.filter(s => s.owner !== currentTeam);
  const ox = u.x, oy = u.y;

  let enemyCenterX = 0, enemyCenterY = 0, enemyCount = 0;
  game.units.filter(e => e.alive && e.team !== currentTeam).forEach(e => { enemyCenterX += e.x; enemyCenterY += e.y; enemyCount++; });
  if (enemyCount > 0) { enemyCenterX /= enemyCount; enemyCenterY /= enemyCount; }

  let teamCenterX = 0, teamCenterY = 0, teamCount = 0;
  game.units.filter(e => e.alive && e.team === u.team).forEach(e => { teamCenterX += e.x; teamCenterY += e.y; teamCount++; });
  if (teamCount > 0) { teamCenterX /= teamCount; teamCenterY /= teamCount; }

  let currentInDanger = false;
  for (const enemy of game.units) {
    if (enemy.alive && enemy.team !== u.team && getAttackTargets(game, enemy).includes(u)) { currentInDanger = true; break; }
  }

  for (const k of reach.keys()) {
    const [nx, ny] = k.split(',').map(Number);
    if (unitAt(game, nx, ny) || (nx === ox && ny === oy)) continue;

    u.x = nx; u.y = ny;
    let score = 0;

    if (inRift(game, nx, ny)) score -= 3000;

    const shAt = shrineAt(game, nx, ny);
    if (shAt && shAt.owner !== currentTeam) score += (shAt.isHigh ? 8000 : 1500);

    let isSafe = true;
    for (const enemy of game.units) {
      if (enemy.alive && enemy.team !== u.team && enemy.isVigilant && enemy.hp === 4) {
        if (getAttackTargets(game, enemy).includes(u)) { isSafe = false; break; }
      }
    }
    if (!isSafe) score -= 500;

    const t2 = getAttackTargets(game, u);
    if (t2.length > 0) score += targetScore(game, pickBest(game, t2)) * 30;
    else if (currentInDanger) {
      let newInDanger = false;
      for (const enemy of game.units) {
        if (enemy.alive && enemy.team !== u.team && getAttackTargets(game, enemy).includes(u)) { newInDanger = true; break; }
      }
      if (!newInDanger) score += 200;
    }

    const distToEnemy = Math.abs(nx - enemyCenterX) + Math.abs(ny - enemyCenterY);
    const distToTeam = Math.abs(nx - teamCenterX) + Math.abs(ny - teamCenterY);

    if (unownedShrines.length > 0) {
      let maxShrineScore = -Infinity;
      for (const s of unownedShrines) {
        const d = Math.abs(nx - s.x) + Math.abs(ny - s.y);
        const weight = s.isHigh ? 150 : 30;
        maxShrineScore = Math.max(maxShrineScore, (20 - d) * weight);
      }
      score += maxShrineScore;
    } else {
      score += (15 - distToEnemy) * 10;
      if (distToTeam > 4) score -= 50;
    }

    const sp = springAt(game, nx, ny);
    if (sp && sp.type === 'neutral' && sp.uses > 0) {
      score += (u.hp < 4) ? 1000 : 300;
    }

    if (u.hp <= 2) {
      let minDistToSpring = 999;
      game.springs.forEach(s => {
        if (s.type === 'neutral' && s.uses > 0) {
          const d = Math.abs(nx - s.x) + Math.abs(ny - s.y);
          if (d < minDistToSpring) minDistToSpring = d;
        }
      });
      if (minDistToSpring !== 999) score += (15 - minDistToSpring) * 50;
    }

    if (inForest(game, nx, ny)) score += 50;

    if (u.cls === 'archer' || u.cls === 'spear') {
      let currentlyAdjacentToEnemy = false;
      for (const enemy of game.units) {
        if (enemy.alive && enemy.team !== u.team && Math.abs(enemy.x - ox) + Math.abs(enemy.y - oy) === 1) {
          currentlyAdjacentToEnemy = true; break;
        }
      }
      if (currentlyAdjacentToEnemy) {
        let minDistToEnemyNew = 99;
        game.units.forEach(e => {
          if (e.alive && e.team !== u.team) {
            minDistToEnemyNew = Math.min(minDistToEnemyNew, Math.abs(nx - e.x) + Math.abs(ny - e.y));
          }
        });
        score += minDistToEnemyNew * 150;
      }
    }

    if (u.cls === 'archer' || u.cls === 'priest') {
      let inDanger = false;
      for (const enemy of game.units) {
        if (enemy.alive && enemy.team !== u.team && Math.abs(enemy.x - ox) + Math.abs(enemy.y - oy) <= 3) {
          inDanger = true; break;
        }
      }
      if (inDanger && inForest(game, nx, ny)) score += 800;
    }

    if (u.cls === 'priest' || u.cls === 'archer' || u.cls === 'runesmith') {
      if (distToEnemy <= 2) score -= 100;
      if (distToTeam <= 2) score += 50;
    }

    u.x = ox; u.y = oy;
    if (score > bestScore) { bestScore = score; bestMove = { x: nx, y: ny }; }
  }

  let baseScore = 0;
  const shHere = shrineAt(game, ox, oy);
  if (shHere && shHere.owner !== currentTeam) baseScore += (shHere.isHigh ? 4000 : 1000);
  const atkHere = getAttackTargets(game, u);
  if (atkHere.length > 0) baseScore += targetScore(game, pickBest(game, atkHere)) * 30;
  if (currentInDanger) baseScore -= 100;
  const highShrineUnowned = game.shrines.find(s => s.isHigh && s.owner !== currentTeam);
  if (highShrineUnowned) baseScore -= 800;

  let shouldMove = false;
  if (bestMove) {
    u.x = bestMove.x; u.y = bestMove.y;
    const canAttackAfter = getAttackTargets(game, u).length > 0;
    const shAt2 = shrineAt(game, u.x, u.y);
    const isShrineAfter = shAt2 && shAt2.owner !== currentTeam;
    u.x = ox; u.y = oy;

    if (canAttackAfter || isShrineAfter) shouldMove = true;
    else if (currentInDanger) shouldMove = true;
    else if (bestScore > baseScore + 40) shouldMove = true;
  }

  return { bestMove, shouldMove };
}

// 移动后的追加动作：占点 > 攻击 > 待机
function aiAfterMove(game, u, currentTeam) {
  const sh = shrineAt(game, u.x, u.y);
  if (sh && sh.owner !== currentTeam) return doCapture(game, u, sh);
  const targets = getAttackTargets(game, u);
  if (targets.length > 0) return doAttack(game, u, pickBest(game, targets));
  return doWait(game, u);
}

// 单个 AI 单位的完整决策
function aiActivate(game, u, currentTeam) {
  if (!u.alive || u.hasActed) return { needsTurnEnd: true };

  // 1. 原地占点
  const sh = shrineAt(game, u.x, u.y);
  if (sh && sh.owner !== currentTeam) return doCapture(game, u, sh);

  // 2. 符文相邻占点
  if (u.cls === 'runesmith' && u.hp >= 3) {
    const adj = game.shrines.find(s => s.owner !== currentTeam && Math.abs(s.x - u.x) + Math.abs(s.y - u.y) === 1);
    if (adj) return doCapture(game, u, adj);
  }

  // 3. 攻击（含特殊技能）
  const targets = getAttackTargets(game, u);
  if (targets.length > 0) {
    let shouldAttack = false, bestTarget = null;

    if (u.cls === 'shadow') {
      const priority = targets.filter(t => t.cls === 'priest' || t.cls === 'archer' || t.isVigilant);
      bestTarget = priority.length > 0 ? pickBest(game, priority) : pickBest(game, targets);
      shouldAttack = true;
    } else {
      bestTarget = pickBest(game, targets);
      const maxOpp = Math.max(...TEAMS.filter(t => t !== currentTeam).map(t => game.score[t]));
      if (game.score[bestTarget.team] >= maxOpp) shouldAttack = true;
      if (bestTarget.hp === 1) shouldAttack = true;

      if (!shouldAttack) {
        const reach = getReachable(game, u);
        const reachableShrines = game.shrines.filter(s => s.owner !== currentTeam && reach.has(key(s.x, s.y)));
        if (reachableShrines.length === 0) shouldAttack = true;
      }
    }

    if (shouldAttack) {
      if (u.cls === 'greatsword' && u.hp >= 3) {
        const around = game.units.filter(e => e.alive && e.team !== u.team && Math.abs(e.x - u.x) <= 1 && Math.abs(e.y - u.y) <= 1);
        if (around.length >= 2) return doGreatswordSpecial(game, u);
      }

      if (u.cls === 'spear' && u.hp >= 3) {
        const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
        for (const [dx, dy] of dirs) {
          let hitCount = 0, hasLowHp = false;
          for (let d = 1; d <= 2; d++) {
            const tx = u.x + dx * d, ty = u.y + dy * d;
            if (!inBounds(tx, ty) || isObstacle(game, tx, ty)) break;
            const t = unitAt(game, tx, ty);
            if (t) {
              if (t.team !== u.team) {
                hitCount++; if (t.hp === 1) hasLowHp = true;
                if (d === 1) {
                  const bx = tx + dx, by = ty + dy;
                  if (inBounds(bx, by) && !isObstacle(game, bx, by)) {
                    const b = unitAt(game, bx, by);
                    if (b && b.team !== u.team) { hitCount++; if (b.hp === 1) hasLowHp = true; }
                  }
                }
                break;
              } else { if (d === 2) break; continue; }
            }
          }
          if (hitCount >= 2 || hasLowHp) return doSpearSpecial(game, u, dx, dy);
        }
      }

      return doAttack(game, u, bestTarget);
    }
  }

  // 4. 治疗
  if (u.cls === 'priest' && u.hp >= 3) {
    const allies = game.units.filter(a => a.alive && a.team === u.team && a !== u && a.hp < 4 && Math.abs(a.x - u.x) + Math.abs(a.y - u.y) === 1);
    if (allies.length > 0) { allies.sort((a, b) => a.hp - b.hp); return doHeal(game, u, allies[0]); }
  }

  // 5. 移动
  const { bestMove, shouldMove } = evaluateBestMove(game, u, currentTeam);
  if (bestMove && shouldMove) {
    const moveRes = doMove(game, u, bestMove.x, bestMove.y);
    if (moveRes.error) return doWait(game, u);
    if (moveRes.needsTurnEnd) return moveRes;   // 裂隙传送
    return aiAfterMove(game, u, currentTeam);   // 服务端一次性串完
  }

  return doWait(game, u);
}

// 选一个 AI 单位行动（从原 aiTurn 的排序逻辑抽取）
function pickAIActor(game, currentTeam) {
  const alive = game.units.filter(u => u.alive && u.team === currentTeam && !u.hasActed);
  if (alive.length === 0) return null;

  const unownedShrines = game.shrines.filter(s => s.owner !== currentTeam);

  alive.sort((a, b) => {
    let scoreA = 0, scoreB = 0;
    const last = game.aiConsecutive[currentTeam];

    let threatPos = null;
    for (const ally of game.units) {
      if (ally.alive && ally.team === currentTeam && (ally.cls === 'priest' || ally.cls === 'archer')) {
        for (const enemy of game.units) {
          if (enemy.alive && enemy.team !== currentTeam && Math.abs(enemy.x - ally.x) + Math.abs(enemy.y - ally.y) <= 3) {
            threatPos = { x: enemy.x, y: enemy.y };
            break;
          }
        }
      }
      if (threatPos) break;
    }

    if (threatPos) {
      if (['shield', 'greatsword', 'spear', 'shadow'].includes(a.cls)) scoreA += (15 - (Math.abs(a.x - threatPos.x) + Math.abs(a.y - threatPos.y))) * 200;
      if (['shield', 'greatsword', 'spear', 'shadow'].includes(b.cls)) scoreB += (15 - (Math.abs(b.x - threatPos.x) + Math.abs(b.y - threatPos.y))) * 200;
    }

    if (last.id === a.id) scoreA += (last.count >= 3) ? -5000 : 500;
    if (last.id === b.id) scoreB += (last.count >= 3) ? -5000 : 500;

    if (a.hp === 1) scoreA -= 3000;
    if (b.hp === 1) scoreB -= 3000;
    if (a.isCrippled) scoreA -= 2000;
    if (b.isCrippled) scoreB -= 2000;
    if (a.isVigilant) scoreA -= 500;
    if (b.isVigilant) scoreB -= 500;

    const shA = shrineAt(game, a.x, a.y);
    if (shA && shA.owner !== currentTeam) scoreA += (shA.isHigh ? 4000 : 2000);
    const shB = shrineAt(game, b.x, b.y);
    if (shB && shB.owner !== currentTeam) scoreB += (shB.isHigh ? 4000 : 2000);

    if (getAttackTargets(game, a).length > 0) scoreA += 1500;
    if (getAttackTargets(game, b).length > 0) scoreB += 1500;

    let distA = 999, distB = 999;
    if (!a.isCrippled && a.hp > 1) {
      unownedShrines.forEach(s => { distA = Math.min(distA, (Math.abs(a.x - s.x) + Math.abs(a.y - s.y)) * (s.isHigh ? 100 : 30)); });
      scoreA += (3000 - distA);
    }
    if (!b.isCrippled && b.hp > 1) {
      unownedShrines.forEach(s => { distB = Math.min(distB, (Math.abs(b.x - s.x) + Math.abs(b.y - s.y)) * (s.isHigh ? 100 : 30)); });
      scoreB += (3000 - distB);
    }

    return scoreB - scoreA;
  });

  return alive[0];
}

/* ==================== 启动入口 ==================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`星辉秘境 · 三分天下 联机版运行在端口 ${PORT}`);
  console.log(`本地打开 http://localhost:${PORT}`);
});