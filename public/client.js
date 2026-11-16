'use strict';

/* ==================== 常量 ==================== */
const COLS = 25, ROWS = 14, VIEW = 7;
const VIEW_RADIUS = 3;
const DIRS = [[0,-1],[0,1],[-1,0],[1,0]];
const TEAMS = ['A', 'B', 'C'];

const TEAM_COLORS = { A: '#2563eb', B: '#ef4444', C: '#22c55e' };
const TEAM_COLOR_PALETTE = {
  A: { main: '#2563eb', light: '#60a5fa', glow: '#bfdbfe' },
  B: { main: '#ef4444', light: '#fca5a5', glow: '#fecaca' },
  C: { main: '#22c55e', light: '#86efac', glow: '#bbf7d0' }
};
const CLASS_DEFS = {
  shield:    { shortName: '盾卫', fullName: '圣盾守卫', move: 2, icon: 'game-icons:checked-shield' },
  archer:    { shortName: '弓手', fullName: '秘林弓手', move: 2, icon: 'game-icons:bow-arrow' },
  greatsword:{ shortName: '巨剑', fullName: '巨剑战士', move: 3, icon: 'game-icons:crossed-swords' },
  shadow:    { shortName: '影刃', fullName: '影刃行者', move: 3, icon: 'game-icons:cloak-dagger' },
  spear:     { shortName: '龙枪', fullName: '龙枪守卫', move: 2, icon: 'game-icons:glaive' },
  runesmith: { shortName: '符文', fullName: '符文匠师', move: 3, icon: 'game-icons:rune-stone' },
  priest:    { shortName: '祭司', fullName: '生命祭司', move: 2, icon: 'game-icons:heart-plus' }
};

/* ==================== 客户端状态 ==================== */
let socket = null;

const local = {
  seq: 0, you: null, phase: null, round: 1,
  score: { A: 0, B: 0, C: 0 },
  units: [], shrines: [], springs: [], obstacles: new Set(), forests: new Set(), rifts: [],
  log: [], actingUnitId: null, turnLocked: false, gameOver: false, winner: null,
  highShrinePool: 0, highShrineClosed: false, turnInRound: 0
};

const ui = {
  selectedId: null, mode: 'normal', moveOrigin: null,
  ctrlDown: false, soundOn: true, intentPending: false,
  rosterKey: null, locked: false
};

const lobby = {
  code: null, token: null, team: null, isHost: false, slots: {}, status: 'idle'
};

// 布局缓存：避免每帧 getComputedStyle
const layoutCache = { cell: 30, gap: 2, step: 32 };

/* ==================== 工具 ==================== */
const key = (x, y) => x + ',' + y;
const inBounds = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS;
const unitAt = (x, y) => local.units.find(u => u.alive && u.x === x && u.y === y);
const shrineAt = (x, y) => local.shrines.find(s => s.x === x && s.y === y);
const springAt = (x, y) => local.springs.find(s => s.x === x && s.y === y);
const isObstacle = (x, y) => local.obstacles.has(key(x, y));
const inForest = (x, y) => local.forests.has(key(x, y));
const inRift = (x, y) => local.rifts.some(r => r.x === x && r.y === y);
const getSelected = () => local.units.find(u => u.id === ui.selectedId && u.alive);
const isMyTurn = () => local.you && local.phase === local.you && !local.gameOver && !local.turnLocked && !ui.intentPending && !ui.locked;

// 只在 class 状态变化时动 DOM
function toggleClass(el, cls, on) {
  const has = el.classList.contains(cls);
  if (on && !has) el.classList.add(cls);
  else if (!on && has) el.classList.remove(cls);
}

function getMove(u) {
  if (u.isCrippled) return 0;
  if (u.hp <= 1) return 1;
  let m = CLASS_DEFS[u.cls].move;
  if (u.hp === 2) m = Math.max(1, m - 1);
  return m;
}

function isEnemyZoc(x, y, team) {
  return local.units.some(u => u.alive && u.team !== team && Math.abs(u.x - x) + Math.abs(u.y - y) === 1);
}

function getReachable(unit) {
  const reach = new Map();
  reach.set(key(unit.x, unit.y), true);
  const visited = new Set([key(unit.x, unit.y)]);
  if (unit.isCrippled) return reach;

  const ignoreZoc = unit.cls === 'shadow' && unit.hp >= 3;
  const startInZoc = !ignoreZoc && isEnemyZoc(unit.x, unit.y, unit.team);
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
        if (visited.has(k) || isObstacle(nx, ny)) continue;
        if (unitAt(nx, ny)) continue;
        visited.add(k); reach.set(k, true);
        const inZoc = !ignoreZoc && isEnemyZoc(nx, ny, unit.team);
        if (!inZoc) next.push([nx, ny, step + 1]);
      }
    }
    frontier = next;
  }
  return reach;
}

function getAttackTargets(unit) {
  const res = [];
  if (unit.hp <= 1) return res;
  for (const e of local.units) {
    if (!e.alive || e.team === unit.team) continue;
    if (inForest(e.x, e.y)) {
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
          const midUnit = unitAt(mx, my);
          if (!isObstacle(mx, my) && (!midUnit || midUnit.team === unit.team)) res.push(e);
        }
      }
    } else {
      if (dist === 1) res.push(e);
    }
  }
  return res;
}

/* ==================== 音效 ==================== */
let audioCtx = null;
let masterGain = null;
let compressor = null;
function initAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -20;
      compressor.knee.value = 14;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.55;
      compressor.connect(masterGain);
      masterGain.connect(audioCtx.destination);
    } catch (e) { audioCtx = null; }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function playTone(freq, duration, type, volume, when, endFreq = null) {
  if (!ui.soundOn || !audioCtx || !compressor) return;
  try {
    const t0 = audioCtx.currentTime + (when || 0);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + duration);
    const vol = Math.max(0.001, (volume || 0.08) * 1.0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(compressor);
    osc.start(t0);
    osc.stop(t0 + duration + 0.1);
  } catch (e) {}
}
const SFX = {
  click() { playTone(620, 0.05, 'triangle', 0.03); },
  hit() { playTone(160, 0.14, 'sawtooth', 0.06); playTone(80, 0.18, 'sine', 0.08, 0.01); },
  death() { playTone(280, 0.35, 'sawtooth', 0.10); playTone(140, 0.45, 'sine', 0.11, 0.05); playTone(70, 0.55, 'sine', 0.10, 0.10); },
  capture() { playTone(392, 0.12, 'sine', 0.08); playTone(523, 0.12, 'sine', 0.08, 0.10); playTone(659, 0.18, 'sine', 0.08, 0.20); },
  win() { [523,659,784,1047].forEach((f,i) => playTone(f, 0.18, 'sine', 0.09, i * 0.11)); },
  lose() { [523,440,349,262].forEach((f,i) => playTone(f, 0.22, 'sine', 0.09, i * 0.14)); },
  wait() { playTone(330, 0.10, 'triangle', 0.04); playTone(440, 0.15, 'sine', 0.04, 0.08); },
  knock() { playTone(300, 0.08, 'square', 0.06); playTone(500, 0.10, 'sine', 0.05, 0.05); },
  collapse() { playTone(440, 0.10, 'sine', 0.08); playTone(330, 0.14, 'sine', 0.08, 0.10); playTone(220, 0.22, 'sawtooth', 0.09, 0.22); playTone(110, 0.30, 'sine', 0.10, 0.28); },
  move(cls) {
    let freq = 440, type = 'sine';
    if (cls === 'shield' || cls === 'greatsword') { freq = 220; type = 'triangle'; }
    else if (cls === 'shadow' || cls === 'archer') { freq = 660; type = 'sine'; }
    else if (cls === 'priest' || cls === 'runesmith') { freq = 520; type = 'triangle'; }
    else if (cls === 'spear') { freq = 350; type = 'sawtooth'; }
    playTone(freq, 0.06, type, 0.03);
  },
  fx_shield: () => { playTone(300, 0.3, 'triangle', 0.05); playTone(150, 0.4, 'sine', 0.07, 0.1, 100); },
  fx_archer: () => { playTone(1200, 0.1, 'sine', 0.05, 0, 600); playTone(800, 0.05, 'triangle', 0.03, 0.05); },
  fx_greatsword: () => { playTone(100, 0.4, 'sawtooth', 0.06); playTone(200, 0.2, 'triangle', 0.04, 0.02, 50); },
  fx_shadow: () => { playTone(2000, 0.08, 'sawtooth', 0.04); playTone(400, 0.2, 'triangle', 0.06, 0.05, 100); },
  fx_spear: () => { playTone(150, 0.3, 'sawtooth', 0.05, 0, 600); playTone(800, 0.4, 'sine', 0.06, 0.1, 300); },
  fx_runesmith: () => { playTone(1046, 0.15, 'sine', 0.05); playTone(1318, 0.15, 'sine', 0.05, 0.05); playTone(1568, 0.3, 'triangle', 0.05, 0.1); },
  fx_priest: () => { playTone(523, 0.3, 'sine', 0.05); playTone(659, 0.3, 'sine', 0.05, 0.05); playTone(784, 0.4, 'sine', 0.05, 0.1); }
};

