/* ═══════════════════════════════════════════
   CA Traffic Cams — Settings Panel
   Depends on globals from app.js and travel.js:
   fetchWithTimeout, showToast, NOMINATIM_URL,
   TV_QR_LABELS, TV_QR_PREFIX, tvSaveQR,
   tvLoadQR, tvRenderQuickRoutes, tvFeedMode,
   ROUTE_CORRIDOR_M (let, mutable)
════════════════════════════════════════════ */

'use strict';

const ST_FEED_KEY     = 'tfc_st_feed';
const ST_CORRIDOR_KEY = 'tfc_st_corridor';
const ST_BEHIND_KEY   = 'tfc_st_behind';
const ST_VOICE_KEY    = 'tfc_vc_enabled'; // shared with voice.js

// ── Open / Close ──────────────────────────────────────────────────────────
function stOpenPanel() {
  stPopulatePanel();
  document.getElementById('settingsPanel').classList.add('open');
  document.getElementById('settingsBackdrop').classList.remove('hidden');
}

function stClosePanel() {
  document.getElementById('settingsPanel').classList.remove('open');
  document.getElementById('settingsBackdrop').classList.add('hidden');
}

// ── Populate fields from storage ──────────────────────────────────────────
function stPopulatePanel() {
  ['home', 'work', 'ss'].forEach(key => {
    const pt    = tvLoadQR(key);
    const input = document.getElementById('st' + stCapKey(key) + 'Input');
    if (!input) return;
    input.value        = pt ? (pt.display || pt.label || '') : '';
    input._stPending   = null;
  });

  const feedPref = localStorage.getItem(ST_FEED_KEY) || 'view';
  document.querySelectorAll('#stFeedSeg .settings-seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === feedPref);
  });

  const corridor = localStorage.getItem(ST_CORRIDOR_KEY) || '1600';
  const sel = document.getElementById('stCorridorSel');
  if (sel) sel.value = corridor;

  const behind = document.getElementById('stBehindToggle');
  if (behind) behind.checked = localStorage.getItem(ST_BEHIND_KEY) === '1';

  const voice = document.getElementById('stVoiceToggle');
  if (voice) voice.checked = localStorage.getItem(ST_VOICE_KEY) === '1';

  // Show API key row only when voice is enabled; mask saved key
  const apiRow = document.getElementById('stApiKeyRow');
  if (apiRow) apiRow.classList.toggle('hidden', localStorage.getItem(ST_VOICE_KEY) !== '1');
  const apiInput = document.getElementById('stApiKeyInput');
  if (apiInput) apiInput.value = localStorage.getItem('tfc_vc_apikey') ? '••••••••••••••••' : '';
}

function stCapKey(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// ── Nominatim autocomplete ────────────────────────────────────────────────
let stSuggestTimer = null;

function stAttachSuggest(inputId, suggestId, onSelect) {
  const input   = document.getElementById(inputId);
  const suggest = document.getElementById(suggestId);
  if (!input || !suggest) return;

  input.addEventListener('input', () => {
    clearTimeout(stSuggestTimer);
    const q = input.value.trim();
    if (q.length < 3) { suggest.classList.add('hidden'); suggest.innerHTML = ''; return; }
    stSuggestTimer = setTimeout(async () => {
      try {
        const url = NOMINATIM_URL + '?format=json&limit=5&countrycodes=us&q=' + encodeURIComponent(q);
        const res = await fetchWithTimeout(url, 6000, { headers: { Accept: 'application/json' } });
        const data = await res.json();
        suggest.innerHTML = '';
        if (!data.length) { suggest.classList.add('hidden'); return; }
        data.forEach(item => {
          const row = document.createElement('div');
          row.className = 'route-suggest-item';
          row.textContent = item.display_name;
          row.addEventListener('mousedown', e => {
            e.preventDefault();
            input.value      = item.display_name;
            input._stPending = { lat: parseFloat(item.lat), lng: parseFloat(item.lon), display: item.display_name, label: item.display_name };
            onSelect(input._stPending);
            suggest.classList.add('hidden');
          });
          suggest.appendChild(row);
        });
        suggest.classList.remove('hidden');
      } catch (_) { suggest.classList.add('hidden'); }
    }, 360);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => suggest.classList.add('hidden'), 200);
  });
}

// ── Save / Clear quick route from settings ────────────────────────────────
function stSaveQRFromInput(key) {
  const input = document.getElementById('st' + stCapKey(key) + 'Input');
  if (!input) return;
  const val = input.value.trim();
  if (!val) { showToast('Enter an address first', '', 2500); return; }

  if (input._stPending) {
    tvSaveQR(key, input._stPending);
    input._stPending = null;
    showToast(TV_QR_LABELS[key] + ' saved', '', 2000);
    tvRenderQuickRoutes();
    return;
  }

  const url = NOMINATIM_URL + '?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(val);
  fetchWithTimeout(url, 7000, { headers: { Accept: 'application/json' } })
    .then(r => r.json())
    .then(data => {
      if (!data.length) { showToast('Address not found — try a more specific address', '', 3500); return; }
      const item = data[0];
      const pt   = { lat: parseFloat(item.lat), lng: parseFloat(item.lon), display: item.display_name, label: item.display_name };
      tvSaveQR(key, pt);
      input.value      = item.display_name;
      input._stPending = null;
      showToast(TV_QR_LABELS[key] + ' saved', '', 2000);
      tvRenderQuickRoutes();
    })
    .catch(() => showToast('Could not geocode address', '', 3000));
}

