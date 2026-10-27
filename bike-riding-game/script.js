'use strict';

/* =========================================================
   설정값 (숫자를 바꾸면 게임 느낌이 바뀝니다)
   ========================================================= */
const TIME_SCALE = 6;       // 게임 속 시간은 실제보다 6배 빠르게 흐름
const SAMPLE_M = 10;        // 지형 높이를 10m 간격으로 저장
const VIEW_BEHIND_M = 40;   // 화면에서 자전거 뒤로 보이는 거리(m)
const VIEW_AHEAD_M = 120;   // 화면에서 자전거 앞으로 보이는 거리(m)
const VERT_EXAG = 3;        // 경사를 눈에 잘 보이게 과장하는 배율
const JUMP_TIME = 0.7;      // 점프 체공 시간(실제 초)
const COUNTDOWN = 3;        // 출발 카운트다운(초)

// 난이도: 경사(slopeMax %), 평지 비율, 장애물 간격(m), 장애물 종류
const DIFFICULTY = {
  easy:   { label: '하', slopeMax: 3,  flatChance: 0.5,  gap: [350, 550], types: ['rock', 'pothole'] },
  normal: { label: '중', slopeMax: 6,  flatChance: 0.3,  gap: [200, 350], types: ['rock', 'pothole', 'log'] },
  hard:   { label: '상', slopeMax: 10, flatChance: 0.15, gap: [110, 220], types: ['rock', 'pothole', 'log', 'cone'] },
};

// 자전거: 최고속도(km/h), 페달 1번당 가속, 오르막 저항 배율, 넘어진 뒤 멈춤 시간(실제 초), 칼로리 배율
const BIKES = {
  road: { label: '로드바이크', maxSpeed: 42, accel: 1.7, climb: 1.0,  crashTime: 1.8, met: 1.0,  color: '#e11d48', tire: 2 },
  mtb:  { label: 'MTB',       maxSpeed: 34, accel: 1.5, climb: 0.65, crashTime: 1.0, met: 1.15, color: '#16a34a', tire: 4 },
  city: { label: '시티바이크', maxSpeed: 30, accel: 1.9, climb: 1.1,  crashTime: 1.4, met: 0.9,  color: '#2563eb', tire: 3 },
};

// 장애물 길이(m) — 점프로 이 길이를 통째로 넘어야 성공
const OBSTACLE_LEN = { rock: 3, pothole: 4, log: 3, cone: 2.5 };

/* =========================================================
   DOM
   ========================================================= */
const $ = (id) => document.getElementById(id);
const els = {
  setup: $('setup'), game: $('game'), result: $('result'),
  startBtn: $('startBtn'), weight: $('weight'), weightError: $('weightError'),
  badge: $('statusBadge'), statusIcon: $('statusIcon'), statusText: $('statusText'),
  courseInfo: $('courseInfo'), progressFill: $('progressFill'), progressText: $('progressText'),
  canvas: $('canvas'), countdown: $('countdown'),
  speed: $('hudSpeed'), slope: $('hudSlope'), remain: $('hudRemain'),
  time: $('hudTime'), kcal: $('hudKcal'), crashes: $('hudCrashes'),
  pedalBtn: $('pedalBtn'), jumpBtn: $('jumpBtn'),
  retryBtn: $('retryBtn'), changeBtn: $('changeBtn'),
  resultTitle: $('resultTitle'), resultMsg: $('resultMsg'), resultKcal: $('resultKcal'), resultList: $('resultList'),
};
const ctx = els.canvas.getContext('2d');
const view = { w: 0, h: 0, pxPerM: 1 };

let game = null;
let lastCfg = null;
let lastTs = 0;

/* =========================================================
   유틸
   ========================================================= */
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function fmtTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/* =========================================================
   코스 만들기 (경사 + 장애물)
   ========================================================= */