/* ==================== 粒子特效 ==================== */
const fxCanvas = document.createElement('canvas');
fxCanvas.id = 'fx-canvas';
const fxCtx = fxCanvas.getContext('2d');
let fxWidth = 0, fxHeight = 0;
const particles = [];
let fxRunning = false;
// 帧率上限：40fps（降低 CPU / GPU 负载）
const TARGET_FPS = 40;
const FRAME_MS = 1000 / TARGET_FPS;   // 25ms
const BASE_MS = 1000 / 60;            // 60fps 为物理基准
let fxAccum = 0;
let fxLastFrame = 0;

function getCellCenterPx(gx, gy) {
  const cell = layoutCache.cell, step = layoutCache.step;
  return { px: gx * step + cell / 2, py: gy * step + cell / 2 };
}

function spawnParticle(opt) {
  particles.push({
    x: opt.x, y: opt.y, vx: opt.vx || 0, vy: opt.vy || 0,
    life: 1, decay: opt.decay || 0.02, size: opt.size || 4, color: opt.color || '#fff',
    shape: opt.shape || 'circle', drag: opt.drag !== undefined ? opt.drag : 0.96,
    gravity: opt.gravity || 0, angle: opt.angle || 0, rotSpeed: opt.rotSpeed || 0,
    delay: opt.delay || 0
  });
  // 有粒子才启动 fxLoop，空闲彻底停机
  if (!fxRunning) {
    fxRunning = true;
    fxAccum = 0;
    fxLastFrame = performance.now();
    requestAnimationFrame(fxLoop);
  }
}

function fxLoop(now) {
  const elapsed = now - fxLastFrame;
  fxLastFrame = now;
  fxAccum += elapsed;

  // 累积不到 1 帧间隔（25ms），跳过绘制，只维持 rAF 心跳
  if (fxAccum < FRAME_MS - 1) {
    requestAnimationFrame(fxLoop);
    return;
  }

  const step = fxAccum;
  fxAccum = 0;

  fxCtx.clearRect(0, 0, fxWidth, fxHeight);
  if (particles.length === 0) {
    fxRunning = false;
    return;
  }

  // 按实际经过时间缩放物理参数：40fps 下粒子速度/存活时长与 60fps 视觉一致
  const scale = Math.min(step / BASE_MS, 3);

  fxCtx.globalCompositeOperation = 'lighter';
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    if (p.delay > 0) { p.delay -= step; continue; }
    p.x += p.vx * scale;
    p.y += p.vy * scale;
    p.vx *= Math.pow(p.drag, scale);
    p.vy *= Math.pow(p.drag, scale);
    p.vy += p.gravity * scale;
    p.life -= p.decay * scale;
    p.angle += p.rotSpeed * scale;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    fxCtx.globalAlpha = Math.max(0, p.life);
    fxCtx.fillStyle = p.color;
    fxCtx.strokeStyle = p.color;
    const s = p.size * p.life;
    if (p.shape === 'circle') {
      fxCtx.beginPath(); fxCtx.arc(p.x, p.y, s, 0, Math.PI * 2); fxCtx.fill();
    } else if (p.shape === 'line') {
      fxCtx.lineWidth = s;
      fxCtx.beginPath(); fxCtx.moveTo(p.x, p.y);
      fxCtx.lineTo(p.x - Math.cos(p.angle) * 30 * p.life, p.y - Math.sin(p.angle) * 30 * p.life);
      fxCtx.stroke();
    } else if (p.shape === 'cross') {
      fxCtx.lineWidth = s / 2;
      fxCtx.beginPath();
      fxCtx.moveTo(p.x - s, p.y); fxCtx.lineTo(p.x + s, p.y);
      fxCtx.moveTo(p.x, p.y - s); fxCtx.lineTo(p.x, p.y + s);
      fxCtx.stroke();
    } else if (p.shape === 'diamond') {
      fxCtx.beginPath();
      fxCtx.moveTo(p.x, p.y - s); fxCtx.lineTo(p.x + s, p.y);
      fxCtx.lineTo(p.x, p.y + s); fxCtx.lineTo(p.x - s, p.y);
      fxCtx.closePath(); fxCtx.fill();
    }
  }
  fxCtx.globalCompositeOperation = 'source-over';
  fxCtx.globalAlpha = 1;
  requestAnimationFrame(fxLoop);
}

/* ---- FPS 统计（独立循环，每 2 秒刷新一次，避免数字乱跳） ---- */
let fpsFrames = 0, fpsLast = performance.now();
let fpsLastFrame = 0;
function fpsLoop(now) {
  const elapsed = now - fpsLastFrame;
  if (elapsed < FRAME_MS - 1) {
    requestAnimationFrame(fpsLoop);
    return;
  }
  fpsLastFrame = now;
  fpsFrames++;
  if (now - fpsLast >= 2000) {
    const fps = Math.round(fpsFrames * 1000 / (now - fpsLast));
    const el = document.getElementById('fpsVal');
    if (el) {
      el.textContent = fps;
      // 上限 40fps，30+ 算正常绿，25-30 黄，更低红
      el.className = fps >= 30 ? '' : fps >= 25 ? 'warn' : 'bad';
    }
    fpsFrames = 0;
    fpsLast = now;
  }
  requestAnimationFrame(fpsLoop);
}
requestAnimationFrame(fpsLoop);

