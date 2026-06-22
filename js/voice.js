/* ═══════════════════════════════════════════
   CA Traffic Cams — Voice Commands
   Three-layer intent parser:
   1. Strict regex  (instant, no key needed)
   2. Keyword-bag   (handles natural variations)
   3. Claude API    (handles anything — optional key in settings)

   Globals from app.js:    allCameras, showToast
   Globals from travel.js: tvRouteCams, tvDriveIndex, tvDriveNav,
                            tvShowDriveCam, tvFeedMode
════════════════════════════════════════════ */

'use strict';

const VC_KEY     = 'tfc_vc_enabled';
const VC_API_KEY = 'tfc_vc_apikey';

let vcRecog             = null;
let vcActive            = false;
let vcFeedbackTimer     = null;
let vcCurrentTranscript = '';

// ── Number helpers ─────────────────────────────────────────────────────────
const VC_NUMS = {
  one:1, two:2, three:3, four:4, five:5,
  six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, fifteen:15, twenty:20
};
function vcParseNum(s, defaultVal) {
  if (s === undefined || s === null) return defaultVal !== undefined ? defaultVal : 1;
  const n = parseInt(s, 10);
  return isNaN(n) ? (VC_NUMS[String(s).toLowerCase()] || (defaultVal !== undefined ? defaultVal : 1)) : n;
}

// ── Road / name normalization ──────────────────────────────────────────────
function vcNorm(s) {
  return (s || '').toLowerCase()
    .replace(/\bhighway\b/g,       'hwy')
    .replace(/\bstate\s*route\b/g, 'sr')
    .replace(/\binterstate\b/g,    'i')
    .replace(/\bavenue\b/g,        'ave')
    .replace(/\bboulevard\b/g,     'blvd')
    .replace(/\bstreet\b/g,        'st')
    .replace(/[:\-\/|]+/g,         ' ')
    .replace(/\s+/g,               ' ')
    .trim();
}

// ── Feedback box ───────────────────────────────────────────────────────────
function vcShowFeedback(heard, action, persist) {
  clearTimeout(vcFeedbackTimer);
  const box      = document.getElementById('vcFeedback');
  const heardEl  = document.getElementById('vcFeedbackHeard');
  const actionEl = document.getElementById('vcFeedbackAction');
  if (!box) return;
  if (heardEl)  heardEl.textContent  = heard  ? '"' + heard + '"' : '';
  if (actionEl) actionEl.textContent = action || '';
  box.classList.remove('hidden');
  if (!persist) vcFeedbackTimer = setTimeout(() => box.classList.add('hidden'), 5000);
}

function vcHideFeedback() {
  clearTimeout(vcFeedbackTimer);
  const box = document.getElementById('vcFeedback');
  if (box) box.classList.add('hidden');
}

// ── Intent execution (shared by all three parsing layers) ──────────────────
function vcExecuteIntent(intent, raw) {
  switch (intent.intent) {
    case 'nav': {
      const delta = Math.round(intent.delta || 0);
      const n     = Math.abs(delta);
      vcShowFeedback(raw, delta >= 0
        ? 'Jumping ' + n + ' camera' + (n !== 1 ? 's' : '') + ' ahead'
        : 'Going back ' + n + ' camera' + (n !== 1 ? 's' : ''));
      tvDriveNav(delta);
      break;
    }
    case 'stream':
      if (typeof tvFeedMode !== 'undefined' && tvFeedMode !== 'stream')
        document.getElementById('driveFeedToggle')?.click();
      vcShowFeedback(raw, 'Switched to Stream mode');
      break;
    case 'view':
      if (typeof tvFeedMode !== 'undefined' && tvFeedMode !== 'view')
        document.getElementById('driveFeedToggle')?.click();
      vcShowFeedback(raw, 'Switched to View mode');
      break;
    case 'search':
      vcFindCamera(intent.query || raw, raw);
      break;
    default:
      vcShowFeedback(raw, 'Not understood — try "3 cameras ahead" or "camera on Herndon and Hwy 99"');
  }
}

