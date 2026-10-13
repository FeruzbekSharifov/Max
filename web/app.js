// MAX front-end: boot sequence, ears (speech recognition), mouth (neural voice + reactive orb),
// HUD telemetry, timers and settings. The thinking itself lives in brain.js.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const App = { config: {}, context: {}, memory: {}, state: 'boot', serverDown: 0, lastActive: Date.now() };

// ------------------------------------------------------------------ sound graph
const Sound = {
  ctx: null, out: null, analyser: null, freq: null, time: null, mic: null, micFreq: null, micTime: null, micOk: false,
  init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.55;
    this.out = this.ctx.createGain();
    this.out.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.time = new Uint8Array(this.analyser.fftSize);
  },
  async initMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.mic = this.ctx.createAnalyser();
      this.mic.fftSize = 512;
      this.mic.smoothingTimeConstant = 0.6;
      this.ctx.createMediaStreamSource(stream).connect(this.mic);
      this.micFreq = new Uint8Array(this.mic.frequencyBinCount);
      this.micTime = new Uint8Array(this.mic.fftSize);
      this.micOk = true;
    } catch (e) { this.micOk = false; }
    return this.micOk;
  },
  rms(an, buf) {
    an.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / buf.length);
  },
  blip(freqs, dur = 0.09, vol = 0.06, type = 'sine') {
    if (!this.ctx) return;
    let t = this.ctx.currentTime;
    for (const f of freqs) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
      t += dur * 0.8;
    }
  },
  chimeUp() { this.blip([660, 990], 0.08, 0.05); },
  chimeDown() { this.blip([700, 440], 0.08, 0.04); },
  alarm() { this.blip([880, 1175, 880, 1175, 1568], 0.14, 0.07, 'triangle'); },
};

// ------------------------------------------------------------------ subtitles + log
const Subs = {
  maxWords: [],
  showUser(text, interim = false) {
    const el = $('#subUser');
    el.querySelector('.txt').textContent = text;
    el.classList.toggle('interim', interim);
    el.classList.add('show');
  },
  showMax(text) {
    const el = $('#subMax .txt');
    el.innerHTML = '';
    this.maxWords = [];
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const s = document.createElement('span');
      s.textContent = w + ' ';
      el.appendChild(s);
      this.maxWords.push(s);
    }
    $('#subMax').classList.add('show');
  },
  highlight(k) { this.maxWords.forEach((s, i) => s.classList.toggle('on', i < k)); },
};

function log(text, kind = '') {
  const top = $('#logList').firstElementChild;
  if (top && top.dataset.text === text) {   // collapse repeats into "×N"
    top.dataset.n = Number(top.dataset.n || 1) + 1;
    top.querySelector('time').textContent = `${new Date().toLocaleTimeString('en-GB')} ×${top.dataset.n}`;
    return;
  }
  const li = document.createElement('li');
  li.dataset.text = text;
  li.className = kind;
  li.innerHTML = `<time>${new Date().toLocaleTimeString('en-GB')}</time>${esc(text)}`;
  const list = $('#logList');
  list.prepend(li);
  while (list.children.length > 9) list.lastChild.remove();
}

// ------------------------------------------------------------------ mouth (voice output)
// Note: Max never changes speaking rate/pitch per emotion. Any prosody change makes the voice service
// take 1-3 s longer to start (measured), while Brian's natural delivery already carries the emotion
// from the wording itself. Emotion shows in the words, punctuation and the core's colour.