function triggerFx(cls, team, gx, gy, dx = 0, dy = 0, tx = null, ty = null) {
  const colorSet = TEAM_COLOR_PALETTE[team] || TEAM_COLOR_PALETTE['A'];
  const startPos = getCellCenterPx(gx, gy);
  const cx = startPos.px, cy = startPos.py;
  if (SFX['fx_' + cls]) SFX['fx_' + cls]();

  if (cls === 'shield') {
    for (let i = 0; i < 20; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 80 + Math.random() * 40;
      spawnParticle({
        x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist,
        vx: -Math.cos(angle) * 4, vy: -Math.sin(angle) * 4,
        color: Math.random() > 0.2 ? colorSet.main : '#fbbf24',
        shape: 'diamond', size: 6, decay: 0.04, drag: 0.9
      });
    }
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2;
      spawnParticle({
        x: cx, y: cy, vx: Math.cos(angle) * 8, vy: Math.sin(angle) * 8,
        color: colorSet.light, shape: 'cross', size: 8, decay: 0.05, drag: 0.85, delay: 300
      });
    }
  } else if (cls === 'archer') {
    let angle = 0, txPx = cx, tyPx = cy;
    if (tx !== null && ty !== null) {
      const tPos = getCellCenterPx(tx, ty);
      txPx = tPos.px; tyPx = tPos.py;
      angle = Math.atan2(tyPx - cy, txPx - cx);
    }
    for (let i = 0; i < 5; i++) {
      spawnParticle({
        x: cx, y: cy,
        vx: Math.cos(angle) * (15 + Math.random() * 10), vy: Math.sin(angle) * (15 + Math.random() * 10),
        color: colorSet.glow, shape: 'line', size: 4, decay: 0.06, drag: 0.99, angle
      });
    }
    for (let i = 0; i < 20; i++) {
      spawnParticle({
        x: cx + (txPx - cx) * Math.random(), y: cy + (tyPx - cy) * Math.random(),
        vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 2,
        color: colorSet.main, shape: 'circle', size: 3, decay: 0.015, gravity: 0.1, delay: 100 + Math.random() * 200
      });
    }
  } else if (cls === 'greatsword') {
    for (let i = 0; i < 50; i++) {
      const angle = -Math.PI / 4 + Math.random() * (Math.PI * 1.5);
      const speed = 3 + Math.random() * 8;
      spawnParticle({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        color: Math.random() > 0.4 ? colorSet.main : colorSet.light,
        shape: 'circle', size: 10 + Math.random() * 10, decay: 0.04, drag: 0.85
      });
    }
    for (let i = 0; i < 20; i++) {
      spawnParticle({
        x: cx + (Math.random() - 0.5) * 60, y: cy + 20,
        vx: (Math.random() - 0.5) * 6, vy: -5 - Math.random() * 5,
        color: '#fcd34d', shape: 'diamond', size: 4, decay: 0.03, gravity: 0.4
      });
    }
  } else if (cls === 'shadow') {
    spawnParticle({ x: cx, y: cy, color: colorSet.glow, shape: 'line', size: 3, decay: 0.1, angle: Math.PI / 4 });
    spawnParticle({ x: cx, y: cy, color: colorSet.glow, shape: 'line', size: 3, decay: 0.1, angle: -Math.PI / 4 });
    for (let i = 0; i < 25; i++) {
      const angle = Math.random() * Math.PI * 2;
      spawnParticle({
        x: cx, y: cy,
        vx: Math.cos(angle) * (3 + Math.random() * 4), vy: Math.sin(angle) * (3 + Math.random() * 4),
        color: Math.random() > 0.5 ? colorSet.main : '#4c1d95',
        shape: 'diamond', size: 5, decay: 0.05, drag: 0.9, delay: 80
      });
    }
  } else if (cls === 'spear') {
    const angle = Math.atan2(dy, dx);
    for (let i = 0; i < 10; i++) {
      spawnParticle({
        x: cx, y: cy,
        vx: Math.cos(angle) * (20 + Math.random() * 10) + (Math.random() - 0.5) * 4,
        vy: Math.sin(angle) * (20 + Math.random() * 10) + (Math.random() - 0.5) * 4,
        color: colorSet.glow, shape: 'circle', size: 15, decay: 0.04, drag: 0.98
      });
    }
    for (let i = 0; i < 40; i++) {
      spawnParticle({
        x: cx - Math.cos(angle) * (Math.random() * 80), y: cy - Math.sin(angle) * (Math.random() * 80),
        vx: Math.cos(angle) * (15 + Math.random() * 10), vy: Math.sin(angle) * (15 + Math.random() * 10),
        color: colorSet.main, shape: 'line', size: 2, decay: 0.03, drag: 0.96, angle, delay: i * 10
      });
    }
  } else if (cls === 'runesmith') {
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      spawnParticle({
        x: cx + Math.cos(angle) * 100, y: cy + Math.sin(angle) * 100,
        vx: -Math.cos(angle) * 6, vy: -Math.sin(angle) * 6,
        color: colorSet.light, shape: 'line', size: 3, decay: 0.05, drag: 0.9, angle: angle + Math.PI / 2
      });
    }
    for (let i = 0; i < 36; i++) {
      const angle = (i / 36) * Math.PI * 2;
      spawnParticle({
        x: cx, y: cy, vx: Math.cos(angle) * 10, vy: Math.sin(angle) * 10,
        color: Math.random() > 0.3 ? colorSet.main : '#22d3ee',
        shape: 'diamond', size: 6, decay: 0.04, drag: 0.9, delay: 400
      });
    }
  } else if (cls === 'priest') {
    spawnParticle({ x: cx, y: cy, color: colorSet.light, shape: 'cross', size: 30, decay: 0.03 });
    spawnParticle({ x: cx, y: cy, color: '#ffffff', shape: 'cross', size: 15, decay: 0.04 });
    for (let i = 0; i < 30; i++) {
      spawnParticle({
        x: cx + (Math.random() - 0.5) * 120, y: cy + 20 + Math.random() * 40,
        vx: (Math.random() - 0.5) * 1, vy: -1 - Math.random() * 2,
        color: colorSet.glow, shape: 'circle', size: 4 + Math.random() * 4, decay: 0.01, drag: 0.99, gravity: -0.02,
        delay: i * 40
      });
    }
  } else if (cls === 'portal') {
    for (let i = 0; i < 40; i++) {
      const angle = Math.random() * Math.PI * 2;
      spawnParticle({
        x: cx, y: cy, vx: Math.cos(angle) * (4 + Math.random() * 8), vy: Math.sin(angle) * (4 + Math.random() * 8),
        color: '#a78bfa', shape: 'diamond', size: 7, decay: 0.03, drag: 0.92
      });
    }
  }
}

/* ==================== 棋盘渲染 ==================== */
let cellRefs = [];
const unitEls = new Map();
let rosterEls = new Map();

function buildBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  board.appendChild(fxCanvas);
  cellRefs = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.x = x; cell.dataset.y = y;
    const terrain = document.createElement('div'); terrain.className = 'terrain-icon';
    const unitWrap = document.createElement('div'); unitWrap.className = 'unit-wrap';
    cell.appendChild(terrain); cell.appendChild(unitWrap);
    board.appendChild(cell);
    cellRefs.push({ cell, terrain, unitWrap });
  }
}

