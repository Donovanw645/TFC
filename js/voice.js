/* ═══════════════════════════════════════════
   CA Traffic Cams — Voice Commands
   Tap-to-talk for driving mode.

   Globals from app.js:    allCameras, showToast
   Globals from travel.js: tvRouteCams, tvDriveIndex, tvDriveNav,
                            tvShowDriveCam, tvFeedMode
════════════════════════════════════════════ */

'use strict';

const VC_KEY = 'tfc_vc_enabled';

let vcRecog             = null;
let vcActive            = false;
let vcFeedbackTimer     = null;
let vcCurrentTranscript = '';

// ── Number words ───────────────────────────────────────────────────────────
const VC_NUMS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
function vcParseNum(s) {
  const n = parseInt(s, 10);
  return isNaN(n) ? (VC_NUMS[s.toLowerCase()] || 1) : n;
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

const VC_STOP = new Set([
  'the','on','at','near','for','in','along','a','an','and',
  'me','show','camera','cameras','please','find'
]);

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
  if (!persist) {
    vcFeedbackTimer = setTimeout(() => box.classList.add('hidden'), 5000);
  }
}

function vcHideFeedback() {
  clearTimeout(vcFeedbackTimer);
  const box = document.getElementById('vcFeedback');
  if (box) box.classList.add('hidden');
}

// ── Camera search ──────────────────────────────────────────────────────────
function vcSearch(cams, rawQuery) {
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

function vcFindCamera(query) {
  const raw = vcCurrentTranscript;

  // Search route cameras first — jump to it directly if found
  if (tvRouteCams && tvRouteCams.length) {
    const hit = vcSearch(tvRouteCams.map(rc => rc.cam), query);
    if (hit) {
      const idx = tvRouteCams.findIndex(rc => rc.cam === hit);
      if (idx >= 0) {
        tvDriveIndex = idx;
        tvShowDriveCam(idx);
        vcShowFeedback(raw, 'Showing: ' + hit.name);
        return;
      }
    }
  }

  // Not on route — stay in drive mode, show message
  const hit = vcSearch(allCameras, query);
  if (hit) {
    vcShowFeedback(raw, '"' + hit.name + '" is not on your current route');
    return;
  }

  vcShowFeedback(raw, 'No camera found for "' + query + '"');
}

// ── Command parser ─────────────────────────────────────────────────────────
function vcHandle(raw) {
  vcCurrentTranscript = raw;
  const t = raw.toLowerCase().trim();

  // N cameras ahead / forward
  let m = t.match(/\b(\w+)\s+cameras?\s+(ahead|forward)/);
  if (m) {
    const n = vcParseNum(m[1]);
    vcShowFeedback(raw, 'Jumping ' + n + ' camera' + (n !== 1 ? 's' : '') + ' ahead');
    tvDriveNav(n);
    return;
  }

  // N cameras back / behind
  m = t.match(/\b(\w+)\s+cameras?\s+(back|behind)/);
  if (m) {
    const n = vcParseNum(m[1]);
    vcShowFeedback(raw, 'Going back ' + n + ' camera' + (n !== 1 ? 's' : ''));
    tvDriveNav(-n);
    return;
  }

  // "next camera" / "go forward"
  if (/\bnext\s+camera\b/.test(t) || /\bgo\s+forward\b/.test(t)) {
    vcShowFeedback(raw, 'Next camera');
    tvDriveNav(1);
    return;
  }

  // "previous camera" / "go back"
  if (/\b(previous|prev)\s+camera\b/.test(t) || /\bgo\s+back\b/.test(t)) {
    vcShowFeedback(raw, 'Previous camera');
    tvDriveNav(-1);
    return;
  }

  // Feed mode: stream / live
  if (/\b(stream|live)\s*(mode)?\b/.test(t)) {
    if (typeof tvFeedMode !== 'undefined' && tvFeedMode !== 'stream') {
      document.getElementById('driveFeedToggle')?.click();
    }
    vcShowFeedback(raw, 'Switched to Stream mode');
    return;
  }

  // Feed mode: view / still
  if (/\b(view|still)\s*(mode)?\b/.test(t)) {
    if (typeof tvFeedMode !== 'undefined' && tvFeedMode !== 'view') {
      document.getElementById('driveFeedToggle')?.click();
    }
    vcShowFeedback(raw, 'Switched to View mode');
    return;
  }

  // "camera on/at/near ..."
  m = t.match(/camera\s+(?:on|at|near|along|for|in)?\s*(.{3,})/);
  if (m) { vcFindCamera(m[1].trim()); return; }

  // "show me ..." — catch-all location search
  m = t.match(/show\s+(?:me\s+)?(?:the\s+)?(.{3,})/);
  if (m) {
    const q = m[1].replace(/^camera\s+(?:on|at|near|in)?\s*/, '').trim();
    vcFindCamera(q);
    return;
  }

  vcShowFeedback(raw, 'Not understood — try "3 cameras ahead" or "camera on Herndon and Hwy 99"');
}

// ── SpeechRecognition lifecycle ────────────────────────────────────────────
function vcStartListening() {
  if (localStorage.getItem(VC_KEY) !== '1') {
    showToast('Voice commands are off — enable in Settings', '', 3000);
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showToast('Voice commands not supported in this browser', '', 3000);
    return;
  }

  // Tap again while listening → cancel
  if (vcActive) { vcStop(); return; }

  vcRecog                = new SR();
  vcRecog.lang           = 'en-US';
  vcRecog.interimResults = false;
  vcRecog.maxAlternatives = 3;

  vcSetState('listening');
  vcActive = true;

  vcRecog.onresult = e => {
    vcActive = false;
    vcSetState('processing');
    vcHandle(e.results[0][0].transcript);
    setTimeout(() => vcSetState('idle'), 1500);
  };

  vcRecog.onerror = e => {
    vcActive = false;
    vcSetState('idle');
    if (e.error === 'no-speech') {
      vcHideFeedback();
    } else if (e.error !== 'aborted') {
      vcShowFeedback('', 'Mic error: ' + e.error);
    }
  };

  vcRecog.onend = () => {
    if (vcActive) { vcActive = false; vcSetState('idle'); }
  };

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