function cleanForSpeech(t) {
  return String(t || '')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[*_#`~>|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const countWords = s => s.trim().split(/\s+/).filter(Boolean).length;
const MP3_BYTES_PER_SEC = 6000;   // the voice service sends 48 kbit/s MP3

// The voice service needs ~1 s + ~0.1 s per word before the first sound of a new sentence (measured),
// so replies are spoken in growing pieces: a short opener (it starts ~1.2 s after the reply arrives),
// then bigger pieces that are synthesized while the previous one is playing. Cuts fall on punctuation.
const CHUNK_WORDS = [7, 12, 22];
const SOFT_BREAK = /^(and|but|so|because|which|that|while|when|if|or|to|with|for|since|then)$/i;
function splitForSpeech(text) {
  const phrases = (text.match(/[^,;:.!?—]+[,;:.!?—]+["')\]]*\s*|[^,;:.!?—]+$/g) || [text])
    .map(s => s.trim()).filter(Boolean);
  const out = [];
  let cur = [];
  const limit = () => CHUNK_WORDS[Math.min(out.length, CHUNK_WORDS.length - 1)];
  const close = () => { if (cur.length) { out.push(cur.join(' ')); cur = []; } };
  for (const ph of phrases) {
    let w = ph.split(/\s+/).filter(Boolean);
    while (w.length) {
      const room = limit() - cur.length;
      const slack = out.length ? 5 : 1;   // the opener must stay short: it decides when Max starts talking
      if (w.length <= room || (!cur.length && w.length <= room + slack)) { cur.push(...w); w = []; }
      else if (cur.length) close();
      else {
        // one long phrase: cut before a joining word ("... and", "... so") if there is one, else at the limit
        let cut = room;
        for (let i = Math.min(room, w.length - 1); i >= 3; i--) if (SOFT_BREAK.test(w[i])) { cut = i; break; }
        cur.push(...w.slice(0, cut)); w = w.slice(cut); close();
      }
    }
    if (!out.length && cur.length >= 3) close();   // end the opener at the first natural pause
  }
  close();
  return out.length ? out : [text];
}

// Max has exactly one voice (Brian, set on the server). If the voice service doesn't answer,
// Max shows the text instead of switching to some other voice.
const Mouth = {
  queue: [], busy: false, current: null, stopped: false, pending: [],
  say(text, emotion = 'neutral') {
    text = cleanForSpeech(text);
    if (!text) return Promise.resolve();
    return new Promise(res => { this.queue.push({ text, emotion, res }); this.pump(); });
  },
  async pump() {
    if (this.busy) return;
    const item = this.queue.shift();
    if (!item) { this.finished(); return; }
    this.busy = true;
    this.stopped = false;
    try {
      Ears.pause();
      App.setEmotion(item.emotion);
      Subs.showMax(item.text);
      log(`MAX ▸ ${item.text}`, 'max');
      const parts = splitForSpeech(item.text);
      // each piece is requested once the previous one's audio starts arriving: requests running side by side
      // slow each other down, and the previous piece's playback leaves time to synthesize the next
      const streams = [this.stream(parts[0])];
      for (let i = 1; i < parts.length; i++) streams.push(streams[i - 1].then(s => s && s.firstByte).then(() => this.stream(parts[i])));
      let offset = 0, failed = false;
      for (let i = 0; i < parts.length && !this.stopped; i++) {
        let ok = await this.play(await streams[i], parts[i], offset);
        if (!ok && !this.stopped) ok = await this.play(await this.stream(parts[i]), parts[i], offset);
        if (!ok) failed = true;
        offset += countWords(parts[i]);
      }
      if (failed && !this.stopped) log('VOICE: the voice service did not answer - reply shown as text', 'err');
      Subs.highlight(1e9);
    } catch (e) {
      log(`VOICE ERROR: ${e.message}`, 'err');
    } finally {   // whatever happens, never leave Max stuck "speaking"
      this.pending.splice(0).forEach(s => this.discard(s));
      this.current = null;
      item.res();
      this.busy = false;
      this.pump();
    }
  },
  // Starts synthesizing right away and feeds the MP3 bytes into a MediaSource as they arrive
  // (a plain <audio src> would wait for the whole file).
  async stream(text) {
    if (!window.MediaSource || !MediaSource.isTypeSupported('audio/mpeg')) return null;
    let r;
    try { r = await api('tts/prepare', { text }); } catch (e) { return null; }
    if (!r.ok) return null;
    const ms = new MediaSource();
    const el = new Audio();
    el.src = URL.createObjectURL(ms);
    Sound.ctx.createMediaElementSource(el).connect(Sound.out);
    const s = {
      el, ctrl: new AbortController(), url: el.src, bytes: 0, firstAt: 0, ended: false,
      expected: Math.max(1.2, countWords(text) * 0.36) * MP3_BYTES_PER_SEC,
    };
    s.firstByte = new Promise(resolve => { s.gotFirstByte = resolve; });
    // Ready = enough audio buffered that playback won't stall while the rest downloads.
    s.ready = new Promise(resolve => {
      const iv = setInterval(() => s.check(), 100);
      s.check = () => {
        if (s.isReady) return;
        let go = null;
        if (s.ended) go = s.bytes > 0;
        else if (s.bytes) {
          const t = (performance.now() - s.firstAt) / 1000;
          const buffered = s.bytes / MP3_BYTES_PER_SEC;
          const left = Math.max(0, s.expected - s.bytes) / (s.bytes / Math.max(t, 0.05));
          if ((t >= 0.25 && left <= buffered * 0.85) || t >= 2.5) go = true;
        }
        if (go === null) return;
        s.isReady = true;
        clearInterval(iv);
        resolve(go);
      };
    });
    this.pending.push(s);
    ms.addEventListener('sourceopen', async () => {
      const sb = ms.addSourceBuffer('audio/mpeg');
      const queue = [];
      const feed = () => {
        if (sb.updating || ms.readyState !== 'open') return;
        if (queue.length) { try { sb.appendBuffer(queue.shift()); } catch (e) { } }
        else if (s.ended) { try { ms.endOfStream(); } catch (e) { } }
      };
      sb.addEventListener('updateend', feed);
      try {
        const resp = await fetch('/api/tts/stream?id=' + r.id, { signal: s.ctrl.signal });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            if (!s.bytes) { s.firstAt = performance.now(); s.gotFirstByte(); }
            s.bytes += value.length;
            queue.push(value);
            feed();
            s.check();
          }
        }
      } catch (e) { }
      s.ended = true;
      s.gotFirstByte();
      s.check();
      feed();
    }, { once: true });
    return s;
  },
  discard(s) {
    if (!s) return;
    try { s.ctrl.abort(); } catch (e) { }
    s.el.pause();
    URL.revokeObjectURL(s.url);
  },
  play(s, text, offset = 0) {
    return new Promise(async res => {
      if (!s || this.stopped) return res(false);
      const ready = await Promise.race([s.ready, sleep(9000).then(() => false)]);
      if (!ready || this.stopped) { this.discard(s); return res(false); }
      let started = false, done = false, startTimer = null, watchdog = null;
      const finish = ok => {
        if (done) return;
        done = true;
        clearTimeout(startTimer);
        clearTimeout(watchdog);
        this.current = null;
        res(ok);
      };
      startTimer = setTimeout(() => { if (!started) { this.discard(s); finish(false); } }, 4000);
      s.el.onplaying = () => {
        if (started) return;
        started = true;
        clearTimeout(startTimer);
        App.setState('speaking');
        const est = s.expected / MP3_BYTES_PER_SEC;
        this.current = { el: s.el, n: countWords(text), offset, est };
        // never hang: give up if the audio hasn't ended long after its expected length
        watchdog = setTimeout(() => { this.discard(s); finish(true); }, (est * 2 + 10) * 1000);
      };
      s.el.onended = () => finish(true);
      s.el.onerror = () => finish(started);
      s.el.play().catch(() => finish(started));
    });
  },
  tick() {
    const c = this.current;
    if (!c) return;
    const d = isFinite(c.el.duration) && c.el.duration > 0 ? c.el.duration : c.est;
    Subs.highlight(c.offset + Math.round(Math.min(1, c.el.currentTime / d) * c.n));
  },
  stop() {
    this.stopped = true;
    this.queue.splice(0).forEach(q => q.res());
    if (this.current) { const el = this.current.el; el.pause(); el.dispatchEvent(new Event('ended')); }
    this.pending.forEach(s => this.discard(s));
  },
  get speaking() { return this.busy; },
  finished() {
    if (App.state === 'speaking' || App.state === 'thinking') App.setState('idle');
    Ears.resume(true);
  },
};

// ------------------------------------------------------------------ ears (speech recognition)
const WAKE_ANY = /\b(max|maks|macs|mack|maxx)\b/i;
const WAKE_LEAD = /^\s*(?:hey|hi|okay|ok|yo|so)?[\s,]*(?:max|maks|macs|mack|maxx)\b[\s,.!?:]*/i;
const WAKE_TAIL = /[\s,]+(?:max|maks|macs|mack|maxx)[\s.!?]*$/i;

const Ears = {
  rec: null, want: false, running: false, paused: false, active: false, activeUntil: 0, followUntil: 0, backoff: 250, warmed: false,
  supported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  init() {
    if (!this.supported) { log('Speech recognition not supported in this browser - type instead', 'err'); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = this.rec = new SR();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onstart = () => { this.running = true; this.backoff = 250; App.updateMic(); };
    r.onend = () => {
      this.running = false;
      App.updateMic();
      if (!this.paused && (this.want || this.engaged())) setTimeout(() => this.start(), this.backoff);
      else if (App.state === 'listening') App.setState('idle');
    };
    r.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.want = false;
        this.blocked = true;
        this.active = false;
        this.followUntil = 0;
        log('Microphone blocked - allow it via the icon in the title bar, then reopen Max', 'err');
        App.setState('idle');
      } else if (e.error === 'network') this.backoff = 3000;
      else if (e.error === 'audio-capture') { this.backoff = 5000; log('No microphone found', 'err'); }
    };
    r.onresult = e => this.onResult(e);
    setInterval(() => {   // close the follow-up window when nobody speaks
      if (this.running && !this.want && !this.engaged() && !Mouth.speaking && App.state !== 'thinking') { try { this.rec.stop(); } catch (e) { } }
      if (App.state === 'listening' && !this.engaged() && !this.running) App.setState('idle');
    }, 1000);
  },
  engaged() { const n = Date.now(); return (this.active && n < this.activeUntil) || n < this.followUntil; },
  start() {
    if (!this.rec || this.running || this.paused || this.blocked) return;
    try { this.rec.start(); } catch (e) { }
  },
  enable(on) {
    this.want = on;
    if (on) this.start();
    else if (this.running && !this.engaged()) { try { this.rec.abort(); } catch (e) { } }
    App.updateMic();
  },
  pause() {
    this.paused = true;
    if (this.running) { try { this.rec.abort(); } catch (e) { } }
  },
  resume(followUp) {
    this.paused = false;
    if (followUp && this.supported && Sound.micOk) this.followUntil = Date.now() + 7000;
    if (this.want || this.engaged()) this.start();
  },
  listenNow() {
    if (!this.supported || this.blocked || !Sound.micOk) {
      log('No microphone access - type your command instead', 'err');
      $('#cmdInput').focus();
      return;
    }
    Mouth.stop();
    this.paused = false;
    this.active = true;
    this.activeUntil = Date.now() + 9000;
    Sound.chimeUp();
    Orb.pulse();
    App.setState('listening');
    Subs.showUser('listening...', true);
    prewarmVoice();
    if (!this.running) this.start();
  },
  onResult(e) {
    let interim = '';
    const finals = [];
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finals.push(res[0].transcript); else interim += res[0].transcript;
    }
    if (interim.trim()) {
      const wake = WAKE_ANY.test(interim);
      if (this.engaged() || wake) {
        if (App.state !== 'listening' && App.state !== 'thinking') { App.setState('listening'); if (!this.engaged()) Orb.pulse(); }
        Subs.showUser(interim.replace(WAKE_LEAD, '') || interim, true);
        if (!this.warmed) { prewarmVoice(); this.warmed = true; }
        if (this.active) this.activeUntil = Date.now() + 9000;
      }
    }
    for (const f of finals) this.onFinal(f.trim());
  },
  onFinal(text) {
    if (!text) return;
    this.warmed = false;
    let cmd;
    if (this.engaged()) cmd = text.replace(WAKE_LEAD, '').trim();
    else if (WAKE_ANY.test(text)) cmd = text.replace(WAKE_LEAD, '').replace(WAKE_TAIL, '').trim();
    else { if (App.state === 'listening') App.setState('idle'); return; }   // background talk, ignore
    if (cmd.length < 2) {   // just "Max" -> wait for the actual request
      this.active = true;
      this.activeUntil = Date.now() + 8000;
      Sound.chimeUp();
      Orb.pulse();
      App.setState('listening');
      Subs.showUser('listening...', true);
      return;
    }
    this.active = false;
    this.followUntil = 0;
    App.handleUserText(cmd, 'voice');
  },
};

// Two parallel calls fill the server's pool of two warm voice connections.
// Tells the server someone is about to talk; it then keeps its warm voice connections topped up.
let lastPrewarm = 0;
function prewarmVoice() {
  if (Date.now() - lastPrewarm < 3000) return;
  lastPrewarm = Date.now();
  api('tts/prewarm', {}).catch(() => { });
}

// ------------------------------------------------------------------ timers & reminders (kept in this browser profile)
const Timers = {
  list: [],
  load() { try { this.list = JSON.parse(localStorage.getItem('max.timers') || '[]'); } catch (e) { this.list = []; } this.render(); },
  save() { try { localStorage.setItem('max.timers', JSON.stringify(this.list)); } catch (e) { } this.render(); },
  add(kind, due, label) {
    const t = { id: Math.random().toString(36).slice(2, 8), kind, due, label: label || '' };
    this.list.push(t);
    this.save();
    return t;
  },
  cancel(label) {
    const before = this.list.length;
    const q = String(label || '').toLowerCase();
    this.list = q ? this.list.filter(t => !t.label.toLowerCase().includes(q)) : this.list.slice(0, -1);
    this.save();
    return before - this.list.length;
  },
  describe() {
    if (!this.list.length) return '';
    return this.list.map(t => `${t.kind} "${t.label || 'unnamed'}" at ${new Date(t.due).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`).join('; ');
  },
  check() {
    const now = Date.now();
    const due = this.list.filter(t => t.due <= now);
    if (!due.length) { this.render(); return; }
    this.list = this.list.filter(t => t.due > now);
    this.save();
    for (const t of due) {
      Sound.alarm();
      const a = Brain.addr();
      const lines = t.kind === 'timer'
        ? [`Ding! ${t.label ? `Your ${t.label} timer` : 'Your timer'} is done, ${a}.`, `Time's up${t.label ? ` for ${t.label}` : ''}!`]
        : [`Hey ${a}, you asked me to remind you: ${t.label}.`, `Quick reminder, ${a}: ${t.label}.`];
      log(`${t.kind.toUpperCase()} ▸ ${t.label || 'done'}`, 'warn');
      Mouth.say(lines[Math.floor(Math.random() * lines.length)], 'happy');
      flashTitle();
    }
  },
  render() {
    const box = $('#timers');
    if (!box) return;
    box.innerHTML = this.list.map(t => {
      const s = Math.max(0, Math.round((t.due - Date.now()) / 1000));
      const left = s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      return `<div class="kv"><span>${t.kind === 'timer' ? 'TIMER' : 'REMIND'} ${esc(t.label || '').toUpperCase().slice(0, 16)}</span><b>${left}</b></div>`;
    }).join('');
  },
};
window.Timers = Timers;

function flashTitle() {
  let n = 0;
  const iv = setInterval(() => { document.title = n % 2 ? 'MAX' : '● MAX - ALERT'; if (++n > 9) { clearInterval(iv); document.title = 'MAX'; } }, 700);
}

function safeCalc(expr) {
  let e = String(expr || '').toLowerCase().replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/\^/g, '**').replace(/,/g, '');
  e = e.replace(/(\d+(?:\.\d+)?)%of/g, '($1/100)*').replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
  if (!/^[\d+\-*/().a-z]*$/.test(e)) throw new Error('unsupported characters');
  const words = e.match(/[a-z]+/g) || [];
  const ok = { sqrt: 'Math.sqrt', sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan', log: 'Math.log10', ln: 'Math.log', abs: 'Math.abs', round: 'Math.round', floor: 'Math.floor', ceil: 'Math.ceil', pi: 'Math.PI', e: 'Math.E' };
  if (words.some(w => !(w in ok))) throw new Error('unknown function');
  e = e.replace(/[a-z]+/g, w => ok[w]);
  const v = Function(`"use strict"; return (${e});`)();
  if (typeof v !== 'number' || !isFinite(v)) throw new Error('not a number');
  return Math.round(v * 1e10) / 1e10;
}

// Tools that live in the page; everything else goes to the server.
const LocalTools = {
  calculate: a => { try { return { ok: true, info: true, result: `${a.expression} = ${safeCalc(a.expression)}` }; } catch (e) { return { ok: false, info: true, result: `Can't calculate that: ${e.message}` }; } },
  set_timer: a => {
    const s = Math.round(Number(a.seconds) || 0);
    if (s <= 0) return { ok: false, result: 'Timer needs a positive number of seconds.' };
    Timers.add('timer', Date.now() + s * 1000, a.label);
    return { ok: true, result: `Timer set for ${s} seconds.` };
  },
  set_reminder: a => {
    let due = null;
    if (a.in_minutes) due = Date.now() + Number(a.in_minutes) * 60000;
    else if (a.at) {
      const m = String(a.at).match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/i);
      if (m) {
        let h = Number(m[1]) % 24;
        if (m[3] && m[3].toLowerCase() === 'pm' && h < 12) h += 12;
        if (m[3] && m[3].toLowerCase() === 'am' && h === 12) h = 0;
        const d = new Date(); d.setHours(h, Number(m[2]), 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        due = d.getTime();
      }
    }
    if (!due || isNaN(due)) return { ok: false, result: 'I need either in_minutes or a time like 18:30.' };
    Timers.add('reminder', due, a.text || 'something');
    return { ok: true, result: `Reminder set for ${new Date(due).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` };
  },
  list_timers: () => ({ ok: true, info: true, result: Timers.describe() || 'No active timers or reminders.' }),
  cancel_timer: a => { const n = Timers.cancel(a.label); return { ok: n > 0, result: n ? `Cancelled ${n}.` : 'No matching timer.' }; },
  forget: async a => {
    const r = await api('memory', { action: 'forget', text: a.fact || a.text || '' });
    if (r.changed) await refreshMemory();
    return { ok: r.changed > 0, result: r.changed ? `Forgot ${r.changed} fact(s).` : 'Nothing matching in my notes.' };
  },
  exit_max: () => { setTimeout(quitMax, 2800); return { ok: true, result: 'Shutting down Max in a moment.' }; },
};

async function runTool(name, args) {
  if (LocalTools[name]) return LocalTools[name](args || {});
  try { return await api('tool', { name, args: args || {} }); }
  catch (e) { return { ok: false, result: 'Max server unreachable.' }; }
}

const io = {
  say: (text, emotion) => { if (text) Mouth.say(text, emotion); },
  log,
  state: s => App.setState(s),
  tool: runTool,
  link: (provider, model) => { $('#link').textContent = `${String(provider || '').toUpperCase()} · ${model || ''}`; },
  memoryChanged: () => updateMemCount(),
};

// ------------------------------------------------------------------ app state & UI
const STATE_LABEL = { boot: 'BOOTING', idle: 'STANDBY', listening: 'LISTENING', thinking: 'PROCESSING', speaking: 'SPEAKING', offline: 'CORE OFFLINE' };

App.setState = function (s) {
  if (App.state === 'offline' && s !== 'offline' && App.serverDown) return;
  App.state = s;
  Orb.setMode(s === 'boot' ? 'boot' : s);
  $('#state').textContent = STATE_LABEL[s] || s.toUpperCase();
  document.body.dataset.state = s;
};
App.setEmotion = function (e) {
  Orb.setEmotion(e);
  $('#emo').textContent = String(e || 'neutral').toUpperCase();
};
App.updateMic = function () {
  $('#micBtn').classList.toggle('on', Ears.running);
  $('#micBtn').textContent = !Ears.supported ? 'NO MIC API' : !Sound.micOk ? 'MIC BLOCKED' : Ears.running ? 'MIC LIVE' : 'MIC IDLE';
  $('#wakeBtn').classList.toggle('on', Ears.want);
};

App.handleUserText = async function (text, source) {
  text = String(text || '').trim();
  if (!text) return;
  App.lastActive = Date.now();
  if (Mouth.speaking) Mouth.stop();
  Subs.showUser(text);
  log(`YOU ▸ ${text}`, 'you');
  App.setState('thinking');
  prewarmVoice();
  try { await Brain.respond(text, io); }
  catch (e) { log(`ERROR ${e.message}`, 'err'); io.say('Hmm, something glitched on my side. Try that once more?', 'concerned'); }
  if (!Mouth.speaking && App.state === 'thinking') App.setState('idle');
};

function frameLoop() {
  let lvl = 0, spec = null;
  if (Mouth.current) {
    lvl = Math.min(1, Sound.rms(Sound.analyser, Sound.time) * 3.4);
    Sound.analyser.getByteFrequencyData(Sound.freq);
    spec = Sound.freq;
  } else if (App.state === 'listening' && Sound.micOk) {
    lvl = Math.min(1, Sound.rms(Sound.mic, Sound.micTime) * 5);
    Sound.mic.getByteFrequencyData(Sound.micFreq);
    spec = Sound.micFreq;
  }
  Orb.setLevel(lvl);
  Orb.setSpectrum(spec);
  Mouth.tick();
  requestAnimationFrame(frameLoop);
}

function meter(key, val, text) {
  const m = $(`.meter[data-k="${key}"]`);
  if (!m) return;
  m.querySelector('i').style.width = (val == null ? 0 : Math.max(0, Math.min(100, val))) + '%';
  m.querySelector('b').textContent = text;
  m.classList.toggle('hot', val != null && val > 85 && key !== 'bat' && key !== 'vol');
}

async function pollStats() {
  try {
    const s = await api('stats');
    if (App.serverDown) { App.serverDown = 0; App.setState('idle'); log('Core link restored', 'ok'); }
    meter('cpu', s.cpu, s.cpu + '%');
    meter('ram', s.ram, `${s.ram}% / ${s.ram_total_gb}G`);
    meter('disk', s.disk_used, `${s.disk_free_gb}G FREE`);
    meter('bat', s.battery, s.battery == null ? 'AC POWER' : `${s.battery}%${s.charging ? ' ⚡' : ''}`);
    meter('vol', s.muted ? 0 : s.volume, s.volume == null ? '--' : s.muted ? 'MUTED' : s.volume + '%');
    $('#uptime').textContent = s.uptime_h + ' H';
    $('#procs').textContent = s.processes;
    if (s.muted && !App.warnedMute) {
      App.warnedMute = true;
      log('Windows sound is MUTED - say or type "unmute" to hear Max', 'warn');
      Subs.showUser('Your PC sound is muted - type "unmute" to hear Max.', true);
    }
  } catch (e) {
    if (++App.serverDown >= 2) { App.state = 'offline'; App.setState('offline'); }
  }
}

function tickClock() {
  const d = new Date();
  $('#time').textContent = d.toLocaleTimeString('en-GB');
  $('#date').textContent = d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
}

function updateMemCount() {
  $('#memCount').textContent = `${Brain.memoryCount()} ENTRIES`;
}

async function refreshMemory() {
  try { App.memory = await api('memory'); Brain.setMemory(App.memory); updateMemCount(); } catch (e) { }
}

function applyConfig(cfg) {
  App.config = cfg;
  Brain.setConfig(cfg);
  const p = cfg.active_provider || 'offline';
  $('#link').textContent = p.toUpperCase() + (cfg.model ? ' · ' + cfg.model : '');
  $('#banner').hidden = p !== 'offline';
  $('#brandLink').textContent = p === 'offline' ? 'BASIC MODE' : 'ONLINE';
}

async function quitMax() {
  log('Shutting down...', 'warn');
  try { await api('quit', {}); } catch (e) { }
  App.setState('offline');
  setTimeout(() => window.close(), 400);
}

// ------------------------------------------------------------------ settings drawer
function openSettings() {
  const c = App.config;
  $('#sProvider').value = c.provider || 'auto';
  $('#sGroq').value = ''; $('#sGroq').placeholder = c.groq_key || 'gsk_...';
  $('#sGemini').value = ''; $('#sGemini').placeholder = c.gemini_key || 'AIza...';
  $('#sOpenrouter').value = ''; $('#sOpenrouter').placeholder = c.openrouter_key || 'sk-or-...';
  $('#sModel').value = c.model || '';
  $('#sOllama').value = c.ollama_url || '';
  $('#sName').value = c.user_name || '';
  $('#sAddress').value = c.address_as || '';
  $('#sCity').value = c.city || '';
  $('#sWake').checked = !!c.wake_word;
  $('#sClaude').checked = !!c.use_claude_memory;
  $('#sAbout').value = App.memory.about || '';
  renderFacts();
  $('#settings').classList.add('open');
  $('#settings').setAttribute('aria-hidden', 'false');
}
function closeSettings() {
  $('#settings').classList.remove('open');
  $('#settings').setAttribute('aria-hidden', 'true');
}

function renderFacts() {
  const facts = App.memory.facts || [];
  $('#factList').innerHTML = facts.length
    ? facts.slice().reverse().map(f => `<div class="fact"><span>${esc(f.fact)}</span><button data-id="${esc(f.id)}" title="Forget">✕</button></div>`).join('')
    : '<p class="muted">Max hasn\'t learned anything about you yet. Just talk to Max.</p>';
  const cl = App.memory.claude || [], tp = App.memory.claude_topics || [];
  $('#claudeInfo').innerHTML = `<p class="muted">Claude link: <b>${cl.length}</b> memory files · <b>${tp.length}</b> recent Claude Code sessions${tp.length ? ' (latest: “' + esc((tp[0].prompts[0] || '').slice(0, 70)) + '”)' : ''}.</p>`;
}

async function saveSettings() {
  const body = {
    provider: $('#sProvider').value, model: $('#sModel').value.trim(), ollama_url: $('#sOllama').value.trim() || 'http://localhost:11434',
    user_name: $('#sName').value.trim(), address_as: $('#sAddress').value.trim(),
    city: $('#sCity').value.trim(), wake_word: $('#sWake').checked, use_claude_memory: $('#sClaude').checked,
  };
  for (const [id, key] of [['#sGroq', 'groq_key'], ['#sGemini', 'gemini_key'], ['#sOpenrouter', 'openrouter_key']]) {
    if ($(id).value.trim()) body[key] = $(id).value.trim();
  }
  const cfg = await api('config', body);
  applyConfig(cfg);
  if ((App.memory.about || '') !== $('#sAbout').value) await api('memory', { action: 'about', text: $('#sAbout').value });
  await refreshMemory();
  try { App.context = await api('context'); Brain.setContext(App.context); $('#loc').textContent = (App.context.location || '—').toUpperCase(); } catch (e) { }
  Ears.enable(!!cfg.wake_word);
  log('Settings saved', 'ok');
  return cfg;
}

// ------------------------------------------------------------------ boot
async function bootLine(text, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = text;
  $('#bootLog').appendChild(li);
  await sleep(110);
}

async function boot() {
  App.setState('boot');
  tickClock();
  setInterval(tickClock, 1000);
  Timers.load();
  setInterval(() => Timers.check(), 1000);

  await bootLine('MAX CORE v1.0 :: INITIALIZING');
  let cfg, ctx = {}, mem = {}, hist = { messages: [] };
  try {
    [cfg, ctx, mem, hist] = await Promise.all([api('config'), api('context').catch(() => ({})), api('memory').catch(() => ({})), api('history').catch(() => ({ messages: [] }))]);
  } catch (e) {
    await bootLine('!! CORE SERVER NOT RESPONDING - start Max with Max.bat', 'err');
    App.setState('offline');
    return;
  }
  App.memory = mem;
  App.context = ctx;
  applyConfig(cfg);
  Brain.init({ config: cfg, memory: mem, context: ctx, history: hist.messages || [] });
  prewarmVoice();
  await bootLine(`MEMORY BANKS ........ ${(mem.facts || []).length} PERSONAL FACTS`);
  await bootLine(`CLAUDE LINK ......... ${(mem.claude || []).length} MEMORIES / ${(mem.claude_topics || []).length} SESSIONS`);
  await bootLine(`CONVERSATION LOG .... ${Math.floor((hist.messages || []).length / 2)} EXCHANGES`);
  await bootLine(`AI CORE ............. ${String(cfg.active_provider).toUpperCase()}`, cfg.active_provider === 'offline' ? 'warn' : '');
  await bootLine('VOICE MATRIX ........ BRIAN (NEURAL)');
  await bootLine(`LOCATION ............ ${ctx.location || 'UNKNOWN'}`);
  $('#loc').textContent = (ctx.location || '—').toUpperCase();
  updateMemCount();

  Sound.init();
  if (Sound.ctx.state !== 'running') {
    await bootLine('AUDIO LOCKED BY BROWSER - CLICK ENGAGE', 'warn');
    $('#engage').hidden = false;
    await new Promise(res => $('#engage').addEventListener('click', res, { once: true }));
    await Sound.ctx.resume();
  }
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' });
    if (perm.state === 'prompt') await bootLine('MICROPHONE .......... CLICK "ALLOW" IN THE PERMISSION POPUP', 'warn');
  } catch (e) { }
  const mic = await Sound.initMic();
  await bootLine(`AUDIO SENSORS ....... ${mic ? 'ONLINE' : 'NO MICROPHONE ACCESS'}`, mic ? '' : 'warn');
  Ears.init();
  await bootLine('ALL SYSTEMS NOMINAL', 'ok');
  await sleep(350);
  $('#bootScreen').classList.add('gone');
  setTimeout(() => $('#bootScreen').remove(), 900);
  App.setState('idle');
  App.setEmotion('warm');
  Ears.enable(!!cfg.wake_word && mic);
  App.updateMic();
  pollStats();
  setInterval(pollStats, 3000);
  // keep voice connections warm while someone is actually using Max
  setInterval(() => { if (Date.now() - App.lastActive < 10 * 60000) prewarmVoice(); }, 40000);
  requestAnimationFrame(frameLoop);
  log(`Online. ${!mic ? 'No microphone - type below.' : cfg.wake_word ? 'Say "Max" or press Space.' : 'Press Space or click the core to talk.'}`, 'ok');
  await Brain.greet(io);
}