// 增量更新地形：只改有变化的格
function updateTerrainVisuals() {
  cellRefs.forEach((ref, i) => {
    const x = i % COLS, y = Math.floor(i / COLS);
    const cell = ref.cell;

    const obs = isObstacle(x, y);
    const fore = !obs && inForest(x, y);
    const rift = !obs && inRift(x, y);
    const sh = shrineAt(x, y);
    const sp = springAt(x, y);

    toggleClass(cell, 'obstacle', obs);
    toggleClass(cell, 'forest', fore);
    toggleClass(cell, 'rift', rift);
    toggleClass(cell, 'shrine', !!sh);
    toggleClass(cell, 'high-shrine', !!(sh && sh.isHigh));
    toggleClass(cell, 'owner-A', !!(sh && sh.owner === 'A'));
    toggleClass(cell, 'owner-B', !!(sh && sh.owner === 'B'));
    toggleClass(cell, 'owner-C', !!(sh && sh.owner === 'C'));
    toggleClass(cell, 'neutral-spring', !!sp);
    toggleClass(cell, 'depleted', !!(sp && sp.uses <= 0));

    // 地形图标：签名比对，变了才重建 innerHTML
    let sig = '', html = '';
    if (sp) {
      sig = 'spring';
      html = '<iconify-icon icon="game-icons:holy-grail"></iconify-icon>';
    } else if (sh) {
      let color = sh.isHigh ? '#fbbf24' : '#f59e0b';
      if (sh.owner) color = TEAM_COLORS[sh.owner];
      sig = 'shrine:' + (sh.isHigh ? 'h' : 'n') + ':' + (sh.owner || '-');
      html = `<iconify-icon icon="${sh.isHigh ? 'game-icons:magic-swirl' : 'game-icons:obelisk'}" style="color:${color}"></iconify-icon>`;
    } else if (obs) {
      sig = 'stone';
      html = '<iconify-icon icon="game-icons:stone-pile" style="color:#94a3b8"></iconify-icon>';
    } else if (rift) {
      sig = 'rift';
      html = '<iconify-icon icon="game-icons:magic-portal"></iconify-icon>';
    } else if (fore) {
      sig = 'forest';
      html = '<iconify-icon icon="game-icons:forest"></iconify-icon>';
    }
    if (ref.terrain.dataset.sig !== sig) {
      ref.terrain.dataset.sig = sig;
      ref.terrain.innerHTML = html;
    }

    // 泉水剩余次数
    if (sp) {
      let usesEl = cell.querySelector('.spring-uses');
      if (!usesEl) {
        usesEl = document.createElement('div');
        usesEl.className = 'spring-uses';
        cell.appendChild(usesEl);
      }
      const txt = sp.uses > 0 ? String(sp.uses) : '';
      if (usesEl.textContent !== txt) usesEl.textContent = txt;
    } else {
      const usesEl = cell.querySelector('.spring-uses');
      if (usesEl) usesEl.remove();
    }
  });
}

function createUnitEl() {
  const el = document.createElement('div');
  el.className = 'unit';
  const top = document.createElement('div'); top.className = 'unit-top';
  const name = document.createElement('div'); name.className = 'unit-name';
  const dots = document.createElement('div'); dots.className = 'hp-dots';
  for (let i = 0; i < 4; i++) { const d = document.createElement('span'); d.className = 'dot'; dots.appendChild(d); }
  top.appendChild(name); top.appendChild(dots);
  const circle = document.createElement('div'); circle.className = 'unit-circle';
  const eye = document.createElement('div'); eye.className = 'vigilant-eye'; eye.innerHTML = '👁️';
  el.appendChild(top); el.appendChild(circle); el.appendChild(eye);
  el.addEventListener('animationend', e => { if (e.animationName === 'hitShake') el.classList.remove('hit-anim'); });
  return el;
}

// 增量更新单位元素
function updateUnitEl(el, u) {
  const def = CLASS_DEFS[u.cls];
  const teamColor = TEAM_COLORS[u.team];

  const newClass = 'unit team-' + u.team + ' hp' + u.hp + (u.hasActed ? ' acted' : '') + (u.isCrippled ? ' crippled' : '');
  if (el.className !== newClass) el.className = newClass;

  const nameEl = el.querySelector('.unit-name');
  if (nameEl.textContent !== def.fullName) nameEl.textContent = def.fullName;

  const dots = el.querySelectorAll('.hp-dots .dot');
  for (let i = 0; i < 4; i++) toggleClass(dots[i], 'filled', i < u.hp);

  const circle = el.querySelector('.unit-circle');
  const iconStr = def.icon + '_' + teamColor;
  if (circle.dataset.lastIcon !== iconStr) {
    circle.innerHTML = '<iconify-icon icon="' + def.icon + '" style="color:' + teamColor + '"></iconify-icon>';
    circle.dataset.lastIcon = iconStr;
  }

  const eye = el.querySelector('.vigilant-eye');
  const eyeDisplay = u.isVigilant ? 'block' : 'none';
  if (eye.style.display !== eyeDisplay) eye.style.display = eyeDisplay;
}

function renderUnits() {
  for (const [id, el] of unitEls) {
    const u = local.units.find(x => x.id === id);
    if (!u || !u.alive) { if (el.parentNode) el.parentNode.removeChild(el); unitEls.delete(id); }
  }
  for (const u of local.units) {
    if (!u.alive) continue;
    const idx = u.y * COLS + u.x;
    const ref = cellRefs[idx];
    if (!ref) continue;
    let el = unitEls.get(u.id);
    if (!el) { el = createUnitEl(); unitEls.set(u.id, el); }
    updateUnitEl(el, u);
    const wrap = ref.unitWrap;
    if (el.parentNode !== wrap) wrap.appendChild(el);
  }
}

function renderRoster() {
  const el = document.getElementById('roster');
  const myUnits = local.units.filter(u => u.team === local.you);
  if (ui.rosterKey !== local.you) {
    el.innerHTML = '';
    rosterEls.clear();
    myUnits.forEach(u => {
      const def = CLASS_DEFS[u.cls];
      const item = document.createElement('div');
      item.className = 'roster-item';
      item.dataset.uid = u.id;
      const iconWrap = document.createElement('div'); iconWrap.className = 'roster-icon';
      iconWrap.innerHTML = `<iconify-icon icon="${def.icon}" style="color:${TEAM_COLORS[u.team]}"></iconify-icon>`;
      const nameEl = document.createElement('div'); nameEl.className = 'roster-name'; nameEl.textContent = def.shortName;
      const hpEl = document.createElement('div'); hpEl.className = 'roster-hp';
      const dots = [];
      for (let i = 0; i < 4; i++) { const d = document.createElement('span'); d.className = 'dot'; hpEl.appendChild(d); dots.push(d); }
      item.appendChild(iconWrap); item.appendChild(nameEl); item.appendChild(hpEl);
      el.appendChild(item);
      rosterEls.set(u.id, { item, dots });
    });
    ui.rosterKey = local.you;
  }
  myUnits.forEach(u => {
    const ref = rosterEls.get(u.id);
    if (!ref) return;
    const newClass = 'roster-item' +
      (ui.selectedId === u.id ? ' selected' : '') +
      (u.hasActed ? ' acted' : '') +
      (!u.alive ? ' dead' : '') +
      ' hp' + u.hp +
      (u.isCrippled ? ' crippled' : '');
    if (ref.item.className !== newClass) ref.item.className = newClass;
    for (let i = 0; i < 4; i++) toggleClass(ref.dots[i], 'filled', i < u.hp);
  });
}