function buildCourse(totalM, diff) {
  const n = Math.ceil((totalM + VIEW_AHEAD_M + 200) / SAMPLE_M);
  const finishIdx = Math.floor(totalM / SAMPLE_M);

  // 구간마다 경사를 정함 (첫 100m와 결승선 이후는 평지)
  const raw = [];
  let i = 0;
  while (i < n) {
    const segLen = i === 0 ? 10 : Math.round(rand(250, 600) / SAMPLE_M);
    let slope = 0;
    if (i > 0 && Math.random() > diff.flatChance) {
      slope = rand(diff.slopeMax * 0.4, diff.slopeMax) * (Math.random() < 0.5 ? -1 : 1);
    }
    for (let k = 0; k < segLen && i < n; k++, i++) raw.push(i >= finishIdx ? 0 : slope);
  }

  // 구간 경계를 부드럽게 이어줌
  const slopes = raw.map((_, j) => {
    let sum = 0, cnt = 0;
    for (let k = -4; k <= 4; k++) {
      const v = raw[j + k];
      if (v !== undefined) { sum += v; cnt++; }
    }
    return sum / cnt;
  });

  const heights = [0];
  for (let j = 0; j < n; j++) heights.push(heights[j] + (slopes[j] / 100) * SAMPLE_M);

  // 장애물 배치 (출발 직후와 결승 직전은 비움)
  const obstacles = [];
  let d = 150 + rand(diff.gap[0], diff.gap[1]) * 0.5;
  while (d < totalM - 60) {
    const type = pick(diff.types);
    obstacles.push({ d, type, len: OBSTACLE_LEN[type], done: false, hit: false });
    d += rand(diff.gap[0], diff.gap[1]);
  }

  return { totalM, slopes, heights, obstacles };
}

function slopeAt(course, d) {
  const idx = clamp(Math.floor(d / SAMPLE_M), 0, course.slopes.length - 1);
  return course.slopes[idx];
}

function heightAt(course, d) {
  const f = d / SAMPLE_M;
  const last = course.heights.length - 1;
  if (f <= 0) return course.heights[0];
  if (f >= last) return course.heights[last];
  const i = Math.floor(f);
  const t = f - i;
  return course.heights[i] * (1 - t) + course.heights[i + 1] * t;
}

function nextObstacle(g) {
  return g.course.obstacles.find((o) => !o.done);
}

/* =========================================================
   칼로리 (MET × 몸무게(kg) × 시간(h))
   ========================================================= */
function calcMet(speed, slope, bike, resting) {
  if (resting || speed < 1) return 1.5;            // 멈춰 있음 / 넘어져 쉬는 중
  let met;
  if (speed < 10) met = 3.5;
  else if (speed < 16) met = 4;
  else if (speed < 19) met = 6.8;
  else if (speed < 22) met = 8;
  else if (speed < 25) met = 10;
  else if (speed < 30) met = 12;
  else met = 15.8;
  if (slope > 0) met += slope * 0.6;               // 오르막은 더 힘듦
  else if (slope < -2) met *= 0.6;                 // 내리막은 덜 힘듦
  return met * bike.met;
}

/* =========================================================
   게임 진행
   ========================================================= */
function createGame(cfg) {
  const course = buildCourse(cfg.distanceKm * 1000, DIFFICULTY[cfg.difficulty]);
  return {
    cfg,
    bike: BIKES[cfg.bike],
    course,
    phase: 'countdown',     // countdown → riding → finished
    countdown: COUNTDOWN,
    goFlash: 0,
    dist: 0,                // 달린 거리(m)
    speed: 0,               // km/h
    slope: 0,
    gameTime: 0,            // 게임 속 경과 시간(초)
    kcal: 0,
    crashes: 0,
    cleared: 0,
    airTime: 0,
    crashTimer: 0,
    pedalPulse: 0,
  };
}

function pedal() {
  const g = game;
  if (!g || g.phase !== 'riding' || g.crashTimer > 0) return;
  const cap = g.slope < -1 ? g.bike.maxSpeed * 1.25 : g.bike.maxSpeed;
  g.speed = Math.max(g.speed, Math.min(cap, g.speed + g.bike.accel));
  g.pedalPulse = 1;
}