function stClearQRKey(key) {
  localStorage.removeItem(TV_QR_PREFIX + key);
  const input = document.getElementById('st' + stCapKey(key) + 'Input');
  if (input) { input.value = ''; input._stPending = null; }
  showToast(TV_QR_LABELS[key] + ' cleared', '', 2000);
  tvRenderQuickRoutes();
}

// ── Data management ────────────────────────────────────────────────────────
function stClearUnavailCache() {
  localStorage.removeItem('tfc_unavail_v1');
  showToast('Unavailable camera cache cleared', '', 2500);
}

function stClearAllQR() {
  Object.keys(TV_QR_LABELS).forEach(key => localStorage.removeItem(TV_QR_PREFIX + key));
  stPopulatePanel();
  tvRenderQuickRoutes();
  showToast('Quick route locations cleared', '', 2500);
}

// ── Exported preference readers (used by travel.js at runtime) ────────────
function stReadFeedPref()     { return localStorage.getItem(ST_FEED_KEY)     || 'view'; }
function stReadCorridorPref() { return parseInt(localStorage.getItem(ST_CORRIDOR_KEY) || '1600', 10); }

// ── Init ──────────────────────────────────────────────────────────────────
(function stInit() {
  // Apply saved preferences at startup
  tvFeedMode       = stReadFeedPref();
  ROUTE_CORRIDOR_M = stReadCorridorPref();

  document.getElementById('settingsBtn').addEventListener('click', stOpenPanel);
  document.getElementById('settingsClose').addEventListener('click', stClosePanel);
  document.getElementById('settingsBackdrop').addEventListener('click', stClosePanel);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('settingsPanel').classList.contains('open')) {
      stClosePanel();
    }
  });

  // Quick route save / clear buttons
  ['home', 'work', 'ss'].forEach(key => {
    const cap = stCapKey(key);
    const saveBtn  = document.getElementById('st' + cap + 'Save');
    const clearBtn = document.getElementById('st' + cap + 'Clear');
    if (saveBtn)  saveBtn.addEventListener('click', () => stSaveQRFromInput(key));
    if (clearBtn) clearBtn.addEventListener('click', () => stClearQRKey(key));
    stAttachSuggest('st' + cap + 'Input', 'st' + cap + 'Suggest', () => {});
  });

  // Feed segmented control
  document.querySelectorAll('#stFeedSeg .settings-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#stFeedSeg .settings-seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      localStorage.setItem(ST_FEED_KEY, btn.dataset.val);
      tvFeedMode = btn.dataset.val;
    });
  });

  // Corridor select
  const corridorSel = document.getElementById('stCorridorSel');
  if (corridorSel) {
    corridorSel.addEventListener('change', () => {
      const val = parseInt(corridorSel.value, 10);
      localStorage.setItem(ST_CORRIDOR_KEY, corridorSel.value);
      ROUTE_CORRIDOR_M = val;
    });
  }

  // Behind Mode toggle
  const behindToggle = document.getElementById('stBehindToggle');
  if (behindToggle) {
    behindToggle.addEventListener('change', () => {
      localStorage.setItem(ST_BEHIND_KEY, behindToggle.checked ? '1' : '0');
    });
  }

  // Voice Commands toggle
  const voiceToggle = document.getElementById('stVoiceToggle');
  const apiKeyRow   = document.getElementById('stApiKeyRow');
  if (voiceToggle) {
    voiceToggle.addEventListener('change', () => {
      localStorage.setItem(ST_VOICE_KEY, voiceToggle.checked ? '1' : '0');
      if (apiKeyRow) apiKeyRow.classList.toggle('hidden', !voiceToggle.checked);
      if (typeof vcUpdateBtn === 'function') vcUpdateBtn();
    });
  }

  // API key save / clear
  const apiInput = document.getElementById('stApiKeyInput');
  document.getElementById('stApiKeySave')?.addEventListener('click', () => {
    if (!apiInput) return;
    const val = apiInput.value.trim();
    if (!val || val.startsWith('•')) { showToast('Paste your API key first', '', 2500); return; }
    localStorage.setItem('tfc_vc_apikey', val);
    apiInput.value = '••••••••••••••••';
    showToast('API key saved', '', 2000);
  });
  document.getElementById('stApiKeyClear')?.addEventListener('click', () => {
    localStorage.removeItem('tfc_vc_apikey');
    if (apiInput) apiInput.value = '';
    showToast('API key removed', '', 2000);
  });
  // Clear the masked placeholder when user focuses the field to type a real key
  if (apiInput) {
    apiInput.addEventListener('focus', () => {
      if (apiInput.value.startsWith('•')) apiInput.value = '';
    });
  }

  // Data management
  document.getElementById('stClearCache').addEventListener('click', stClearUnavailCache);
  document.getElementById('stClearQR').addEventListener('click', stClearAllQR);
}());
