// MAX reactor orb: a fragmented particle sphere, debris rings, orbiting comets and a tangled
// glowing core, drawn additively on a canvas that fades instead of clearing (long-exposure streaks).
// Public API: Orb.setMode(m), Orb.setLevel(v), Orb.setSpectrum(arr), Orb.setEmotion(e), Orb.pulse(), Orb.hit(x, y)
const Orb = (() => {
  const canvas = document.getElementById('orb');
  const ctx = canvas.getContext('2d');
  const TAU = Math.PI * 2;
  const rnd = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));

  let W = 0, H = 0, cx = 0, cy = 0, R = 100, dpr = 1;
  let mode = 'boot', level = 0, spectrum = null, emotion = 'neutral';
  let t = 0, last = performance.now();
  let boot = 0, flash = 0, quality = 1, slowFrames = 0;
  const S = { energy: 0.3, spin: 0.15, hue: 28, sat: 100, lvl: 0, wave: 0, scale: 1, chaos: 0, orbit: 1, light: 0 };
  let yaw = 0, mouseX = 0, mouseY = 0, parX = 0, parY = 0;

  const EMO = {
    neutral: [28, 100], happy: [36, 100], excited: [40, 100], playful: [42, 100], warm: [30, 100],
    calm: [26, 85], curious: [34, 100], concerned: [18, 100], sad: [16, 70], serious: [22, 95],
    proud: [38, 100], surprised: [44, 100],
  };

  // ---------- sprites
  function sprite(size, stops) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach(([o, col]) => grad.addColorStop(o, col));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }
  const dotSprite = sprite(32, [[0, 'rgba(255,245,220,1)'], [0.2, 'rgba(255,190,90,0.9)'], [0.5, 'rgba(255,120,20,0.25)'], [1, 'rgba(255,90,0,0)']]);
  const coreSprite = sprite(256, [[0, 'rgba(255,250,235,1)'], [0.12, 'rgba(255,215,140,0.95)'], [0.35, 'rgba(255,140,40,0.45)'], [0.7, 'rgba(230,80,10,0.12)'], [1, 'rgba(200,60,0,0)']]);
  const hazeSprite = sprite(256, [[0, 'rgba(255,150,60,0.55)'], [0.5, 'rgba(200,80,20,0.18)'], [1, 'rgba(120,40,0,0)']]);

  // ---------- geometry
  function unitVec() {
    const u = rnd(-1, 1), th = rnd(TAU), s = Math.sqrt(1 - u * u);
    return [s * Math.cos(th), u, s * Math.sin(th)];
  }

  // Shell: clustered "debris" chunks plus fine dust, in three counter-rotating layers.
  const shell = [];
  (function buildShell() {
    for (let c = 0; c < 170; c++) {
      const [x, y, z] = unitVec();
      const n = 3 + ((Math.random() ** 1.6) * 18) | 0;
      const layer = Math.random() < 0.6 ? 0 : Math.random() < 0.6 ? 1 : 2;
      const out = Math.random() < 0.12 ? rnd(0.06, 0.2) : 0;
      for (let k = 0; k < n; k++) {
        const j = 0.09;
        let px = x + rnd(-j, j), py = y + rnd(-j, j), pz = z + rnd(-j, j);
        const m = Math.hypot(px, py, pz);
        shell.push({ x: px / m, y: py / m, z: pz / m, r: rnd(0.93, 1.05) + out, layer, bright: 1,
          trail: rnd(0.02, 0.09), ph: rnd(TAU), w: rnd(0.5, 2), hot: Math.random() < 0.07 });
      }
    }
    for (let i = 0; i < 700; i++) {
      const [x, y, z] = unitVec();
      shell.push({ x, y, z, r: rnd(0.6, 1.08), layer: (Math.random() * 3) | 0, bright: 0,
        trail: rnd(0.01, 0.05), ph: rnd(TAU), w: rnd(0.3, 1.5), hot: false });
    }
  })();
  const LAYER_SPEED = [1, 0.55, -0.38];

  // Flat debris arcs around the limb.
  const arcs = [];
  for (let i = 0; i < 110; i++) {
    const big = Math.random() < 0.18;
    arcs.push({ r: rnd(0.98, 1.17), a: rnd(TAU), len: big ? rnd(0.15, 0.6) : rnd(0.02, 0.16),
      w: big ? rnd(1, 2.6) : rnd(0.5, 3.5), al: rnd(0.12, 0.7), spd: rnd(-0.18, 0.18) * (Math.random() < 0.5 ? 1 : 2),
      dash: Math.random() < 0.28, ph: rnd(TAU) });
  }
  const ticks = [];
  for (let i = 0; i < 150; i++) ticks.push({ a: rnd(TAU), r: rnd(0.92, 1.12), l: rnd(0.015, 0.07), spd: rnd(-0.12, 0.12), al: rnd(0.2, 0.8) });

  // Orbiting comets on tilted great circles through the sphere.
  const orbits = [];
  for (let i = 0; i < 5; i++) {
    const n = unitVec();
    let u = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let a = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    let m = Math.hypot(...a); a = a.map(v => v / m);
    const b = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
    orbits.push({ U: a, V: b, r: rnd(0.45, 0.98), spd: rnd(0.5, 1.3) * (i % 2 ? -1 : 1), ph: rnd(TAU), tail: rnd(1.2, 2.6) });
  }

  // Tangled core: torus knots spinning on their own axes.
  const knots = [[2, 3], [3, 5], [2, 5], [3, 4], [1, 3], [4, 7]].map(([p, q], i) => ({
    p, q, spd: rnd(0.6, 1.6) * (i % 2 ? -1 : 1), tilt: rnd(TAU), ph: rnd(TAU), s: rnd(0.16, 0.27) }));

  const sparks = [];

  // ---------- projection helpers
  let ca = 1, sa = 0, ct = 1, st = 0;
  const F = 3.2;
  function setRot(a, tilt) { ca = Math.cos(a); sa = Math.sin(a); ct = Math.cos(tilt); st = Math.sin(tilt); }
  const P = { x: 0, y: 0, z: 0 };
  function proj(x, y, z, rad) {
    const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
    const y1 = y * ct - z1 * st, z2 = y * st + z1 * ct;
    const p = F / (F - z2);
    P.x = cx + x1 * p * rad; P.y = cy + y1 * p * rad; P.z = z2;
    return P;
  }

  // ---------- frame
  const NB = 6;
  const buckets = [];
  for (let i = 0; i < NB * 2; i++) buckets.push([]);

  function col(l, a) { return `hsla(${S.hue.toFixed(1)},${S.sat}%,${l}%,${Math.max(0, Math.min(1, a)).toFixed(3)})`; }

  function targets() {
    const L = level;
    switch (mode) {
      case 'listening': return { energy: 0.55 + L * 0.9, spin: 0.22 + L * 0.3, scale: 0.97 + L * 0.06, chaos: L * 0.5, orbit: 1.2, light: 0.15 };
      case 'thinking': return { energy: 0.7, spin: 0.95, scale: 0.99, chaos: 0.15, orbit: 2.8, light: 0.1 };
      case 'speaking': return { energy: 0.55 + L * 1.1, spin: 0.25 + L * 0.7, scale: 1 + L * 0.09, chaos: L, orbit: 1.4 + L, light: L * 0.35 };
      case 'offline': return { energy: 0.12, spin: 0.05, scale: 0.92, chaos: 0, orbit: 0.3, light: 0 };
      case 'boot': return { energy: 0.4, spin: 0.6, scale: 1, chaos: 0.2, orbit: 2, light: 0 };
      default: return { energy: 0.32 + Math.sin(t * 1.3) * 0.05, spin: 0.14, scale: 1 + Math.sin(t * 1.1) * 0.012, chaos: 0, orbit: 1, light: 0 };
    }
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    // adaptive quality: drop dust on slow machines
    if (dt > 0.03) { if (++slowFrames > 40 && quality > 0.5) { quality -= 0.25; slowFrames = 0; } } else slowFrames = Math.max(0, slowFrames - 1);

    const T = targets();
    const k = 1 - Math.pow(0.0015, dt);
    S.energy += (T.energy - S.energy) * k;
    S.spin += (T.spin - S.spin) * k * 0.6;
    S.scale += (T.scale - S.scale) * k * 1.5;
    S.chaos += (T.chaos - S.chaos) * k;
    S.orbit += (T.orbit - S.orbit) * k * 0.5;
    S.light += (T.light - S.light) * k;
    S.lvl += (level - S.lvl) * Math.min(1, dt * 18);
    const showWave = (mode === 'speaking' || mode === 'listening') && spectrum ? 1 : 0;
    S.wave += (showWave - S.wave) * k;
    const [eh, es] = EMO[emotion] || EMO.neutral;
    S.hue += ((mode === 'offline' ? 20 : eh + S.light * 12) - S.hue) * k * 0.5;
    S.sat += (es - S.sat) * k * 0.5;
    if (mode !== 'boot' || boot < 1) boot = Math.min(1, boot + dt / 2.4);
    flash = Math.max(0, flash - dt * 1.6);
    yaw += S.spin * dt;
    parX += (mouseX - parX) * dt * 2; parY += (mouseY - parY) * dt * 2;

    // fade previous frame -> motion trails
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${mode === 'speaking' ? 0.24 : 0.3})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';

    const bootE = easeOutBack(boot);
    const rad = R * S.scale * bootE;
    const E = S.energy * (0.4 + 0.6 * boot) + flash * 0.8;
    const tilt = -0.34 + parY * 0.18;
    const baseYaw = yaw + parX * 0.3;

    drawHud(rad, E);
    drawHaze(rad, E);
    drawShell(rad, E, baseYaw, tilt, dt);
    drawArcs(rad, E, dt);
    drawOrbits(rad, E, baseYaw, tilt);
    drawCore(rad, E, baseYaw, tilt);
    drawSparks(rad, E, dt, baseYaw, tilt);
    drawWave(rad);

    requestAnimationFrame(frame);
  }

  function easeOutBack(x) { const c1 = 1.4, c3 = c1 + 1; return x >= 1 ? 1 : 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }

  function drawHaze(rad, E) {
    const s = rad * 2.7;
    ctx.globalAlpha = Math.min(1, 0.22 + E * 0.25);
    ctx.drawImage(hazeSprite, cx - s / 2, cy - s / 2, s, s);
    ctx.globalAlpha = 1;
  }

  function drawShell(rad, E, baseYaw, tilt, dt) {
    for (const b of buckets) b.length = 0;
    const trailK = 0.6 + S.spin * 1.6;
    const chaos = S.chaos;
    const hot = [];
    const step = quality < 1 ? Math.round(1 / quality) : 1;
    for (let l = 0; l < 3; l++) {
      const a1 = baseYaw * LAYER_SPEED[l] + l * 2.1;
      const dir = Math.sign(LAYER_SPEED[l]);
      setRot(a1, tilt);
      for (let i = 0; i < shell.length; i++) {
        const p = shell[i];
        if (p.layer !== l) continue;
        if (!p.bright && step > 1 && i % step) continue;
        const wob = Math.sin(t * p.w + p.ph);
        const r = rad * (p.r + wob * 0.012 + chaos * 0.09 * Math.sin(t * 9 + p.ph * 3) * (p.bright ? 1 : 0.5));
        const A = proj(p.x, p.y, p.z, r); const x0 = A.x, y0 = A.y, z0 = A.z;
        // trail end = same point rotated back by a small angle (small-angle sin/cos)
        const d = p.trail * trailK * dir, cd = 1 - d * d / 2;
        const B = proj(p.x * cd - p.z * d, p.y, p.x * d + p.z * cd, r);
        const bi = Math.min(NB - 1, Math.max(0, ((z0 + 1) / 2 * NB) | 0)) + (p.bright ? NB : 0);
        buckets[bi].push(x0, y0, B.x, B.y);
        if (p.hot && z0 > -0.2) hot.push(x0, y0, z0);
      }
    }
    for (let bi = 0; bi < buckets.length; bi++) {
      const arr = buckets[bi];
      if (!arr.length) continue;
      const bright = bi >= NB, d = (bi % NB) / (NB - 1);
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 4) { ctx.moveTo(arr[i], arr[i + 1]); ctx.lineTo(arr[i + 2], arr[i + 3]); }
      ctx.lineWidth = (bright ? 1.1 : 0.7) * dpr * (0.6 + d * 0.9);
      ctx.strokeStyle = col(bright ? 52 + d * 18 : 45 + d * 10, (bright ? 0.25 : 0.1) * (0.25 + d * 0.95) * (0.55 + E));
      ctx.stroke();
    }
    for (let i = 0; i < hot.length; i += 3) {
      const s = (3 + hot[i + 2] * 3 + S.lvl * 6) * dpr;
      ctx.globalAlpha = Math.min(1, 0.35 + E * 0.5);
      ctx.drawImage(dotSprite, hot[i] - s, hot[i + 1] - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;
  }

  function drawArcs(rad, E, dt) {
    const lv = S.lvl;
    const spinBoost = 1 + (mode === 'thinking' ? 2.5 : 0) + lv * 2;
    for (const a of arcs) {
      a.a += a.spd * dt * spinBoost;
      const r = rad * (a.r + lv * 0.07 * Math.sin(a.ph + t * 6));
      ctx.lineWidth = a.w * dpr;
      ctx.strokeStyle = col(55 + a.al * 20, a.al * (0.35 + E * 0.7) * Math.min(1, boot * 1.5));
      if (a.dash) ctx.setLineDash([2 * dpr, 5 * dpr]);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, r), a.a, a.a + a.len);
      ctx.stroke();
      if (a.dash) ctx.setLineDash([]);
    }
    ctx.beginPath();
    for (const k of ticks) {
      k.a += k.spd * dt * spinBoost;
      const r0 = rad * k.r, r1 = rad * (k.r + k.l * (1 + lv * 2));
      const c = Math.cos(k.a), s = Math.sin(k.a);
      ctx.moveTo(cx + c * r0, cy + s * r0); ctx.lineTo(cx + c * r1, cy + s * r1);
    }
    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeStyle = col(62, 0.35 * (0.4 + E));
    ctx.stroke();
  }

  function drawOrbits(rad, E, baseYaw, tilt) {
    setRot(baseYaw * 0.8, tilt);
    for (const o of orbits) {
      const head = o.ph + t * o.spd * S.orbit;
      const N = 34;
      let px = null, py = null;
      for (let i = 0; i <= N; i++) {
        const th = head - Math.sign(o.spd) * (i / N) * o.tail;
        const c = Math.cos(th) * o.r, s = Math.sin(th) * o.r;
        const p = proj(o.U[0] * c + o.V[0] * s, o.U[1] * c + o.V[1] * s, o.U[2] * c + o.V[2] * s, rad);
        if (px !== null) {
          const f = 1 - i / N;
          ctx.strokeStyle = col(60 + f * 25, f * f * (0.5 + E * 0.6) * ((p.z + 1.4) / 2.4));
          ctx.lineWidth = (0.6 + f * 2.2) * dpr;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(p.x, p.y); ctx.stroke();
        } else {
          const s2 = (5 + E * 6) * dpr;
          ctx.drawImage(dotSprite, p.x - s2, p.y - s2, s2 * 2, s2 * 2);
        }
        px = p.x; py = p.y;
      }
    }
  }

  function drawCore(rad, E, baseYaw, tilt) {
    const lv = S.lvl;
    const thinkPulse = mode === 'thinking' ? 0.12 * Math.sin(t * 14) : 0;
    const cs = rad * (0.5 + lv * 0.5 + thinkPulse + flash * 0.3);
    ctx.globalAlpha = Math.min(1, 0.32 + E * 0.4);
    ctx.drawImage(coreSprite, cx - cs, cy - cs, cs * 2, cs * 2);
    ctx.globalAlpha = 1;
    for (const kn of knots) {
      setRot(baseYaw * 2 + t * kn.spd + kn.ph, tilt + kn.tilt);
      const sc = rad * kn.s * (1 + lv * 0.35 + thinkPulse);
      ctx.beginPath();
      for (let i = 0; i <= 90; i++) {
        const th = (i / 90) * TAU;
        const rr = (Math.cos(kn.q * th) + 2) / 3;
        const p = proj(rr * Math.cos(kn.p * th), -Math.sin(kn.q * th) / 3, rr * Math.sin(kn.p * th), sc);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      }
      ctx.lineWidth = 1.1 * dpr;
      ctx.strokeStyle = col(70, 0.2 + E * 0.25);
      ctx.stroke();
    }
    const hs = rad * (0.1 + lv * 0.16);
    ctx.globalAlpha = Math.min(1, 0.55 + lv);
    ctx.drawImage(dotSprite, cx - hs, cy - hs, hs * 2, hs * 2);
    ctx.globalAlpha = 1;
  }

  function drawSparks(rad, E, dt, baseYaw, tilt) {
    const rate = mode === 'speaking' ? S.lvl * 70 : mode === 'thinking' ? 10 : 2;
    let n = rate * dt + (Math.random() < (rate * dt) % 1 ? 1 : 0);
    while (n-- >= 1 && sparks.length < 260) {
      const [x, y, z] = unitVec();
      sparks.push({ x, y, z, d: 0.15, v: rnd(0.5, 1.5) * (1 + S.lvl), life: rnd(0.5, 1.1), age: 0 });
    }
    setRot(baseYaw, tilt);
    ctx.beginPath();
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.age += dt; s.d += s.v * dt;
      if (s.age > s.life || s.d > 1.6) { sparks.splice(i, 1); continue; }
      const a = proj(s.x, s.y, s.z, rad * s.d); const ax = a.x, ay = a.y;
      const b = proj(s.x, s.y, s.z, rad * Math.max(0, s.d - 0.06 * s.v));
      ctx.moveTo(ax, ay); ctx.lineTo(b.x, b.y);
    }
    ctx.lineWidth = 1.3 * dpr;
    ctx.strokeStyle = col(70, 0.5 + E * 0.3);
    ctx.stroke();
  }

  function drawWave(rad) {
    if (S.wave < 0.02 || !spectrum) return;
    const n = 64, r0 = rad * 1.24;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const bin = Math.floor(2 + (i / n) * Math.min(spectrum.length - 2, 90));
      const v = spectrum[bin] / 255;
      const len = (2 + v * v * rad * 0.22) * S.wave;
      for (const side of [1, -1]) {
        const ang = -Math.PI / 2 + side * (i + 0.5) / n * Math.PI;
        const c = Math.cos(ang), s = Math.sin(ang);
        ctx.moveTo(cx + c * r0, cy + s * r0); ctx.lineTo(cx + c * (r0 + len), cy + s * (r0 + len));
      }
    }
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = col(62, 0.55 * S.wave);
    ctx.stroke();
  }

  function drawHud(rad, E) {
    const r1 = R * 1.36, r2 = R * 1.43, r3 = R * 1.55;
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = `rgba(150,140,130,${0.05 * boot})`;
    ctx.beginPath(); ctx.arc(cx, cy, r1, 0, TAU); ctx.stroke();
    // rotating tick ring
    const rot = t * 0.05;
    ctx.beginPath();
    for (let i = 0; i < 120; i++) {
      const a = rot + (i / 120) * TAU, long = i % 10 === 0;
      const c = Math.cos(a), s = Math.sin(a);
      ctx.moveTo(cx + c * r2, cy + s * r2); ctx.lineTo(cx + c * (r2 + (long ? 9 : 4) * dpr), cy + s * (r2 + (long ? 9 : 4) * dpr));
    }
    ctx.strokeStyle = col(55, 0.07 * boot * (0.6 + E * 0.4));
    ctx.stroke();
    // counter-rotating segment ring
    ctx.lineWidth = 2 * dpr;
    for (let i = 0; i < 3; i++) {
      const a = -t * 0.09 + i * TAU / 3;
      ctx.strokeStyle = col(55, 0.09 * boot);
      ctx.beginPath(); ctx.arc(cx, cy, r3, a, a + 0.75); ctx.stroke();
    }
  }

  // ---------- sizing & input
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = canvas.width = Math.floor(innerWidth * dpr);
    H = canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    // fit the reactor between the header and the subtitle/command area
    const narrow = innerWidth < 760;
    const top = 96, bottom = narrow ? 170 : 185;
    const avail = Math.max(160, innerHeight - top - bottom);
    cx = W / 2;
    cy = (top + avail / 2) * dpr;
    R = Math.min(innerWidth * (narrow ? 0.3 : 0.26), avail / 2 / 1.3) * dpr;
    const root = document.documentElement.style;
    root.setProperty('--orb-x', cx / dpr + 'px');
    root.setProperty('--orb-y', cy / dpr + 'px');
    root.setProperty('--orb-r', R / dpr + 'px');
  }
  addEventListener('resize', resize);
  addEventListener('mousemove', e => {
    mouseX = (e.clientX / innerWidth - 0.5) * 2;
    mouseY = (e.clientY / innerHeight - 0.5) * 2;
  });
  resize();
  requestAnimationFrame(frame);

  return {
    setMode(m) { if (m !== mode) { mode = m; if (m === 'boot') boot = 0; } },
    getMode() { return mode; },
    setLevel(v) { level = Math.max(0, Math.min(1, v || 0)); },
    setSpectrum(arr) { spectrum = arr; },
    setEmotion(e) { emotion = EMO[e] ? e : 'neutral'; },
    pulse() { flash = 1; },
    hit(x, y) { return Math.hypot(x * dpr - cx, y * dpr - cy) < R * 1.15; },
  };
})();