function jump() {
  const g = game;
  if (!g || g.phase !== 'riding' || g.crashTimer > 0 || g.airTime > 0) return;
  g.airTime = JUMP_TIME;
}

function update(dt) {
  const g = game;

  if (g.phase === 'countdown') {
    g.countdown -= dt;
    if (g.countdown <= 0) { g.phase = 'riding'; g.goFlash = 0.8; }
    return;
  }
  if (g.phase !== 'riding') return;

  const bike = g.bike;
  g.slope = slopeAt(g.course, g.dist);
  g.goFlash = Math.max(0, g.goFlash - dt);
  g.pedalPulse = Math.max(0, g.pedalPulse - dt * 3);

  if (g.crashTimer > 0) {
    g.crashTimer = Math.max(0, g.crashTimer - dt);
    g.speed = 0;
  } else {
    // 공기·노면 저항 + 경사
    let accel = -(0.8 + g.speed * 0.1);
    if (g.slope > 0) accel -= g.slope * 0.5 * bike.climb;
    else accel += -g.slope * 0.6;
    g.speed = clamp(g.speed + accel * dt, 0, bike.maxSpeed * 1.25);
  }

  if (g.airTime > 0) g.airTime = Math.max(0, g.airTime - dt);

  const gameDt = dt * TIME_SCALE;
  g.dist += (g.speed / 3.6) * gameDt;
  g.gameTime += gameDt;
  g.kcal += calcMet(g.speed, g.slope, bike, g.crashTimer > 0) * g.cfg.weight * (gameDt / 3600);

  checkObstacles(g);

  if (g.dist >= g.course.totalM) {
    g.dist = g.course.totalM;
    finish(g);
  }
}

function checkObstacles(g) {
  for (const o of g.course.obstacles) {
    if (o.done) continue;
    if (o.d > g.dist) break;
    if (g.airTime > 0) {
      // 공중에서 장애물을 끝까지 넘으면 성공
      if (g.dist >= o.d + o.len) { o.done = true; g.cleared++; }
    } else {
      // 땅에 닿은 채로 부딪힘 → 속도 0, 잠깐 멈춤
      o.done = true;
      o.hit = true;
      g.crashes++;
      g.crashTimer = g.bike.crashTime;
      g.speed = 0;
      g.dist = o.d + o.len;
    }
  }
}

function finish(g) {
  g.phase = 'finished';
  g.speed = 0;
  setTimeout(() => { if (game === g) showResult(g); }, 900);
}

/* =========================================================
   상태 (색 + 문구)
   ========================================================= */
function currentStatus(g) {
  if (g.phase === 'countdown') return { key: 'ready', icon: '⏳', text: `출발 준비 ${Math.ceil(g.countdown)}` };
  if (g.phase === 'finished') return { key: 'finish', icon: '🏁', text: '완주!' };
  if (g.crashTimer > 0) return { key: 'crash', icon: '💥', text: `넘어짐! ${g.crashTimer.toFixed(1)}초 후 출발` };
  if (g.airTime > 0) return { key: 'jump', icon: '🦘', text: '점프!' };

  const next = nextObstacle(g);
  const warnDist = Math.max(40, (g.speed / 3.6) * TIME_SCALE * 1.5); // 약 1.5초 전에 경고
  if (next && next.d - g.dist < warnDist) {
    return { key: 'warn', icon: '⚠️', text: `장애물 ${Math.max(0, Math.round(next.d - g.dist))}m 앞! 점프!` };
  }
  if (g.speed < 1) return { key: 'stop', icon: '✋', text: '멈춤 — 페달을 밟으세요' };

  const s = Math.round(g.slope) || 0;
  if (g.slope > 2) return { key: 'up', icon: '⛰️', text: `오르막 +${s}% 힘내요!` };
  if (g.slope < -2) return { key: 'down', icon: '⬇️', text: `내리막 ${s}% 속도 UP` };
  return { key: 'ride', icon: '🚴', text: '순조롭게 주행 중' };
}

