/* ═══════════════════════════════════════════
   CA Traffic Cams — Password Gate

   Simple client-side access gate to keep casual/shared use down (which
   was tripping Caltrans rate limits). One successful login is remembered
   for 30 days on the device — no re-login within that window.

   Note: this is a deterrent, not real security — a determined user can
   read the page source. The password is stored here only as a SHA-256
   hash so the plaintext isn't sitting in the source.
════════════════════════════════════════════ */

'use strict';

const AUTH_KEY  = 'tfc_auth_v1';
const AUTH_DAYS = 30;
// SHA-256("TrafficCamera645")
const AUTH_HASH = '79120fd99230e32b5b0303d9d26cbc807cd8f533a799a8aacbce406e4b7d5ed7';

function tfcIsAuthed() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return false;
    const ts = JSON.parse(raw).ts;
    return !!ts && (Date.now() - ts) < AUTH_DAYS * 864e5;
  } catch (_) { return false; }
}
window.tfcIsAuthed = tfcIsAuthed;

async function tfcHash(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function tfcRevealApp() {
  document.documentElement.classList.add('tfc-authed');
  const gate = document.getElementById('loginGate');
  if (gate) {
    gate.classList.add('closing');
    setTimeout(() => { gate.style.display = 'none'; }, 300);
  }
  // The map was built underneath a full-screen gate — resize it now that it's visible
  try { if (window._leafletMap) window._leafletMap.invalidateSize(); } catch (_) {}
}

// Log out and return to the gate (exposed for a Settings button)
function tfcLock() {
  try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
  location.reload();
}
window.tfcLock = tfcLock;

document.addEventListener('DOMContentLoaded', () => {
  const gate  = document.getElementById('loginGate');
  const form  = document.getElementById('loginForm');
  const input = document.getElementById('loginInput');
  const errEl = document.getElementById('loginError');
  const btn   = document.getElementById('loginBtn');

  // Already logged in within the last 30 days — skip the gate entirely
  if (tfcIsAuthed()) {
    document.documentElement.classList.add('tfc-authed');
    if (gate) gate.style.display = 'none';
    return;
  }

  if (gate)  gate.style.display = '';
  if (input) setTimeout(() => input.focus(), 100);

  if (form) form.addEventListener('submit', async e => {
    e.preventDefault();
    const val = (input.value || '').trim();
    if (!val) return;

    if (btn) btn.disabled = true;
    let ok = false;
    try { ok = (await tfcHash(val)) === AUTH_HASH; } catch (_) { ok = false; }
    if (btn) btn.disabled = false;

    if (ok) {
      try { localStorage.setItem(AUTH_KEY, JSON.stringify({ ts: Date.now() })); } catch (_) {}
      if (errEl) errEl.classList.add('hidden');
      tfcRevealApp();
      // Start the app if it deferred loading until unlock
      if (typeof window.tfcOnUnlock === 'function') {
        const fn = window.tfcOnUnlock;
        window.tfcOnUnlock = null;
        fn();
      }
    } else {
      if (errEl) errEl.classList.remove('hidden');
      if (input) { input.value = ''; input.focus(); }
      const box = gate && gate.querySelector('.login-box');
      if (box) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }
    }
  });
});