// ── Layer 1: Strict regex ──────────────────────────────────────────────────
function vcRegexParse(t) {
  let m;

  m = t.match(/\b(\w+)\s+cameras?\s+(ahead|forward)/);
  if (m) return { intent: 'nav', delta: vcParseNum(m[1]) };

  m = t.match(/\b(\w+)\s+cameras?\s+(back|behind)/);
  if (m) return { intent: 'nav', delta: -vcParseNum(m[1]) };

  if (/\bnext\s+camera\b/.test(t) || /\bgo\s+forward\b/.test(t))
    return { intent: 'nav', delta: 1 };
  if (/\b(previous|prev)\s+camera\b/.test(t) || /\bgo\s+back\b/.test(t))
    return { intent: 'nav', delta: -1 };

  if (/\b(stream|live)\s*(mode)?\b/.test(t)) return { intent: 'stream' };
  if (/\b(view|still)\s*(mode)?\b/.test(t))  return { intent: 'view' };

  m = t.match(/camera\s+(?:on|at|near|along|for|in)?\s*(.{3,})/);
  if (m) return { intent: 'search', query: m[1].trim() };

  m = t.match(/show\s+(?:me\s+)?(?:the\s+)?(.{3,})/);
  if (m) {
    const q = m[1].replace(/^camera\s+(?:on|at|near|in)?\s*/, '').trim();
    return { intent: 'search', query: q };
  }

  return null;
}

// ── Layer 2: Keyword-bag fuzzy matching ────────────────────────────────────
// Handles natural variations the regex won't catch:
// "jump ahead ten", "advance 3", "skip five", "bring up stream", etc.
const VC_FWD  = new Set(['ahead','forward','next','advance','skip','further','more','forth','up','proceed','after']);
const VC_BWD  = new Set(['back','behind','previous','prev','before','last','prior','earlier','rewind','reverse','return']);
const VC_STRM = new Set(['stream','live','video','streaming','broadcast','feed']);
const VC_VIEW = new Set(['view','still','image','photo','picture','snapshot','static','stop','pause']);
const VC_SRCH = new Set(['camera','find','where','at','on','near','junction','intersection','road','street','avenue','highway','route']);

function vcKeywordParse(t) {
  const words = t.split(/\W+/).filter(Boolean);

  let num     = null;
  let hasFwd  = false, hasBwd = false;
  let hasStrm = false, hasView = false;
  let hasSrch = false;

  for (const w of words) {
    // Numbers
    const ni = parseInt(w, 10);
    if (!isNaN(ni) && ni > 0)           num = ni;
    else if (VC_NUMS[w] !== undefined)  num = VC_NUMS[w];

    if (VC_FWD.has(w))  hasFwd  = true;
    if (VC_BWD.has(w))  hasBwd  = true;
    if (VC_STRM.has(w)) hasStrm = true;
    if (VC_VIEW.has(w)) hasView = true;
    if (VC_SRCH.has(w)) hasSrch = true;
  }

  // Feed mode (no directional context)
  if (hasStrm && !hasFwd && !hasBwd) return { intent: 'stream' };
  if (hasView  && !hasFwd && !hasBwd) return { intent: 'view' };

  // Navigation — need at least one directional word, OR a number without backward signal
  if (hasFwd && !hasBwd)  return { intent: 'nav', delta:  num !== null ? num : 1 };
  if (hasBwd && !hasFwd)  return { intent: 'nav', delta: -(num !== null ? num : 1) };
  if (num !== null && !hasBwd && !hasStrm && !hasView)
    return { intent: 'nav', delta: num }; // bare number = go forward that many

  // Search fallback — sentence has location-type words but no nav intent
  if (hasSrch && num === null && !hasFwd && !hasBwd && !hasStrm && !hasView)
    return { intent: 'search', query: t };

  return null;
}

// ── Layer 3: Claude API (optional) ────────────────────────────────────────
async function vcParseWithAI(raw, apiKey) {
  const totalCams = (tvRouteCams && tvRouteCams.length) || 0;
  const curIdx    = (typeof tvDriveIndex !== 'undefined' ? tvDriveIndex : 0) + 1;
  const feedMode  = typeof tvFeedMode !== 'undefined' ? tvFeedMode : 'view';

  const systemPrompt =
    'You are a voice command parser for a traffic camera driving assistant. ' +
    'Extract the user\'s intent and return ONLY a JSON object — no explanation, no markdown. ' +
    'Current state: ' + totalCams + ' cameras on route, currently showing camera #' + curIdx + ', feed mode is "' + feedMode + '". ' +
    'JSON formats:\n' +
    '{"intent":"nav","delta":N}   N>0 = cameras ahead, N<0 = cameras back\n' +
    '{"intent":"stream"}          switch to live stream feed\n' +
    '{"intent":"view"}            switch to still image feed\n' +
    '{"intent":"search","query":"road name or location"}\n' +
    '{"intent":"unknown"}';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        system: systemPrompt,
        messages: [{ role: 'user', content: raw }]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (_) { return null; }
}