function updateHud() {
  const g = game;
  const s = Math.round(g.slope) || 0;
  setText(els.speed, g.speed.toFixed(1));
  setText(els.slope, `${s > 0 ? '+' : ''}${s}%`);
  setText(els.remain, Math.max(0, (g.course.totalM - g.dist) / 1000).toFixed(2));
  setText(els.time, fmtTime(g.gameTime));
  setText(els.kcal, g.kcal.toFixed(1));
  setText(els.crashes, String(g.crashes));

  const pct = Math.min(100, (g.dist / g.course.totalM) * 100);
  els.progressFill.style.width = `${pct.toFixed(1)}%`;
  setText(els.progressText, `${Math.floor(pct)}% · ${(g.dist / 1000).toFixed(2)} / ${g.cfg.distanceKm} km`);

  const st = currentStatus(g);
  if (els.badge.dataset.state !== st.key) {
    els.badge.dataset.state = st.key;
    els.game.dataset.state = st.key;
  }
  setText(els.statusIcon, st.icon);
  setText(els.statusText, st.text);

  let cd = '';
  if (g.phase === 'countdown') cd = String(Math.ceil(g.countdown));
  else if (g.goFlash > 0) cd = '출발!';
  setText(els.countdown, cd);

  const canRide = g.phase === 'riding' && g.crashTimer <= 0;
  els.pedalBtn.classList.toggle('off', !canRide);
  els.jumpBtn.classList.toggle('off', !canRide || g.airTime > 0);
}

/* =========================================================
   그리기
   ========================================================= */
function resizeCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  view.w = rect.width;
  view.h = rect.height;
  els.canvas.width = Math.round(rect.width * dpr);
  els.canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  view.pxPerM = view.w / (VIEW_BEHIND_M + VIEW_AHEAD_M);
}

function render() {
  const g = game;
  const { w, h, pxPerM } = view;
  if (!w || !h) return;
  const course = g.course;
  const riderX = VIEW_BEHIND_M * pxPerM;
  const baseY = h * 0.68;
  const h0 = heightAt(course, g.dist);
  const groundY = (d) => baseY - (heightAt(course, d) - h0) * pxPerM * VERT_EXAG;
  const xOf = (d) => riderX + (d - g.dist) * pxPerM;
  const scroll = g.dist * pxPerM;

  // 하늘
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#7dd3fc');
  sky.addColorStop(1, '#e0f2fe');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // 해
  ctx.fillStyle = '#fde047';
  ctx.beginPath();
  ctx.arc(w - 50, 40, 22, 0, Math.PI * 2);
  ctx.fill();

  // 먼 산 (패럴랙스)
  drawHills(scroll * 0.12, h * 0.5, 50, '#a5c9a0', 0.010);
  drawHills(scroll * 0.3, h * 0.6, 34, '#7fb36f', 0.018);

  // 땅 + 도로
  const pts = [];
  for (let x = -4; x <= w + 8; x += 4) pts.push([x, groundY(g.dist + (x - riderX) / pxPerM)]);

  ctx.fillStyle = '#65a30d';
  ctx.beginPath();
  ctx.moveTo(-4, h);
  for (const [x, y] of pts) ctx.lineTo(x, y + 12);
  ctx.lineTo(w + 8, h);
  ctx.closePath();
  ctx.fill();

  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#44403c';
  ctx.lineWidth = 14;
  strokePath(pts, 7);

  ctx.strokeStyle = '#fafaf9';
  ctx.lineWidth = 2;
  ctx.setLineDash([12, 12]);
  ctx.lineDashOffset = scroll % 24;
  strokePath(pts, 7);
  ctx.setLineDash([]);

  // 거리 표지판 (500m마다)
  for (let m = Math.ceil((g.dist - VIEW_BEHIND_M) / 500) * 500; m <= g.dist + VIEW_AHEAD_M; m += 500) {
    if (m <= 0 || m >= course.totalM) continue;
    drawSign(xOf(m), groundY(m), `${(m / 1000).toFixed(1)}km`);
  }

  // 출발선 / 결승선
  if (xOf(0) > -20) drawLine(xOf(0), groundY(0), 'START');
  if (xOf(course.totalM) < w + 40) drawLine(xOf(course.totalM), groundY(course.totalM), 'FINISH');

  // 장애물
  for (const o of course.obstacles) {
    // 화면이 좁아도 잘 보이도록 최소 18px로 그림 (충돌 판정은 실제 길이 기준)
    const realW = o.len * pxPerM;
    const ow = Math.max(realW, 18);
    const x = xOf(o.d) - (ow - realW) / 2;
    if (x + ow < -30 || x > w + 30) continue;
    drawObstacle(o, x, ow, groundY(o.d + o.len / 2));
  }

  // 자전거
  const backD = g.dist - 36 / pxPerM;
  const angle = Math.atan2(groundY(g.dist) - groundY(backD), 36);
  const jumpH = g.airTime > 0 ? Math.sin(Math.PI * (1 - g.airTime / JUMP_TIME)) * 40 : 0;
  drawBike(g, riderX, groundY(g.dist) - jumpH, angle);
}