function layoutBoard() {
  const wrap = document.getElementById('boardWrap');
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const gap = 2, padding = 8;
  const availW = rect.width - padding;
  const availH = rect.height - padding;
  if (availW <= 0 || availH <= 0) return;
  const cellW = (availW - gap * (VIEW - 1)) / VIEW;
  const cellH = (availH - gap * (VIEW - 1)) / VIEW;
  const cell = Math.max(18, Math.floor(Math.min(cellW, cellH)));
  document.documentElement.style.setProperty('--cell', cell + 'px');
  document.documentElement.style.setProperty('--gap', gap + 'px');
  const viewport = document.getElementById('boardViewport');
  const chrome = 6 * 2 + 2 * 2;
  viewport.style.width = (VIEW * cell + (VIEW - 1) * gap + chrome) + 'px';
  viewport.style.height = (VIEW * cell + (VIEW - 1) * gap + chrome) + 'px';
  fxCanvas.width = COLS * cell + (COLS - 1) * gap;
  fxCanvas.height = ROWS * cell + (ROWS - 1) * gap;
  fxCanvas.style.width = fxCanvas.width + 'px';
  fxCanvas.style.height = fxCanvas.height + 'px';
  fxWidth = fxCanvas.width;
  fxHeight = fxCanvas.height;

  // 同步缓存，避免后续每帧 getComputedStyle
  layoutCache.cell = cell;
  layoutCache.gap = gap;
  layoutCache.step = cell + gap;

  updateViewport();
}

function updateViewport() {
  const board = document.getElementById('board');
  if (!board) return;
  const cell = layoutCache.cell, gap = layoutCache.gap;
  let focus = null;

  if (local.phase === local.you) {
    focus = getSelected();
  } else {
    if (local.actingUnitId) {
      focus = local.units.find(u => u.id === local.actingUnitId && u.alive);
    }
    // 兜底：切回合瞬间 actingUnitId 还没到，取该阵营最近行动过的单位，避免镜头卡住
    if (!focus) {
      const teamUnits = local.units.filter(u => u.alive && u.team === local.phase);
      if (teamUnits.length) focus = teamUnits.find(u => u.hasActed) || teamUnits[0];
    }
  }
  if (!focus) return;
  const left = Math.max(0, Math.min(COLS - VIEW, focus.x - 3));
  const top = Math.max(0, Math.min(ROWS - VIEW, focus.y - 3));
  const step = cell + gap;
  const newTransform = 'translate(' + (-left * step) + 'px, ' + (-top * step) + 'px)';
  if (board.style.transform !== newTransform) board.style.transform = newTransform;
}

function flushPopups(events) {
  for (const p of events) {
    if (p.type !== 'popup') continue;
    const ref = cellRefs[p.y * COLS + p.x];
    if (!ref) continue;
    const el = document.createElement('div');
    el.className = 'dmg-popup'; el.textContent = p.text; el.style.color = p.color;
    ref.cell.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 820);
  }
}

function consumeEvents(events) {
  if (!Array.isArray(events)) return;
  for (const e of events) {
    if (e.type === 'sound') {
      if (e.name === 'move' && e.cls) SFX.move(e.cls);
      else if (SFX[e.name]) SFX[e.name]();
    } else if (e.type === 'fx') {
      triggerFx(e.cls, e.team, e.x, e.y, e.dx || 0, e.dy || 0, e.tx, e.ty);
    } else if (e.type === 'hit') {
      const el = unitEls.get(e.unitId);
      if (el) { el.classList.remove('hit-anim'); void el.offsetWidth; el.classList.add('hit-anim'); }
    }
  }
  flushPopups(events);
}

/* ---- render 用 rAF 合并，避免短时间多次触发 ---- */
let renderScheduled = false;
function render() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(doRender);
}

function doRender() {
  renderScheduled = false;
  if (!local.phase) return;
  if (cellRefs.length !== COLS * ROWS) {
    buildBoard();
    layoutBoard();
  }

  // autoSelectA：我的回合且无选中且不处于观察锁/切回合锁时，自动选第一个待行动单位
  if (local.phase === local.you && !getSelected() && !local.turnLocked && !ui.locked) {
    autoSelectA();
  }

  if (ui.selectedId) {
    const sel = local.units.find(u => u.id === ui.selectedId);
    if (!sel || !sel.alive) { ui.selectedId = null; ui.mode = 'normal'; ui.moveOrigin = null; }
  }

  const sel = getSelected();
  const myTurn = isMyTurn();
  let reach = null, attackTargets = [], healTargets = [], captureShrines = [];

  if (sel && myTurn && !sel.hasActed) {
    if (!sel.hasMovedThisRound) reach = getReachable(sel);
    if (sel.hp >= 2) attackTargets = getAttackTargets(sel);
    if (sel.hp >= 3 && sel.cls === 'priest') {
      healTargets = local.units.filter(a => a.alive && a.team === sel.team && a !== sel && a.hp < 4 && Math.abs(a.x - sel.x) + Math.abs(a.y - sel.y) === 1);
    }
    const sh = shrineAt(sel.x, sel.y);
    if (sh && sh.owner !== sel.team) captureShrines.push(sh);
    if (sel.cls === 'runesmith' && sel.hp >= 3) {
      const adj = local.shrines.find(s => s.owner !== sel.team && Math.abs(s.x - sel.x) + Math.abs(s.y - sel.y) === 1);
      if (adj) captureShrines.push(adj);
    }
  }

  updateTerrainVisuals();

  const DYNAMIC = ['selected', 'casting', 'move-hint', 'attack-hint', 'heal-hint', 'capture-hint'];
  cellRefs.forEach((ref, i) => {
    const x = i % COLS, y = Math.floor(i / COLS);
    const k = key(x, y);
    const cell = ref.cell;
    DYNAMIC.forEach(c => cell.classList.remove(c));
    if (sel && sel.x === x && sel.y === y) {
      cell.classList.add('selected');
      if (ui.mode === 'spearDir' || ui.mode === 'heal') cell.classList.add('casting');
    }
    if (reach && reach.has(k) && !unitAt(x, y)) cell.classList.add('move-hint');
    if (attackTargets.some(t => t.x === x && t.y === y)) cell.classList.add('attack-hint');
    if (healTargets.some(t => t.x === x && t.y === y)) cell.classList.add('heal-hint');
    if (captureShrines.some(s => s.x === x && s.y === y)) cell.classList.add('capture-hint');

    const oldArrow = cell.querySelector('.dir-arrow');
    if (oldArrow) oldArrow.remove();
    if (ui.mode === 'spearDir' && sel && sel.hp >= 3) {
      let arrowChar = '';
      if (x === sel.x && y === sel.y - 1) arrowChar = '↑';
      else if (x === sel.x && y === sel.y + 1) arrowChar = '↓';
      else if (x === sel.x - 1 && y === sel.y) arrowChar = '←';
      else if (x === sel.x + 1 && y === sel.y) arrowChar = '→';
      if (arrowChar) {
        const ae = document.createElement('div'); ae.className = 'dir-arrow'; ae.textContent = arrowChar;
        cell.appendChild(ae);
      }
    }
  });

  renderUnits();
  renderRoster();
  updateViewport();

  document.getElementById('scoreA').textContent = local.score.A;
  document.getElementById('scoreB').textContent = local.score.B;
  document.getElementById('scoreC').textContent = local.score.C;
  document.getElementById('roundNum').textContent = local.round;

  document.getElementById('labelA').childNodes[0].nodeValue = local.you === 'A' ? '你(A) ' : '敌(A) ';
  document.getElementById('labelB').childNodes[0].nodeValue = local.you === 'B' ? '你(B) ' : '敌(B) ';
  document.getElementById('labelC').childNodes[0].nodeValue = local.you === 'C' ? '你(C) ' : '敌(C) ';

  const ti = document.getElementById('turnInfo');
  ti.className = local.phase;
  ti.textContent = local.phase === local.you ? '你的回合' : `敌方 ${local.phase} 行动中…`;

  const logEl = document.getElementById('log');
  logEl.innerHTML = local.log.map(m => '<div>' + m + '</div>').join('');

  renderPanel(sel);

  // 小地图节流 800ms（原 200ms 太重）
  if (!window.lastMapDraw || Date.now() - window.lastMapDraw > 800) {
    drawMapToCanvas('minimap');
    if (document.getElementById('map-modal').classList.contains('show')) drawMapToCanvas('full-map-canvas');
    window.lastMapDraw = Date.now();
  }

  if (local.gameOver && !document.querySelector('.gameover')) showGameOver();
}

function drawMapToCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cw = canvas.width / COLS, ch = canvas.height / ROWS;
  ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (isObstacle(x, y)) ctx.fillStyle = '#94a3b8';
    else if (inForest(x, y)) ctx.fillStyle = '#86efac';
    else if (inRift(x, y)) ctx.fillStyle = '#d8b4fe';
    else ctx.fillStyle = '#e2e8f0';
    const gap = cw > 10 ? 2 : 1;
    ctx.fillRect(x * cw, y * ch, cw - gap, ch - gap);
    const sh = shrineAt(x, y);
    if (sh) {
      let color = sh.isHigh ? '#fbbf24' : '#f59e0b';
      if (sh.owner) color = TEAM_COLORS[sh.owner];
      ctx.fillStyle = color;
      ctx.fillRect(x * cw, y * ch, cw - gap, ch - gap);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = cw > 10 ? 2 : 1;
      ctx.strokeRect(x * cw + 1, y * ch + 1, cw - 3, ch - 3);
    }
    const sp = springAt(x, y);
    if (sp) {
      ctx.fillStyle = sp.uses <= 0 ? '#cbd5e1' : '#eab308';
      ctx.beginPath(); ctx.arc(x * cw + cw / 2, y * ch + ch / 2, Math.min(cw, ch) / 3, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function renderPanel(sel) {
  const info = document.getElementById('unitInfo');
  const actions = document.getElementById('actions');
  actions.innerHTML = '';
  const myTurn = isMyTurn();

  if (ui.mode === 'spearDir' && sel) {
    info.innerHTML = '<span style="color:#d97706; font-weight:bold;">已激活：贯穿突刺</span> · 请选择方向';
    const tag = document.createElement('div'); tag.className = 'active-skill-tag'; tag.textContent = '贯穿突刺 · 选方向中'; actions.appendChild(tag);
    const add = (l, dx, dy) => { const b = document.createElement('button'); b.textContent = l; b.className = 'primary'; b.onclick = () => { initAudio(); sendIntent({ type: 'spear', unitId: sel.id, dx, dy }); }; actions.appendChild(b); };
    add('↑ 上', 0, -1); add('↓ 下', 0, 1); add('← 左', -1, 0); add('→ 右', 1, 0);
    const c = document.createElement('button'); c.textContent = '取消'; c.className = 'danger'; c.onclick = () => { ui.mode = 'normal'; SFX.click(); render(); }; actions.appendChild(c);
    return;
  }

  if (ui.mode === 'heal' && sel) {
    info.innerHTML = '<span style="color:#65a30d; font-weight:bold;">已激活：生命祷言</span> · 请点击友军';
    const tag = document.createElement('div'); tag.className = 'active-skill-tag'; tag.style.borderColor = '#65a30d'; tag.style.color = '#65a30d'; tag.style.background = '#ecfccb'; tag.textContent = '生命祷言 · 选目标中'; actions.appendChild(tag);
    const c = document.createElement('button'); c.textContent = '取消'; c.className = 'danger'; c.onclick = () => { ui.mode = 'normal'; SFX.click(); render(); }; actions.appendChild(c);
    return;
  }

  if (!sel) {
    info.textContent = myTurn ? '选择一名英雄行动' : (local.gameOver ? '游戏结束' : `等待 ${local.phase} 方行动…`);
    return;
  }

  const def = CLASS_DEFS[sel.cls];
  const teamColor = TEAM_COLORS[sel.team];
  const st = sel.hp === 4 ? '健康' : sel.hp === 3 ? '轻伤' : sel.hp === 2 ? '中伤' : '重伤';
  const stColor = sel.hp === 4 ? '#10b981' : sel.hp === 3 ? '#eab308' : sel.hp === 2 ? '#f97316' : '#ef4444';
  let infoStr = `<b style="color:${teamColor}">${def.fullName}</b> · <span style="color:${stColor}">${st}</span> · HP ${sel.hp}/4 · 移动 ${getMove(sel)}`;
  if (sel.isVigilant) infoStr += ' · <span style="color:#d97706">👁️ 戒备中</span>';
  if (sel.isCrippled) infoStr += ' · <span style="color:#9333ea">🚫 致残中</span>';
  if (inForest(sel.x, sel.y)) infoStr += ' · <span style="color:#16a34a">🌲 密林隐蔽</span>';
  info.innerHTML = infoStr;

  if (sel.hasActed || !myTurn) return;

  const add = (l, f, c) => { const b = document.createElement('button'); b.textContent = l; if (c) b.className = c; b.onclick = () => { initAudio(); SFX.click(); f(); }; actions.appendChild(b); };

  if (ui.moveOrigin && ui.moveOrigin.unitId === sel.id && sel.hasMovedThisRound && !sel.hasActed) {
    add('↩ 取消移动', () => sendIntent({ type: 'cancel_move', unitId: sel.id }), 'danger');
  }
  if (sel.hp <= 1) { add('结束行动', () => sendIntent({ type: 'wait', unitId: sel.id })); return; }

  if (sel.hp >= 3) {
    if (sel.cls === 'greatsword') {
      const around = local.units.filter(e => e.alive && e.team !== sel.team && Math.abs(e.x - sel.x) <= 1 && Math.abs(e.y - sel.y) <= 1);
      if (around.length > 0) add('裂地横扫', () => sendIntent({ type: 'greatsword', unitId: sel.id }), 'primary');
    }
    if (sel.cls === 'spear') add('贯穿突刺', () => { ui.mode = 'spearDir'; render(); }, 'primary');
    if (sel.cls === 'priest') {
      const allies = local.units.filter(a => a.alive && a.team === sel.team && a !== sel && a.hp < 4 && Math.abs(a.x - sel.x) + Math.abs(a.y - sel.y) === 1);
      if (allies.length > 0) add('生命祷言', () => { ui.mode = 'heal'; render(); }, 'primary');
    }
  }

  const sh = shrineAt(sel.x, sel.y);
  if (sh && sh.owner !== sel.team) add('与圣坛共鸣', () => sendIntent({ type: 'capture', unitId: sel.id, x: sh.x, y: sh.y }));
  else if (sel.cls === 'runesmith' && sel.hp >= 3) {
    const adj = local.shrines.find(s => s.owner !== sel.team && Math.abs(s.x - sel.x) + Math.abs(s.y - sel.y) === 1);
    if (adj) add('符文勘界（相邻共鸣）', () => sendIntent({ type: 'capture', unitId: sel.id, x: adj.x, y: adj.y }));
  }
  add('结束行动 (驻守调息)', () => sendIntent({ type: 'wait', unitId: sel.id }));
}

function showGameOver() {
  const d = document.createElement('div');
  d.className = 'gameover';
  const myWin = local.winner === local.you;
  const msg = local.winner ? (myWin ? '你胜利了！' : `${local.winner} 方胜利`) : '平局！';
  d.innerHTML = `<h2>${msg}</h2><button onclick="location.reload()">返回大厅</button>`;
  document.body.appendChild(d);
  myWin ? SFX.win() : SFX.lose();
}

/* ==================== 交互 ==================== */
function sendIntent(action) {
  if (ui.intentPending) return;
  if (!socket || !socket.connected) return;
  ui.intentPending = true;
  socket.emit('action', action);
  setTimeout(() => { ui.intentPending = false; }, 2000);
}

function onCellClick(x, y) {
  if (!isMyTurn()) return;
  const clicked = unitAt(x, y);
  const sel = getSelected();

  if (ui.mode === 'heal' && sel) {
    if (clicked && clicked.team === sel.team && clicked !== sel && clicked.hp < 4 && Math.abs(clicked.x - sel.x) + Math.abs(clicked.y - sel.y) === 1) {
      sendIntent({ type: 'heal', unitId: sel.id, targetId: clicked.id });
      ui.mode = 'normal';
      return;
    }
    return;
  }

  if (clicked && clicked.team === local.you && clicked.alive) {
    if (!sel) { selectUnit(clicked); return; }
    if (!sel.hasMovedThisRound || clicked === sel) { selectUnit(clicked); return; }
  }

  if (!sel || sel.hasActed) return;

  if (clicked && clicked.team !== sel.team && sel.hp >= 2) {
    if (getAttackTargets(sel).includes(clicked)) {
      sendIntent({ type: 'attack', unitId: sel.id, targetId: clicked.id });
      return;
    }
  }

  if (!sel.hasMovedThisRound && !unitAt(x, y)) {
    if (getReachable(sel).has(key(x, y))) {
      ui.moveOrigin = { unitId: sel.id, x: sel.x, y: sel.y };
      sendIntent({ type: 'move', unitId: sel.id, x, y });
      return;
    }
  }
}

function selectUnit(u) {
  if (!u || u.team !== local.you || !u.alive || u.hasActed) return;
  if (ui.intentPending || ui.locked) return;

  const cur = getSelected();
  if (cur && cur.id !== u.id && ui.moveOrigin && cur.hasMovedThisRound && !cur.hasActed) {
    SFX.click();
    return;
  }

  if (ui.selectedId !== u.id) { ui.mode = 'normal'; ui.moveOrigin = null; }
  ui.selectedId = u.id;
  ui.locked = true;
  SFX.click();
  render();
  setTimeout(() => {
    ui.locked = false;
    render();
  }, 800);
}

function autoSelectA() {
  if (local.phase !== local.you) return;
  if (local.turnLocked) return;
  const cur = getSelected();
  if (cur && !cur.hasActed) return;
  const pending = local.units.filter(u => u.alive && u.team === local.you && !u.hasActed);
  if (pending.length > 0) { ui.selectedId = pending[0].id; return; }
  const alive = local.units.filter(u => u.alive && u.team === local.you);
  ui.selectedId = alive.length ? alive[0].id : null;
}

/* ==================== 大厅 UI ==================== */
function showLobby() {
  document.getElementById('lobby').classList.remove('hidden');
  document.getElementById('app').classList.remove('visible');
}
function hideLobby() {
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('app').classList.add('visible');
  setTimeout(layoutBoard, 30);
}

function setLobbyError(msg) {
  const e1 = document.getElementById('lobbyError');
  const e2 = document.getElementById('lobbyError2');
  if (e1) e1.textContent = msg || '';
  if (e2) e2.textContent = msg || '';
}

function renderLobby() {
  const entry = document.getElementById('lobbyEntry');
  const room = document.getElementById('lobbyRoom');
  if (lobby.code) {
    entry.style.display = 'none';
    room.style.display = 'flex';
    document.getElementById('roomCode').textContent = lobby.code;
    renderSlots();
  } else {
    entry.style.display = 'flex';
    room.style.display = 'none';
  }
}

function renderSlots() {
  const list = document.getElementById('slotList');
  list.innerHTML = '';
  const teamNames = { A: '蓝方 A', B: '红方 B', C: '绿方 C' };
  for (const t of TEAMS) {
    const s = lobby.slots[t] || { type: 'ai', nick: 'AI-' + t, connected: true };
    const row = document.createElement('div');
    row.className = 'slot-row';
    const teamEl = document.createElement('div');
    teamEl.className = 'slot-team team-' + t;
    teamEl.textContent = teamNames[t];
    row.appendChild(teamEl);
    const content = document.createElement('div');
    if (s.type === 'human') {
      content.className = 'nick';
      content.textContent = (s.nick || '玩家') + (s.connected === false ? ' (离线)' : '');
      if (!s.connected) {
        const off = document.createElement('span'); off.className = 'offline'; off.textContent = ' 离线';
        content.appendChild(off);
      }
    } else if (s.type === 'ai') {
      content.className = 'ai'; content.textContent = '🤖 AI';
    } else {
      content.className = 'empty'; content.textContent = '等待加入';
    }
    row.appendChild(content);

    if (lobby.isHost && s.type !== 'human') {
      const btn = document.createElement('button');
      btn.textContent = s.type === 'ai' ? '改为空位' : '设为AI';
      btn.onclick = () => {
        SFX.click();
        socket.emit('set_slot', { team: t, type: s.type === 'ai' ? 'empty' : 'ai' });
      };
      row.appendChild(btn);
    }
    list.appendChild(row);
  }

  const startBtn = document.getElementById('startBtn');
  if (lobby.isHost) {
    startBtn.style.display = '';
    const hasEmpty = TEAMS.some(t => !lobby.slots[t] || lobby.slots[t].type === 'empty');
    const hasHuman = TEAMS.some(t => lobby.slots[t] && lobby.slots[t].type === 'human');
    if (hasEmpty) { startBtn.disabled = true; startBtn.textContent = '有槽位未分配，无法开始'; }
    else if (!hasHuman) { startBtn.disabled = true; startBtn.textContent = '至少需要 1 名真人'; }
    else { startBtn.disabled = false; startBtn.textContent = '开始游戏'; }
  } else {
    startBtn.style.display = 'none';
  }
}

/* ==================== Socket ==================== */
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    const savedCode = localStorage.getItem('sl_code');
    const savedToken = localStorage.getItem('sl_token');
    if (savedCode && savedToken) {
      socket.emit('reconnect_token', { code: savedCode, token: savedToken });
    }
  });

  // 每 2 秒测一次 RTT
  setInterval(() => {
    const el = document.getElementById('pingVal');
    if (!socket || !socket.connected) {
      if (el) { el.textContent = '--'; el.className = ''; }
      return;
    }
    const t0 = performance.now();
    socket.emit('ping_check', () => {
      const rtt = Math.round(performance.now() - t0);
      if (el) {
        el.textContent = rtt;
        el.className = rtt < 100 ? '' : rtt < 200 ? 'warn' : 'bad';
      }
    });
  }, 2000);

  socket.on('room_created', (data) => {
    lobby.code = data.code; lobby.token = data.token; lobby.team = data.team;
    localStorage.setItem('sl_code', data.code);
    localStorage.setItem('sl_token', data.token);
    applyLobby(data.lobby);
    renderLobby();
  });

  socket.on('joined', (data) => {
    lobby.code = data.code; lobby.token = data.token; lobby.team = data.team;
    localStorage.setItem('sl_code', data.code);
    localStorage.setItem('sl_token', data.token);
    applyLobby(data.lobby);
    renderLobby();
  });

  socket.on('join_error', (msg) => setLobbyError(msg));

  socket.on('reconnect_failed', (msg) => {
    localStorage.removeItem('sl_code'); localStorage.removeItem('sl_token');
    setLobbyError(msg || '重连失败');
  });

  socket.on('reconnected', (data) => {
    lobby.code = data.code; lobby.token = data.token; lobby.team = data.team;
    applyLobby(data.lobby);
    if (data.status === 'playing' || data.status === 'over') {
      hideLobby();
      local.you = data.team;
      // 重连进来时棋盘还没建，必须补建，否则随后到达的 state 会触发 renderUnits 崩溃
      buildBoard();
      layoutBoard();
      setTimeout(layoutBoard, 100);
    } else {
      renderLobby();
    }
  });

  socket.on('lobby', (data) => {
    applyLobby(data);
    renderLobby();
  });

  socket.on('game_started', (data) => {
    local.you = data.you;
    hideLobby();
    buildBoard();
    layoutBoard();
    setTimeout(layoutBoard, 100);
  });

  socket.on('state', (data) => {
    ui.intentPending = false;
    if (data.seq <= local.seq) return;
    local.seq = data.seq;
    local.you = data.you;
    local.phase = data.phase;
    local.round = data.round;
    local.score = data.score;
    local.units = data.units;
    local.shrines = data.shrines;
    local.springs = data.springs;
    local.obstacles = new Set(data.obstacles);
    local.forests = new Set(data.forests);
    local.rifts = data.rifts;
    local.log = data.log;
    local.actingUnitId = data.actingUnitId;
    local.turnLocked = data.turnLocked;
    local.gameOver = data.gameOver;
    local.winner = data.winner;
    local.highShrinePool = data.highShrinePool;
    local.highShrineClosed = data.highShrineClosed;
    local.turnInRound = data.turnInRound;

    if (local.phase !== local.you) ui.mode = 'normal';

    consumeEvents(data.events);
    render();
  });

  socket.on('action_error', (msg) => {
    ui.intentPending = false;
    console.warn('action error:', msg);
  });

  socket.on('kicked_by_reconnect', () => {
    localStorage.removeItem('sl_code'); localStorage.removeItem('sl_token');
    location.reload();
  });

  socket.on('left_room', () => {
    lobby.code = null; lobby.token = null; lobby.team = null; lobby.isHost = false; lobby.slots = {};
    localStorage.removeItem('sl_code'); localStorage.removeItem('sl_token');
    showLobby();
    renderLobby();
  });

  socket.on('disconnect', () => {
    ui.intentPending = false;
  });
}