// ------------------------------------------------------------------ wiring
$('#cmdInput').addEventListener('input', () => { App.lastActive = Date.now(); prewarmVoice(); });
$('#cmd').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#cmdInput').value;
  $('#cmdInput').value = '';
  App.handleUserText(v, 'text');
});
$('#talkBtn').addEventListener('click', () => (Mouth.speaking ? Mouth.stop() : Ears.listenNow()));
$('#orb').addEventListener('click', e => { if (Orb.hit(e.clientX, e.clientY)) (Mouth.speaking ? Mouth.stop() : Ears.listenNow()); });
$('#gear').addEventListener('click', openSettings);
$('#banner').addEventListener('click', openSettings);
$('#closeSettings').addEventListener('click', closeSettings);
$('#saveSettings').addEventListener('click', async () => { $('#saveSettings').textContent = 'SAVING...'; try { await saveSettings(); closeSettings(); } finally { $('#saveSettings').textContent = 'SAVE'; } });
$('#quitMax').addEventListener('click', quitMax);
$('#micBtn').addEventListener('click', () => Ears.listenNow());
$('#wakeBtn').addEventListener('click', async () => {
  const on = !Ears.want;
  Ears.enable(on);
  applyConfig(await api('config', { wake_word: on }));
  log(`Wake word ${on ? 'ON' : 'OFF'}`, 'ok');
});
$('#testVoice').addEventListener('click', () => {
  Mouth.say(`Hey ${Brain.addr()}! Voice check: loud and clear on my end. How about yours?`, 'happy');
});
$('#testBrain').addEventListener('click', async () => {
  const st = $('#brainStatus');
  st.textContent = 'saving + testing...';
  await saveSettings();
  try {
    const r = await api('llm', { messages: [{ role: 'user', content: 'Reply with this exact JSON: {"ok": true}' }], json: true });
    st.textContent = r.ok ? `✓ ${r.provider} · ${r.model}` : `✕ ${r.error || 'failed'}`;
    st.className = r.ok ? 'good' : 'bad';
    if (r.ok) io.link(r.provider, r.model);
  } catch (e) { st.textContent = '✕ server unreachable'; st.className = 'bad'; }
});
$('#factList').addEventListener('click', async e => {
  const id = e.target.dataset && e.target.dataset.id;
  if (!id) return;
  await api('memory', { action: 'delete', id });
  await refreshMemory();
  renderFacts();
});
addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === 'Escape') { Mouth.stop(); closeSettings(); if (typing) document.activeElement.blur(); return; }
  if (typing) return;
  if (e.code === 'Space') { e.preventDefault(); Mouth.speaking ? Mouth.stop() : Ears.listenNow(); }
  else if (e.key === '/') { e.preventDefault(); $('#cmdInput').focus(); }
  else if (e.key === ',' && e.ctrlKey) { e.preventDefault(); openSettings(); }
});
boot();