function strokePath(pts, dy) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y + dy) : ctx.moveTo(x, y + dy)));
  ctx.stroke();
}

function drawHills(offset, baseY, amp, color, freq) {
  const { w, h } = view;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w + 8; x += 8) {
    const t = (x + offset) * freq;
    ctx.lineTo(x, baseY - amp * (0.6 + 0.4 * Math.sin(t)) - amp * 0.3 * Math.sin(t * 2.3));
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
}

function drawSign(x, y, text) {
  ctx.fillStyle = '#78716c';
  ctx.fillRect(x - 1.5, y - 34, 3, 34);
  ctx.fillStyle = '#16a34a';
  ctx.fillRect(x - 22, y - 50, 44, 18);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y - 41);
}

function drawLine(x, y, label) {
  // 체크무늬 줄
  const size = 5;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 2; c++) {
      ctx.fillStyle = (r + c) % 2 ? '#111' : '#fff';
      ctx.fillRect(x + c * size, y + r * size, size, size);
    }
  }
  // 깃대 + 깃발
  ctx.fillStyle = '#334155';
  ctx.fillRect(x + 12, y - 60, 3, 60);
  ctx.fillStyle = label === 'FINISH' ? '#dc2626' : '#2563eb';
  ctx.fillRect(x + 15, y - 60, 52, 18);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 41, y - 51);
}