function applyLobby(l) {
  if (!l) return;
  lobby.code = l.code;
  lobby.isHost = !!l.isHost;
  lobby.slots = l.slots || {};
  lobby.status = l.status;
}

/* ==================== 启动 ==================== */
function init() {
  document.getElementById('app').classList.remove('visible');
  showLobby();

  const savedNick = localStorage.getItem('sl_nick') || '';
  document.getElementById('nickInput').value = savedNick;

  document.getElementById('exitBtn').onclick = () => {
    if (!confirm('确定退出游戏？退出后你的阵营将由 AI 接管。')) return;
    SFX.click();
    socket.emit('leave_game');
  };

  const readNick = () => {
    const n = (document.getElementById('nickInput').value || '').trim().slice(0, 12);
    if (n) localStorage.setItem('sl_nick', n);
    return n || '玩家';
  };

  document.getElementById('createBtn').onclick = () => {
    initAudio(); SFX.click(); setLobbyError('');
    socket.emit('create_room', { nick: readNick() });
  };
  document.getElementById('joinBtn').onclick = () => {
    initAudio(); SFX.click(); setLobbyError('');
    const code = (document.getElementById('codeInput').value || '').trim().toUpperCase();
    if (!code || code.length !== 6) { setLobbyError('请输入 6 位房间码'); return; }
    socket.emit('join_room', { code, nick: readNick() });
  };
  document.getElementById('codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  document.getElementById('copyCodeBtn').onclick = () => {
    if (!lobby.code) return;
    SFX.click();
    try { navigator.clipboard.writeText(lobby.code); } catch (e) {}
    const btn = document.getElementById('copyCodeBtn');
    btn.textContent = '已复制';
    setTimeout(() => btn.textContent = '复制', 1200);
  };
  document.getElementById('startBtn').onclick = () => {
    initAudio(); SFX.click(); setLobbyError('');
    socket.emit('start_game');
  };
  document.getElementById('leaveBtn').onclick = () => {
    SFX.click();
    socket.emit('leave_room');
  };

  document.getElementById('soundBtn').onclick = () => {
    initAudio(); ui.soundOn = !ui.soundOn;
    document.getElementById('soundBtn').textContent = ui.soundOn ? '🔊 音效' : '🔇 静音';
    if (ui.soundOn) SFX.click();
  };
  document.getElementById('fullscreenBtn').onclick = () => {
    initAudio();
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    } else if (document.exitFullscreen) document.exitFullscreen();
  };
  document.addEventListener('fullscreenchange', () => {
    document.getElementById('fullscreenBtn').textContent = document.fullscreenElement ? '⛶ 退出全屏' : '⛶ 全屏';
  });

  document.getElementById('board').addEventListener('click', (e) => {
    initAudio();
    const cell = e.target.closest('.cell');
    if (!cell) return;
    onCellClick(+cell.dataset.x, +cell.dataset.y);
  });

  document.getElementById('roster').addEventListener('click', (e) => {
    const item = e.target.closest('.roster-item');
    if (!item) return;
    const u = local.units.find(x => x.id === +item.dataset.uid);
    if (!u || !u.alive) return;
    initAudio(); selectUnit(u);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Control') ui.ctrlDown = true;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (e.repeat) return;
      initAudio(); SFX.click();
      if (!isMyTurn()) return;
      const sel = getSelected();
      if (sel && !sel.hasActed) sendIntent({ type: 'wait', unitId: sel.id });
    }
  });
  document.addEventListener('keyup', (e) => { if (e.key === 'Control') ui.ctrlDown = false; });

  window.addEventListener('resize', layoutBoard);
  window.addEventListener('orientationchange', () => setTimeout(layoutBoard, 200));
  if (window.ResizeObserver) {
    new ResizeObserver(() => layoutBoard()).observe(document.getElementById('boardWrap'));
  }

  document.getElementById('minimapWrap').addEventListener('click', () => {
    initAudio();
    drawMapToCanvas('full-map-canvas');
    document.getElementById('map-modal').classList.add('show');
  });
  const modal = document.getElementById('map-modal');
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('#closeMapBtn')) {
      SFX.click();
      modal.classList.remove('show');
    }
  });

  document.addEventListener('click', initAudio, { once: true });

  initSocket();
  renderLobby();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();