// ── Camera search (used by all intent layers) ──────────────────────────────
const VC_STOP = new Set([
  'the','on','at','near','for','in','along','a','an','and',
  'me','show','camera','cameras','please','find'
]);

function vcSearchCams(cams, rawQuery) {
  const words = vcNorm(rawQuery).split(' ').filter(w => w.length > 1 && !VC_STOP.has(w));
  if (!words.length) return null;
  let best = null, bestScore = 0;
  for (const cam of cams) {
    const hay = vcNorm([cam.name, cam.description, cam.roadway].filter(Boolean).join(' '));
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    if (score > bestScore) { bestScore = score; best = cam; }
  }
  return bestScore > 0 ? best : null;
}

function vcFindCamera(query, raw) {
  if (tvRouteCams && tvRouteCams.length) {
    const hit = vcSearchCams(tvRouteCams.map(rc => rc.cam), query);
    if (hit) {
      const idx = tvRouteCams.findIndex(rc => rc.cam === hit);
      if (idx >= 0) { tvDriveIndex = idx; tvShowDriveCam(idx); vcShowFeedback(raw, 'Showing: ' + hit.name); return; }
    }
  }
  const hit = vcSearchCams(allCameras, query);
  if (hit) { vcShowFeedback(raw, '"' + hit.name + '" is not on your current route'); return; }
  vcShowFeedback(raw, 'No camera found for "' + query + '"');
}

// ── Main handler (async — may call AI) ────────────────────────────────────
async function vcHandle(raw) {
  vcCurrentTranscript = raw;
  const t = raw.toLowerCase().trim();

  // Layer 1 — fast regex
  const r1 = vcRegexParse(t);
  if (r1) { vcExecuteIntent(r1, raw); return; }

  // Layer 2 — keyword-bag fuzzy
  const r2 = vcKeywordParse(t);
  if (r2) { vcExecuteIntent(r2, raw); return; }

  // Layer 3 — Claude API (if key present)
  const apiKey = localStorage.getItem(VC_API_KEY);
  if (apiKey) {
    vcShowFeedback(raw, 'Thinking…', true);
    const r3 = await vcParseWithAI(raw, apiKey);
    if (r3 && r3.intent !== 'unknown') { vcExecuteIntent(r3, raw); return; }
  }

  vcShowFeedback(raw, 'Not understood — try "3 cameras ahead" or "camera on Herndon and Hwy 99"');
}

// ── SpeechRecognition lifecycle ────────────────────────────────────────────
function vcStartListening() {
  if (localStorage.getItem(VC_KEY) !== '1') {
    showToast('Voice commands are off — enable in Settings', '', 3000); return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Voice commands not supported in this browser', '', 3000); return; }
  if (vcActive) { vcStop(); return; }

  vcRecog                = new SR();
  vcRecog.lang           = 'en-US';
  vcRecog.interimResults = false;
  vcRecog.maxAlternatives = 3;

  vcSetState('listening');
  vcActive = true;

  vcRecog.onresult = async e => {
    vcActive = false;
    vcSetState('processing');
    await vcHandle(e.results[0][0].transcript);
    vcSetState('idle');
  };

  vcRecog.onerror = e => {
    vcActive = false;
    vcSetState('idle');
    if (e.error === 'no-speech') vcHideFeedback();
    else if (e.error !== 'aborted') vcShowFeedback('', 'Mic error: ' + e.error);
  };

  vcRecog.onend = () => { if (vcActive) { vcActive = false; vcSetState('idle'); } };

  vcRecog.start();
}

function vcStop() {
  if (vcRecog) { try { vcRecog.abort(); } catch (_) {} vcRecog = null; }
  vcActive = false;
  vcSetState('idle');
  vcHideFeedback();
}

function vcSetState(state) {
  const btn = document.getElementById('vcBtn');
  if (btn) btn.dataset.state = state;
  if (state === 'listening') vcShowFeedback('', 'Listening…', true);
}

function vcUpdateBtn() {
  const btn = document.getElementById('vcBtn');
  if (btn) btn.classList.toggle('hidden', localStorage.getItem(VC_KEY) !== '1');
}

// ── Init ──────────────────────────────────────────────────────────────────
(function vcInit() {
  vcUpdateBtn();
  const btn = document.getElementById('vcBtn');
  if (btn) btn.addEventListener('click', vcStartListening);
}());
