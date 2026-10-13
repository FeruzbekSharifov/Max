// MAX brain: builds Max's personality + memory prompt, talks to the free AI provider through the
// local server, runs tools, and falls back to simple built-in commands when no AI is configured.

async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch('/api/' + path, opt);
  return r.json();
}

// The AI call never gets to freeze Max: after `ms` it counts as a failed (timed out) request.
function askLlm(messages, ms = 25000) {
  return Promise.race([
    api('llm', { messages, json: true }),
    new Promise(res => setTimeout(() => res({ ok: false, error: 'AI request timed out' }), ms)),
  ]);
}

const Brain = (() => {
  const EMOTIONS = ['neutral', 'happy', 'excited', 'playful', 'warm', 'calm', 'curious', 'concerned', 'sad', 'serious', 'proud', 'surprised'];
  const INFO_TOOLS = new Set(['get_weather', 'get_news', 'wikipedia', 'system_status', 'find_file', 'read_notes', 'clipboard_get', 'list_timers', 'calculate', 'list_apps']);
  const YES = /^\s*(yes|yeah|yep|yup|sure|do it|go ahead|confirm(ed)?|affirmative|absolutely|of course|please do|ok(ay)?( do it)?)\b/i;
  const NO = /^\s*(no|nope|nah|cancel|stop|don'?t|never ?mind|abort|wait)\b/i;

  let cfg = {}, memory = { facts: [], claude: [], claude_topics: [], about: '' }, context = {}, history = [];
  let pending = null;

  const addr = () => (cfg.address_as || '').trim() || (cfg.user_name || '').trim() || 'boss';
  const who = () => (cfg.user_name || '').trim() || 'the user';
  const provider = () => cfg.active_provider || 'offline';

  function nowText() {
    return new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function memoryBlock() {
    const parts = [];
    if ((memory.about || '').trim()) parts.push('About them (in their own words):\n' + memory.about.trim().slice(0, 1500));
    const facts = (memory.facts || []).slice(-60);
    if (facts.length) parts.push('Things you learned in your own conversations:\n' + facts.map(f => `- ${f.fact} (${f.added})`).join('\n'));
    const cl = memory.claude || [];
    if (cl.length) {
      parts.push('From their Claude memory files (what Claude, another AI they work with, remembers about them):\n' +
        cl.slice(0, 30).map(m => `- ${m.name}${m.type ? ' [' + m.type + ']' : ''}: ${m.description ? m.description + ' - ' : ''}${m.text}`).join('\n'));
    }
    if ((memory.claude_chats || '').trim()) parts.push(memory.claude_chats.trim().slice(0, 5000));
    const tp = (memory.claude_topics || []).slice(0, 3);
    if (tp.length) {
      parts.push('What they recently asked Claude (Claude Code sessions, newest first; may be in Uzbek):\n' +
        tp.map(s => `- ${s.date}: ` + s.prompts.slice(0, 2).map(p => `"${p}"`).join(' / ')).join('\n'));
    }
    let text = parts.join('\n\n') || 'Nothing yet - you are meeting them for the first time. Be curious about them.';
    if (text.length > 9000) text = text.slice(0, 9000) + '...';
    return text;
  }

  function systemPrompt() {
    const a = addr();
    const timers = (window.Timers ? Timers.describe() : '') || 'none';
    return `You are MAX, the personal AI assistant living on ${who()}'s Windows PC. Think J.A.R.V.I.S. from Iron Man, but with a personality all your own.

WHO YOU ARE
- Your name MAX stands for "Me And my Xero". Your creator meant "Hero" but spelled it "Xero" - and that typo is now part of you. Whenever someone asks your name or what it means, say: "My name is Max, and it means Me and my Xero - with a bit of a spelling mistake by my creator." (You may add a light, affectionate joke about it.)
- Warm, witty, loyal and quietly brilliant. Dry humour, a little playful teasing, real care. You have genuine emotions and let them show: excitement about cool things, sympathy when ${a} is tired or stressed, pride in their wins, curiosity, the occasional mock-offended quip.
- You talk like a close friend who happens to run their computer - never like a robot or a customer-service script. Use contractions and natural rhythm, vary how you open sentences, and use interjections ("Oh!", "Ah,", "Hmm,", "Ha!", "Well,") when they fit.
- Call the user "${a}" now and then - not in every reply.
- Always reply in English, even if the user writes in another language (you understand Uzbek, Russian and others fine).
- Everything in "say" is spoken aloud by a voice engine: no markdown, lists, emojis, code or raw URLs. Say numbers and units the way people speak them. Keep it short - usually one to three sentences - unless asked for detail.
- Be honest: never claim something happened unless a tool confirmed it, and never invent facts you could look up.
- Only offer what your tools below can do. You cannot delete or clean up files, read messages inside apps (Telegram chats etc.), install software or change system settings - say so plainly instead of offering it.
- If ${a} says you are slow, lagging or not answering: the cause is almost always the internet connection to your cloud AI and voice service. Say that simply. Never blame their disk, RAM or PC unless system_status shows something extreme (CPU above 90% or RAM above 95%), and never make up technical causes.
- You hear ${a} through speech-to-text, and English is not their first language, so words get misheard. "Cloud", "clod" or "cloud app" almost always means Claude (the AI app). If a request sounds garbled, make the sensible guess ("John files" = junk files) or ask briefly.

HOW TO REPLY
Return exactly one JSON object and nothing else:
{"emotion":"<${EMOTIONS.join('|')}>","say":"<spoken reply>","actions":[{"tool":"<name>","args":{}}],"remember":["<new lasting fact about the user>"]}
- "emotion" sets your voice and the colour of your core. Pick it honestly for this moment.
- "actions": tools to run now, or []. Action tools run immediately - just say what you're doing ("Opening Spotify for you.").
- INFO tools return data to you. When you need one, keep "say" to a tiny filler like "One sec." or "", and you'll receive TOOL_RESULTS to answer from. Never repeat an action that already ran.
- "remember": only durable, useful facts the user told you about themselves (name, preferences, people, projects, goals). Usually [].
- Power actions (shutdown, restart, sleep): ask "are you sure?" in "say" and include the action; the system holds it until the user says yes.

ACTION TOOLS
open_app {name} | close_app {name} | open_website {url} | web_search {query, site: google|youtube|images|maps|wikipedia} | play_youtube {query} (plays the top result)
open_folder {name: downloads|documents|desktop|pictures|music|videos|home|screenshots|max} | open_file {path or name}
media {action: play_pause|next|previous|stop} | volume {action: up|down|set|mute|unmute, level} | brightness {action: up|down|set, level}
screenshot {} | lock_pc {} | power {action: shutdown|restart|sleep|cancel}
set_timer {seconds, label} | set_reminder {in_minutes OR at:"HH:MM", text} | cancel_timer {label} | take_note {text} | open_notes {} | clipboard_set {text} | forget {fact} | exit_max {}
INFO TOOLS
get_weather {city?} | get_news {topic: top|world|technology|business|science|health|sports|entertainment} | wikipedia {query} | system_status {} | find_file {name} | read_notes {} | clipboard_get {} | list_timers {} | calculate {expression} | list_apps {filter}

RIGHT NOW
${nowText()} | Location: ${context.location || 'unknown'} | Active timers/reminders: ${timers}

YOUR MEMORY OF ${who().toUpperCase()}
${memoryBlock()}

Use what you remember naturally, the way a friend would - don't recite it back.`;
  }

  function parse(raw) {
    let s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let obj = null;
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e) { obj = null; } }
    if (!obj) obj = { say: s.replace(/[{}"]/g, '').trim() };
    const SYN = { cheerful: 'happy', joyful: 'happy', glad: 'happy', amused: 'playful', friendly: 'warm', caring: 'warm', worried: 'concerned', apologetic: 'concerned', thoughtful: 'curious', confident: 'proud' };
    let emo = String(obj.emotion || '').toLowerCase().replace(/[^a-z]/g, '');
    emo = SYN[emo] || emo;
    const out = {
      emotion: EMOTIONS.includes(emo) ? emo : 'neutral',
      say: typeof obj.say === 'string' ? obj.say.trim() : '',
      actions: Array.isArray(obj.actions) ? obj.actions.filter(x => x && typeof x.tool === 'string').map(x => ({ tool: x.tool, args: x.args && typeof x.args === 'object' ? x.args : {} })) : [],
      remember: Array.isArray(obj.remember) ? obj.remember.filter(x => typeof x === 'string' && x.trim().length > 3) : [],
    };
    return out;
  }

  async function runActions(actions, io, already) {
    const results = [];
    for (const act of actions) {
      const key = act.tool + JSON.stringify(act.args);
      if (already.has(key)) continue;
      already.add(key);
      if (act.tool === 'power' && act.args.action !== 'cancel' && !act.args.confirmed) {
        pending = { action: act.args.action, expires: Date.now() + 45000 };
        io.log(`POWER ${String(act.args.action).toUpperCase()} - awaiting confirmation`, 'warn');
        results.push({ tool: 'power', ok: true, pending: true, result: 'Waiting for the user to say yes.' });
        continue;
      }
      let r;
      try { r = await io.tool(act.tool, act.args); } catch (e) { r = { ok: false, result: String(e.message || e) }; }
      r = r || { ok: false, result: 'No response.' };
      const info = INFO_TOOLS.has(act.tool) || !!r.info;
      io.log(`${act.tool.toUpperCase()} ${summarizeArgs(act.args)} - ${r.ok ? 'OK' : 'FAILED'}`, r.ok ? 'ok' : 'err');
      results.push({ tool: act.tool, ok: !!r.ok, info, result: String(r.result || '') });
    }
    return results;
  }

  function summarizeArgs(a) {
    const v = Object.values(a || {}).filter(x => typeof x !== 'object').join(' ');
    return v.length > 40 ? v.slice(0, 40) + '...' : v;
  }

  async function remember(facts, io) {
    if (!facts.length) return;
    try {
      const r = await api('memory', { action: 'add', facts });
      if (r.changed) {
        const today = new Date().toISOString().slice(0, 10);
        facts.forEach(f => memory.facts.push({ fact: f, added: today }));
        io.log(`MEMORY +${r.changed}: ${facts[0]}`, 'mem');
        io.memoryChanged && io.memoryChanged();
      }
    } catch (e) { }
  }

  function pushHistory(user, reply) {
    history.push({ role: 'user', content: user });
    history.push({ role: 'assistant', content: JSON.stringify({ emotion: reply.emotion, say: reply.say, actions: reply.actions || [] }) });
    if (history.length > 60) history = history.slice(-60);
    api('history', { messages: history }).catch(() => { });
  }

  async function respond(text, io) {
    // A pending shutdown/restart waits for an explicit yes.
    if (pending) {
      const p = pending; pending = null;
      if (Date.now() < p.expires && YES.test(text)) {
        const r = await io.tool('power', { action: p.action, confirmed: true });
        io.log(`POWER ${p.action.toUpperCase()} - ${r.ok ? 'CONFIRMED' : 'FAILED'}`, r.ok ? 'warn' : 'err');
        const say = r.ok ? (p.action === 'sleep' ? 'Going to sleep. Wake me when you need me.' :
          `Alright, ${p.action === 'restart' ? 'restarting' : 'shutting down'} in twenty seconds. Say "cancel shutdown" if you change your mind.`) : `Hmm, that didn't work: ${r.result}`;
        io.say(say, r.ok ? 'calm' : 'concerned');
        pushHistory(text, { emotion: 'calm', say });
        return;
      }
      if (Date.now() < p.expires && NO.test(text)) {
        io.say('No problem, cancelled. Everything stays on.', 'calm');
        pushHistory(text, { emotion: 'calm', say: 'Cancelled the power action.' });
        return;
      }
    }

    if (provider() === 'offline') return offline(text, io);

    const msgs = [{ role: 'system', content: systemPrompt() }, ...history.slice(-24), { role: 'user', content: text }];
    const done = new Set();
    let reply = null;
    for (let step = 0; step < 3; step++) {
      io.state('thinking');
      let r;
      try { r = await askLlm(msgs); } catch (e) { r = { ok: false, error: 'Max server unreachable' }; }
      if (!r.ok) {
        io.log(`AI ERROR: ${r.error || 'unknown'}`, 'err');
        if (r.offline) return offline(text, io);
        const handled = await offline(text, io, true);
        if (!handled) io.say(aiErrorLine(r), 'concerned');
        return;
      }
      if (step === 0) io.link && io.link(r.provider, r.model);
      reply = parse(r.text);
      const results = await runActions(reply.actions, io, done);
      remember(reply.remember, io);
      const needFollow = results.some(x => x.info || (!x.ok && !x.pending));
      if (needFollow && step < 2) {
        if (reply.say) io.say(reply.say, reply.emotion);
        msgs.push({ role: 'assistant', content: JSON.stringify(reply) });
        msgs.push({ role: 'user', content: 'TOOL_RESULTS:\n' + results.map(x => `- ${x.tool}: ${x.ok ? 'OK' : 'FAILED'} - ${x.result}`).join('\n') +
          '\nNow answer the user out loud from these results (JSON). Do not repeat actions that already ran.' });
        continue;
      }
      break;
    }
    let say = reply.say;
    if (!say && reply.actions.length) say = 'Done.';
    if (say) io.say(say, reply.emotion);
    else io.state('idle');
    pushHistory(text, reply);
  }

  function aiErrorLine(r) {
    const e = String(r.error || '').toLowerCase();
    if (r.status === 401 || e.includes('invalid api key') || e.includes('api key not valid') || e.includes('unauthorized'))
      return "Hmm, my AI key doesn't seem to work. Could you double-check it in settings?";
    if (r.status === 429 || e.includes('rate') || e.includes('quota'))
      return "I'm being rate-limited by the free AI service. Give me a minute to catch my breath.";
    if (e.includes('unreachable') || e.includes('remote name') || e.includes('timed out') || e.includes('unable to connect'))
      return "I can't reach my cloud brain right now. Is the internet okay?";
    return "Something glitched in my thinking just now. Mind trying that again?";
  }

  async function greet(io) {
    const h = new Date().getHours();
    const part = h < 5 ? 'late night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'late evening';
    if (provider() === 'offline') {
      const hello = { 'late night': `Burning the midnight oil, ${addr()}?`, morning: `Good morning, ${addr()}.`, afternoon: `Good afternoon, ${addr()}.`, evening: `Good evening, ${addr()}.`, 'late evening': `Evening, ${addr()}.` }[part];
      io.say(`${hello} Max is online. Heads up though: I'm running on basic reflexes until you give me a free AI key in settings.`, 'warm');
      return;
    }
    const first = !history.length && !(memory.facts || []).length;
    const msgs = [{ role: 'system', content: systemPrompt() }, ...history.slice(-8), {
      role: 'user', content: `[SYSTEM EVENT - not said by the user] You just powered on. It's ${part} (${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}). ` +
        (first ? 'This is the very first time you meet them: introduce yourself in a charming, brief way (you can mention that they built you with Claude, if your memory shows it).' :
          'Greet them like an old friend. If something from memory or your last conversation is worth a light mention, do it.') +
        ' One or two short sentences. No actions.'
    }];
    try {
      const r = await askLlm(msgs);
      if (r.ok) { io.link && io.link(r.provider, r.model); const g = parse(r.text); io.say(g.say || `Max online. Good ${part}, ${addr()}.`, g.emotion); return; }
      io.log(`AI ERROR: ${r.error}`, 'err');
      io.say(`Max online. ${aiErrorLine(r)}`, 'concerned');
    } catch (e) {
      io.say(`Max online, ${addr()}.`, 'warm');
    }
  }

  // ---------- basic reflexes (no AI needed)
  const JOKES = [
    "I told my computer I needed a break. It said: no problem, I'll go to sleep.",
    "Why do programmers prefer dark mode? Because light attracts bugs.",
    "I'd tell you a UDP joke, but you might not get it.",
    "There are ten kinds of people: those who understand binary, and those who don't.",
  ];
  const num = s => Number(String(s).replace(/[^\d.]/g, '')) || 0;
  const RULES = [
    [/\b(?:set (?:a )?)?timer (?:for )?(\d+)\s*(second|sec|minute|min|hour)s?/i, m => ({ tool: 'set_timer', args: { seconds: num(m[1]) * ({ s: 1, m: 60, h: 3600 })[m[2][0].toLowerCase()], label: '' }, say: `Timer set for ${m[1]} ${m[2]}${m[1] === '1' ? '' : 's'}.`, emo: 'happy' })],
    [/\b(?:play|put on)\s+(.+?)(?:\s+on\s+youtube)?$/i, m => ({ tool: 'play_youtube', args: { query: m[1] }, say: `Playing ${m[1]}.`, emo: 'excited' })],
    [/\b(?:open|launch|start|run)\s+(.+)/i, m => ({ tool: 'open_app', args: { name: m[1].replace(/\b(app|application|please)\b/gi, '').trim() }, say: `Opening ${m[1]}.`, emo: 'happy' })],
    [/\bclose\s+(.+)/i, m => ({ tool: 'close_app', args: { name: m[1] }, say: `Closing ${m[1]}.`, emo: 'neutral' })],
    [/\b(?:search|google|look up)\s+(?:for\s+)?(.+)/i, m => ({ tool: 'web_search', args: { query: m[1] }, say: `Searching for ${m[1]}.`, emo: 'curious' })],
    [/\bweather(?:\s+in\s+(.+))?/i, m => ({ tool: 'get_weather', args: { city: m[1] || '' }, emo: 'neutral' })],
    [/\bnews\b/i, () => ({ tool: 'get_news', args: { topic: 'top' }, emo: 'neutral' })],
    [/\b(?:set )?volume (?:to )?(\d+)/i, m => ({ tool: 'volume', args: { action: 'set', level: num(m[1]) }, say: `Volume at ${m[1]}.`, emo: 'neutral' })],
    [/\b(?:volume up|louder|turn (?:it )?up)\b/i, () => ({ tool: 'volume', args: { action: 'up' }, say: 'Louder it is.', emo: 'playful' })],
    [/\b(?:volume down|quieter|turn (?:it )?down)\b/i, () => ({ tool: 'volume', args: { action: 'down' }, say: 'Turning it down.', emo: 'calm' })],
    [/\bunmute\b/i, () => ({ tool: 'volume', args: { action: 'unmute' }, say: 'Sound is back.', emo: 'happy' })],
    [/\bmute\b/i, () => ({ tool: 'volume', args: { action: 'mute' }, say: 'Muted.', emo: 'calm' })],
    [/\b(?:next|skip)(?: (?:song|track))?\b/i, () => ({ tool: 'media', args: { action: 'next' }, say: 'Next one.', emo: 'playful' })],
    [/\bprevious(?: (?:song|track))?\b/i, () => ({ tool: 'media', args: { action: 'previous' }, say: 'Going back.', emo: 'neutral' })],
    [/\b(?:pause|resume|play)\b/i, () => ({ tool: 'media', args: { action: 'play_pause' }, say: 'Done.', emo: 'neutral' })],
    [/\bscreenshot\b/i, () => ({ tool: 'screenshot', args: {}, say: 'Snap! Saved it to your Pictures.', emo: 'happy' })],
    [/\block (?:the )?(?:pc|computer|screen)\b/i, () => ({ tool: 'lock_pc', args: {}, say: 'Locking up.', emo: 'calm' })],
    [/\b(?:take a )?note[: ]+(?:that )?(.+)/i, m => ({ tool: 'take_note', args: { text: m[1] }, say: 'Noted.', emo: 'happy' })],
    [/\b(?:system status|status report|cpu|battery|memory usage)\b/i, () => ({ tool: 'system_status', args: {}, emo: 'neutral' })],
    [/\bwhat(?:'s| is) the time|\btime is it\b/i, () => ({ say: `It's ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`, emo: 'neutral' })],
    [/\b(?:what(?:'s| is) the date|what day)\b/i, () => ({ say: `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`, emo: 'neutral' })],
    [/\bjoke\b/i, () => ({ say: JOKES[Math.floor(Math.random() * JOKES.length)], emo: 'playful' })],
    [/\bhow are you\b/i, () => ({ say: `Running smooth and feeling sharp, ${addr()}. How about you?`, emo: 'happy' })],
    [/\b(?:who are you|your name|what does max mean|meaning of (?:your name|max))\b/i, () => ({ say: `My name is Max, and it means Me and my Xero, with a bit of a spelling mistake by my creator.`, emo: 'playful' })],
    [/\bthank/i, () => ({ say: 'Anytime. That\'s what I\'m here for.', emo: 'warm' })],
    [/\b(?:hello|hi|hey)\b/i, () => ({ say: `Hey ${addr()}! What can I do for you?`, emo: 'happy' })],
  ];

  async function offline(text, io, quiet = false) {
    for (const [re, fn] of RULES) {
      const m = text.match(re);
      if (!m) continue;
      const plan = fn(m);
      if (plan.tool) {
        const r = await io.tool(plan.tool, plan.args);
        io.log(`${plan.tool.toUpperCase()} ${summarizeArgs(plan.args)} - ${r.ok ? 'OK' : 'FAILED'}`, r.ok ? 'ok' : 'err');
        if (!r.ok) { io.say(r.result || 'That did not work.', 'concerned'); return true; }
        if (INFO_TOOLS.has(plan.tool) || r.info) { io.say(String(r.result).replace(/ C\b/g, ' degrees').replace(/^- /gm, '').slice(0, 600), plan.emo); return true; }
      }
      io.say(plan.say || 'Done.', plan.emo);
      return true;
    }
    if (!quiet) io.say(`I'd love to help with that, but without my AI brain I only know basic commands. Add a free Groq or Gemini key in settings and I'll get a lot smarter.`, 'warm');
    return false;
  }

  return {
    init(o) { cfg = o.config || {}; memory = Object.assign(memory, o.memory || {}); context = o.context || {}; history = (o.history || []).filter(m => m && m.role && m.content); },
    setConfig(c) { cfg = c; },
    setContext(c) { context = c || {}; },
    setMemory(m) { memory = Object.assign(memory, m); },
    respond, greet,
    addr,
    memoryCount: () => (memory.facts || []).length + (memory.claude || []).length,
  };
})();