function drawObstacle(o, x, ow, y) {
  ctx.save();
  if (o.hit) ctx.globalAlpha = 0.45;
  const cx = x + ow / 2;
  switch (o.type) {
    case 'rock':
      ctx.fillStyle = '#78716c';
      ctx.beginPath();
      ctx.moveTo(x - 2, y + 2);
      ctx.lineTo(x + ow * 0.15, y - 12);
      ctx.lineTo(cx, y - 18);
      ctx.lineTo(x + ow * 0.85, y - 11);
      ctx.lineTo(x + ow + 2, y + 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#a8a29e';
      ctx.beginPath();
      ctx.ellipse(cx - 3, y - 11, 3, 2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'pothole':
      ctx.fillStyle = '#1c1917';
      ctx.beginPath();
      ctx.ellipse(cx, y + 4, ow / 2 + 2, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.ellipse(cx, y + 4, ow / 2 - 2, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'log':
      ctx.fillStyle = '#92400e';
      ctx.fillRect(x, y - 12, ow, 12);
      ctx.fillStyle = '#d6a160';
      ctx.beginPath();
      ctx.ellipse(x + ow, y - 6, 4, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#92400e';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(x + ow, y - 6, 2, 3, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'cone':
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.moveTo(x - 2, y + 1);
      ctx.lineTo(cx, y - 22);
      ctx.lineTo(x + ow + 2, y + 1);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillRect(cx - 4, y - 12, 8, 3);
      break;
  }
  ctx.restore();
}

function drawWheel(x, y, r, angle, bike) {
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = bike.tire;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const a = angle + (i * Math.PI) / 3;
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(a) * r, y - Math.sin(a) * r);
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    ctx.stroke();
  }
}

function drawLeg(hip, pedalPt, color) {
  const vx = pedalPt[0] - hip[0];
  const vy = pedalPt[1] - hip[1];
  const len = Math.hypot(vx, vy);
  const seg = 14;
  const off = len < seg * 2 ? Math.sqrt(seg * seg - (len / 2) ** 2) : 0;
  let nx = vy / len, ny = -vx / len;
  if (nx < 0) { nx = -nx; ny = -ny; }   // 무릎은 앞쪽으로
  const knee = [(hip[0] + pedalPt[0]) / 2 + nx * off, (hip[1] + pedalPt[1]) / 2 + ny * off];
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hip[0], hip[1]);
  ctx.lineTo(knee[0], knee[1]);
  ctx.lineTo(pedalPt[0], pedalPt[1]);
  ctx.stroke();
}

function drawBike(g, x, y, angle) {
  const bike = g.bike;
  const crashed = g.crashTimer > 0;
  const wheelAngle = (g.dist * view.pxPerM) / 11;
  const crank = wheelAngle * 0.6;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle + (crashed ? 0.7 : 0));   // 넘어지면 앞으로 고꾸라짐

  // 주요 지점 (원점 = 앞바퀴가 땅에 닿는 곳)
  const R = [-36, -11];   // 뒷바퀴 축
  const F = [0, -11];     // 앞바퀴 축
  const B = [-20, -12];   // 크랭크
  const S = [-26, -31];   // 안장
  const H = [-6, -31];    // 핸들 기둥
  const hip = [-26, -35];
  const p1 = [B[0] + Math.cos(crank) * 7, B[1] + Math.sin(crank) * 7];
  const p2 = [B[0] - Math.cos(crank) * 7, B[1] - Math.sin(crank) * 7];

  drawLeg(hip, p2, '#1e3a8a');    // 뒤쪽 다리

  drawWheel(R[0], R[1], 11, wheelAngle, bike);
  drawWheel(F[0], F[1], 11, wheelAngle, bike);

  // 프레임
  ctx.strokeStyle = bike.color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(R[0], R[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(S[0], S[1]); ctx.lineTo(R[0], R[1]);
  ctx.moveTo(S[0], S[1]); ctx.lineTo(H[0], H[1]); ctx.lineTo(B[0], B[1]);
  ctx.moveTo(H[0], H[1]); ctx.lineTo(F[0], F[1]);
  ctx.stroke();

  // 안장 + 핸들
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(S[0] - 5, S[1] - 2); ctx.lineTo(S[0] + 4, S[1] - 2);
  ctx.moveTo(H[0], H[1]); ctx.lineTo(H[0] + 2, H[1] - 5); ctx.lineTo(H[0] + 7, H[1] - 5);
  ctx.stroke();

  // 시티바이크 바구니
  if (bike === BIKES.city) {
    ctx.fillStyle = '#a16207';
    ctx.fillRect(H[0] + 3, H[1] - 4, 10, 8);
  }

  // 라이더 몸
  const shoulder = [-14, -52];
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(hip[0], hip[1]); ctx.lineTo(shoulder[0], shoulder[1]);
  ctx.stroke();
  ctx.strokeStyle = '#fcd34d';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(shoulder[0], shoulder[1]); ctx.lineTo(H[0] + 5, H[1] - 5);
  ctx.stroke();

  // 머리 + 헬멧
  ctx.fillStyle = '#fed7aa';
  ctx.beginPath();
  ctx.arc(-9, -61, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = bike.color;
  ctx.beginPath();
  ctx.arc(-9, -62, 7.5, Math.PI, Math.PI * 2);
  ctx.fill();

  drawLeg(hip, p1, '#2563eb');    // 앞쪽 다리

  ctx.restore();

  if (crashed) {
    ctx.font = '22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💫', x - 10, y - 80);
  } else if (g.pedalPulse > 0) {
    ctx.fillStyle = `rgba(255,255,255,${g.pedalPulse * 0.8})`;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('쓩!', x - 60, y - 20);
  }
}

/* =========================================================
   결과
   ========================================================= */
function showResult(g) {
  const hours = g.gameTime / 3600;
  const km = g.course.totalM / 1000;
  const avg = hours > 0 ? km / hours : 0;
  const total = g.course.obstacles.length;

  els.resultTitle.textContent = g.crashes === 0 ? '노 크래시 완주! 🏆' : '완주 성공! 🎉';
  els.resultMsg.textContent = g.crashes === 0
    ? '장애물을 모두 넘었어요. 완벽한 라이딩!'
    : `장애물에 ${g.crashes}번 부딪혔지만 끝까지 달렸어요!`;
  els.resultKcal.textContent = Math.round(g.kcal).toLocaleString('ko-KR');

  const rows = [
    ['코스', `${g.cfg.distanceKm}km · 난이도 ${DIFFICULTY[g.cfg.difficulty].label}`],
    ['자전거', g.bike.label],
    ['몸무게', `${g.cfg.weight}kg`],
    ['주행 시간', fmtTime(g.gameTime)],
    ['평균 속도', `${avg.toFixed(1)} km/h`],
    ['점프로 넘은 장애물', `${g.cleared} / ${total}개`],
    ['넘어진 횟수', `${g.crashes}회`],
    ['밥 한 공기(300kcal) 기준', `${(g.kcal / 300).toFixed(1)}공기`],
  ];
  els.resultList.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    els.resultList.append(dt, dd);
  }

  els.result.classList.remove('hidden');
  els.retryBtn.focus();
}

/* =========================================================
   화면 전환 / 시작
   ========================================================= */
function showScreen(name) {
  els.setup.classList.toggle('active', name === 'setup');
  els.game.classList.toggle('active', name === 'game');
}

function readConfig() {
  const val = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
  const weight = Number(els.weight.value);
  if (!Number.isFinite(weight) || weight < 20 || weight > 200) return null;
  return { distanceKm: Number(val('distance')), difficulty: val('difficulty'), bike: val('bike'), weight };
}

function startGame(cfg) {
  lastCfg = cfg;
  game = createGame(cfg);
  els.result.classList.add('hidden');
  showScreen('game');
  setText(els.courseInfo, `${cfg.distanceKm}km · 난이도 ${DIFFICULTY[cfg.difficulty].label} · ${BIKES[cfg.bike].label}`);
  resizeCanvas();
  window.scrollTo(0, 0);
}

function loop(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  if (game) {
    update(dt);
    render();
    updateHud();
  }
  requestAnimationFrame(loop);
}

/* =========================================================
   입력
   ========================================================= */
function bindPress(btn, fn) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.classList.add('pressed');
    fn();
  });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) {
    btn.addEventListener(t, () => btn.classList.remove('pressed'));
  }
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

bindPress(els.pedalBtn, pedal);
bindPress(els.jumpBtn, jump);

document.addEventListener('keydown', (e) => {
  if (!game || game.phase === 'finished' || !els.game.classList.contains('active')) return;
  if (e.code === 'Space' || e.code === 'ArrowRight' || e.code === 'KeyD') {
    e.preventDefault();
    if (!e.repeat) pedal();
  } else if (e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    if (!e.repeat) jump();
  }
});

els.startBtn.addEventListener('click', () => {
  const cfg = readConfig();
  if (!cfg) {
    els.weightError.hidden = false;
    els.weight.focus();
    return;
  }
  els.weightError.hidden = true;
  startGame(cfg);
});

els.retryBtn.addEventListener('click', () => startGame(lastCfg));

els.changeBtn.addEventListener('click', () => {
  els.result.classList.add('hidden');
  game = null;
  showScreen('setup');
});

window.addEventListener('resize', () => { if (game) resizeCanvas(); });

requestAnimationFrame((ts) => { lastTs = ts; loop(ts); });
