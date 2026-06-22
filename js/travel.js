/* ═══════════════════════════════════════════
   CA Traffic Cams — Travel Mode
   Route planning (OSRM + Nominatim) and a
   full-screen Driving Mode that shows the next
   camera ahead along your route.

   Shares globals from app.js (classic scripts
   share the page's global scope): map, allCameras,
   fetchWithTimeout, showToast, isMobile, openCamera,
   escHtml, userLatLng.
════════════════════════════════════════════ */

'use strict';

// ── Free, key-less, CORS-friendly services ──
const OSRM_URL       = 'https://router.project-osrm.org/route/v1/driving/';
const NOMINATIM_URL  = 'https://nominatim.openstreetmap.org/search';
let ROUTE_CORRIDOR_M = 1600; // cameras within ~1 mile of the route count as "on route"

// ── State ──
let tvMode       = 'browse';
let tvRoutePts   = null;   // sampled route points [{lat,lng}]
let tvRouteCum   = null;   // cumulative metres along tvRoutePts
let tvRouteLayer = null;   // Leaflet layer group for line + pins
let tvRouteCams  = [];     // [{cam, idx, dist, along}] sorted by distance along route
let tvStartPt    = null;   // {lat,lng,label}
let tvEndPt      = null;
let tvPanelOpen  = false;  // mobile slide-over state

// ── Driving state ──
let tvDriving    = false;
let tvDriveWatch = null;
let tvDriveTimer = null;
let tvWakeLock   = null;
let tvDriveIndex = 0;
let tvAutoFollow = true;
let tvFeedMode   = 'view';  // 'view' | 'stream'
let tvDriveHls   = null;

// ── Quick Routes ──────────────────────────────────────────────────────────
const TV_QR_LABELS  = { home: 'Home', work: 'Work', ss: 'SS' };
const TV_QR_PREFIX  = 'tfc_qr_v1_';

function tvLoadQR(key) {
  try { const r = localStorage.getItem(TV_QR_PREFIX + key); return r ? JSON.parse(r) : null; }
  catch(e) { return null; }
}
function tvSaveQR(key, pt) {
  try { localStorage.setItem(TV_QR_PREFIX + key, JSON.stringify(pt)); } catch(e) {}
}

function tvRenderQuickRoutes() {
  Object.keys(TV_QR_LABELS).forEach(key => {
    const pt   = tvLoadQR(key);
    const btn  = document.getElementById('qr_' + key);
    const addr = document.getElementById('qr_addr_' + key);
    if (!btn || !addr) return;
    if (pt) {
      btn.classList.add('qr-set');
      // Shorten to first meaningful segment for display
      const display = (pt.display || pt.label || '').split(',')[0].trim();
      addr.textContent = display || TV_QR_LABELS[key];
      btn.title = pt.display || pt.label || '';
    } else {
      btn.classList.remove('qr-set');
      addr.textContent = 'Not set — configure in Settings';
    }
  });
}

function tvUseQuickRoute(key) {
  const pt = tvLoadQR(key);
  if (!pt) {
    showToast('No address saved for ' + TV_QR_LABELS[key] + ' — plan a route and tap Save destination', '', 4000);
    return;
  }
  document.getElementById('routeEnd').value = pt.display || pt.label;
  tvEndPt = pt;
  tvGetRoute();
}

function tvSaveAs(key) {
  if (!tvEndPt) { showToast('Plan a route first', 'error'); return; }
  const pt = { lat: tvEndPt.lat, lng: tvEndPt.lng, label: tvEndPt.label, display: tvEndPt.label };
  tvSaveQR(key, pt);
  tvRenderQuickRoutes();
  // Flash the button saved state briefly
  const btn = document.querySelector('.save-as-btn[data-key="' + key + '"]');
  if (btn) {
    btn.classList.add('saved');
    btn.textContent = '✓ ' + TV_QR_LABELS[key];
    setTimeout(() => { btn.classList.remove('saved'); btn.textContent = TV_QR_LABELS[key]; }, 2000);
  }
  showToast('Saved as ' + TV_QR_LABELS[key], 'success', 2000);
}

// ── Geometry helpers ──
function tvMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function tvMiles(m) {
  const mi = m / 1609.34;
  if (mi < 0.1) return Math.round(m / 0.3048) + ' ft';
  return mi.toFixed(mi < 10 ? 1 : 0) + ' mi';
}
function tvDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function tvCachedLoc() {
  try { return userLatLng || null; } catch (e) { return null; }
}

// ── Geocoding (Nominatim) ──
async function tvGeocode(query) {
  const params = new URLSearchParams({
    format: 'json', limit: '5', countrycodes: 'us', q: query,
  });
  const r = await fetchWithTimeout(NOMINATIM_URL + '?' + params, 8000,
    { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('geocode HTTP ' + r.status);
  return await r.json();
}

function tvGetMyLocation() {
  return new Promise((resolve, reject) => {
    const cached = tvCachedLoc();
    if (cached) { resolve({ lat: cached.lat, lng: cached.lng, label: 'My Location' }); return; }
    if (!navigator.geolocation) { reject(new Error('Geolocation unsupported')); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, label: 'My Location' }),
      e => reject(e),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
    );
  });
}

// Type-ahead suggestions on an input
function tvAttachSuggest(input, box, onPick) {
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3 || /^my location$/i.test(q)) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const res = await tvGeocode(q);
        if (!res.length) { box.classList.add('hidden'); return; }
        box.innerHTML = '';
        res.forEach(r => {
          const item = document.createElement('div');
          item.className = 'route-suggest-item';
          item.textContent = r.display_name;
          item.addEventListener('mousedown', e => {
            e.preventDefault(); // keep before blur
            input.value = r.display_name;
            box.classList.add('hidden');
            onPick({ lat: parseFloat(r.lat), lng: parseFloat(r.lon), label: r.display_name });
          });
          box.appendChild(item);
        });
        box.classList.remove('hidden');
      } catch (e) { box.classList.add('hidden'); }
    }, 400);
  });
  input.addEventListener('blur', () => setTimeout(() => box.classList.add('hidden'), 150));
}

// Resolve a field to coordinates: cached pick → My Location → fresh geocode
async function tvResolvePoint(text, cached, allowMyLoc) {
  text = (text || '').trim();
  if (allowMyLoc && (!text || /^my location$/i.test(text))) return tvGetMyLocation();
  if (cached && cached.label === text) return cached;
  const g = await tvGeocode(text);
  if (!g.length) return null;
  return { lat: parseFloat(g[0].lat), lng: parseFloat(g[0].lon), label: g[0].display_name };
}

// ── OSRM route ──
async function tvFetchRoute(s, e) {
  const url = OSRM_URL + s.lng + ',' + s.lat + ';' + e.lng + ',' + e.lat +
              '?overview=full&geometries=geojson&steps=false&alternatives=false';
  const r = await fetchWithTimeout(url, 13000);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error('No route found');
  const rt = j.routes[0];
  return {
    coords:   rt.geometry.coordinates.map(c => ({ lng: c[0], lat: c[1] })),
    distance: rt.distance, // metres
    duration: rt.duration, // seconds
  };
}

function tvPinIcon(kind) {
  return L.divIcon({
    html: '<div class="route-map-pin ' + kind + '"></div>',
    className: '', iconSize: [18, 18], iconAnchor: [9, 9],
  });
}

function tvClearRouteLayer() {
  if (tvRouteLayer) { map.removeLayer(tvRouteLayer); tvRouteLayer = null; }
}

function tvDrawRoute(coords, s, e) {
  tvClearRouteLayer();
  tvRouteLayer = L.layerGroup().addTo(map);
  const latlngs = coords.map(c => [c.lat, c.lng]);
  L.polyline(latlngs, { color: '#000', weight: 9, opacity: .25 }).addTo(tvRouteLayer);
  L.polyline(latlngs, { color: '#4a9fff', weight: 5, opacity: .95 }).addTo(tvRouteLayer);
  L.marker([s.lat, s.lng], { icon: tvPinIcon('start') }).addTo(tvRouteLayer);
  L.marker([e.lat, e.lng], { icon: tvPinIcon('end') }).addTo(tvRouteLayer);
  map.fitBounds(L.latLngBounds(latlngs), { padding: [50, 50] });
}

// Find every camera within the route corridor, ordered along the route
function tvComputeRouteCams(coords) {
  // Sample long routes down to keep the matching loop fast
  let pts = coords;
  if (coords.length > 700) {
    const stride = Math.ceil(coords.length / 700);
    pts = coords.filter((_, i) => i % stride === 0);
  }
  tvRoutePts = pts;

  tvRouteCum = [0];
  for (let i = 1; i < pts.length; i++) {
    tvRouteCum[i] = tvRouteCum[i - 1] +
      tvMeters(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
  }

  // Bounding-box pre-filter (~3 km margin) before the precise corridor check
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  pts.forEach(c => {
    if (c.lat < minLat) minLat = c.lat; if (c.lat > maxLat) maxLat = c.lat;
    if (c.lng < minLng) minLng = c.lng; if (c.lng > maxLng) maxLng = c.lng;
  });
  const m = 0.03;
  const cands = allCameras.filter(c =>
    c.lat >= minLat - m && c.lat <= maxLat + m &&
    c.lng >= minLng - m && c.lng <= maxLng + m);

  const out = [];
  cands.forEach(cam => {
    let best = Infinity, bestI = -1;
    for (let i = 0; i < pts.length; i++) {
      const d = tvMeters(cam.lat, cam.lng, pts[i].lat, pts[i].lng);
      if (d < best) { best = d; bestI = i; }
    }
    if (best <= ROUTE_CORRIDOR_M) out.push({ cam, idx: bestI, dist: best, along: tvRouteCum[bestI] });
  });
  out.sort((a, b) => a.along - b.along);
  return out;
}

// ── Get Route handler ──
async function tvGetRoute() {
  const startInput = document.getElementById('routeStart');
  const endInput   = document.getElementById('routeEnd');
  const goBtn      = document.getElementById('routeGoBtn');

  if (!endInput.value.trim()) { showToast('Enter a destination', 'error'); endInput.focus(); return; }

  goBtn.disabled = true;
  goBtn.classList.add('loading');
  showToast('Finding route…', '', 8000);

  try {
    const [start, end] = await Promise.all([
      tvResolvePoint(startInput.value, tvStartPt, true),
      tvResolvePoint(endInput.value, tvEndPt, false),
    ]);
    if (!start) { showToast('Could not find start location', 'error'); return; }
    if (!end)   { showToast('Could not find destination', 'error'); return; }
    tvStartPt = start; tvEndPt = end;
    if (start.label === 'My Location') startInput.value = 'My Location';

    const route = await tvFetchRoute(start, end);
    tvDrawRoute(route.coords, start, end);
    tvRouteCams = tvComputeRouteCams(route.coords);

    // Summary
    document.getElementById('routeDistance').textContent = tvMiles(route.distance);
    document.getElementById('routeDuration').textContent = tvDuration(route.duration);
    document.getElementById('routeCamCount').textContent = tvRouteCams.length.toLocaleString();
    document.getElementById('routeSummary').classList.remove('hidden');
    document.getElementById('travelHelp').classList.add('hidden');

    tvRenderRouteCamList();
    showToast('Route ready · ' + tvRouteCams.length + ' cameras along the way', 'success', 3000);
    // Reset save-as button labels and reveal the row
    document.querySelectorAll('.save-as-btn').forEach(b => {
      b.classList.remove('saved');
      b.textContent = TV_QR_LABELS[b.dataset.key] || b.dataset.key;
    });
  } catch (e) {
    console.warn('[Travel] route failed:', e.message);
    showToast('Route failed — check the addresses and try again', 'error', 5000);
  } finally {
    goBtn.disabled = false;
    goBtn.classList.remove('loading');
  }
}

function tvRenderRouteCamList() {
  const section = document.getElementById('routeCamsSection');
  const list    = document.getElementById('routeCamList');
  section.classList.toggle('hidden', !tvRouteCams.length);
  list.innerHTML = '';
  if (!tvRouteCams.length) return;

  const frag = document.createDocumentFragment();
  tvRouteCams.forEach((rc, i) => {
    const cam = rc.cam;
    const colorClass = cam.unavailable ? 'dot-unavailable'
      : cam.type === 'both' ? 'dot-both'
      : cam.type === 'video' ? 'dot-video'
      : cam.type === 'still' ? 'dot-still' : 'dot-unknown';

    const item = document.createElement('div');
    item.className = 'route-cam-item';
    item.innerHTML =
      '<div class="route-cam-num">' + (i + 1) + '</div>' +
      '<span class="cam-dot ' + colorClass + '"></span>' +
      '<div class="route-cam-info">' +
        '<div class="route-cam-name">' + escHtml(cam.name) + '</div>' +
        '<div class="route-cam-road">' + escHtml(cam.roadway || cam.distName) +
          ' · ' + tvMiles(rc.along) + ' in</div>' +
      '</div>';
    item.addEventListener('click', () => {
      if (typeof openCamera === 'function') openCamera(cam);
      if (isMobile()) tvCloseMobilePanel();
    });
    frag.appendChild(item);
  });
  list.appendChild(frag);
}

function tvClearRoute() {
  tvClearRouteLayer();
  tvRouteCams = []; tvRoutePts = null; tvRouteCum = null;
  tvStartPt = null; tvEndPt = null;
  document.getElementById('routeStart').value = '';
  document.getElementById('routeEnd').value = '';
  document.getElementById('routeSummary').classList.add('hidden');
  document.getElementById('routeCamsSection').classList.add('hidden');
  document.getElementById('travelHelp').classList.remove('hidden');
}

// ── Driving Mode ───────────────────────────────────────────────────────────
async function tvRequestWake() {
  try { if ('wakeLock' in navigator) tvWakeLock = await navigator.wakeLock.request('screen'); }
  catch (e) {}
}
function tvReleaseWake() {
  if (tvWakeLock) { try { tvWakeLock.release(); } catch (e) {} tvWakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (tvDriving && document.visibilityState === 'visible' && !tvWakeLock) tvRequestWake();
});

function tvStartDriving() {
  if (!tvRouteCams.length) { showToast('No cameras found on this route', 'error'); return; }
  tvDriving = true; tvAutoFollow = true; tvDriveIndex = 0;
  document.getElementById('driveOverlay').classList.remove('hidden');
  tvRequestWake();
  tvShowDriveCam(0);
  tvDriveTimer = setInterval(tvRefreshDriveImg, 8000);
  if (navigator.geolocation) {
    tvDriveWatch = navigator.geolocation.watchPosition(
      tvOnDrivePos, () => {},
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  }
  showToast('Driving mode active — screen will stay on', 'success', 3000);
}

function tvStopDriving() {
  tvDriving = false;
  tvStopDriveStream();
  tvSetStreamStatus('', '');
  document.getElementById('driveOverlay').classList.add('hidden');
  if (tvDriveWatch !== null) { navigator.geolocation.clearWatch(tvDriveWatch); tvDriveWatch = null; }
  if (tvDriveTimer) { clearInterval(tvDriveTimer); tvDriveTimer = null; }
  tvReleaseWake();
}

// ── View / Stream feed mode ────────────────────────────────────────────────
function tvToggleFeedMode() {
  tvFeedMode = tvFeedMode === 'view' ? 'stream' : 'view';
  const btn = document.getElementById('driveFeedToggle');
  const isStream = tvFeedMode === 'stream';
  btn.classList.toggle('stream-active', isStream);
  btn.querySelector('.drive-toggle-label').textContent = isStream ? 'Stream' : 'View';

  if (!isStream) {
    // Switched back to View — kill the video, still is already loaded
    tvStopDriveStream();
    tvSetStreamStatus('', '');
  } else {
    // Switched to Stream — attempt HLS for the current cam (still stays visible as placeholder)
    const rc = tvRouteCams[tvDriveIndex];
    if (rc) tvAttemptDriveStream(rc.cam);
  }
}

function tvSetStreamStatus(text, state) {
  // state: '' | 'loading' | 'live' | 'error' | 'none'
  const el = document.getElementById('driveStreamStatus');
  if (!el) return;
  if (!text) { el.classList.add('hidden'); return; }
  el.textContent = text;
  el.className = 'drive-stream-status drive-stream-' + (state || '');
}

function tvStopDriveStream() {
  if (tvDriveHls) { tvDriveHls.destroy(); tvDriveHls = null; }
  const video = document.getElementById('driveVideo');
  if (video) { video.pause(); video.src = ''; video.load(); video.style.opacity = ''; video.classList.add('hidden'); }
  // Restore the still image — it's always loaded behind the video
  const img = document.getElementById('driveImage');
  if (img) img.style.opacity = img.getAttribute('data-loaded') === '1' ? '1' : '0';
}

function tvAttemptDriveStream(cam) {
  const video = document.getElementById('driveVideo');
  const img   = document.getElementById('driveImage');
  if (!video) return;

  tvStopDriveStream(); // tear down any previous stream first

  if (!cam.streamUrl) {
    tvSetStreamStatus('Still only — no live stream for this camera', 'none');
    return;
  }

  // Still image stays fully visible as placeholder while stream loads
  if (img && img.getAttribute('data-loaded') === '1') img.style.opacity = '1';
  tvSetStreamStatus('Connecting to live stream…', 'loading');

  function onStreamReady() {
    video.classList.remove('hidden');
    video.style.opacity = '1';
    if (img) img.style.opacity = '0'; // video is on top now
    tvSetStreamStatus('● Live', 'live');
  }
  function onStreamFail() {
    tvStopDriveStream();
    tvSetStreamStatus('Stream unavailable — showing still image', 'error');
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = cam.streamUrl;
    video.load();
    video.play().catch(() => {});
    video.addEventListener('canplay', onStreamReady, { once: true });
    video.addEventListener('error',   onStreamFail,  { once: true });
  } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    tvDriveHls = new Hls({ enableWorker: false, fragLoadingTimeOut: 8000, manifestLoadingTimeOut: 8000 });
    tvDriveHls.loadSource(cam.streamUrl);
    tvDriveHls.attachMedia(video);
    tvDriveHls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      onStreamReady();
    });
    tvDriveHls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) onStreamFail();
    });
  } else {
    tvSetStreamStatus('Live streaming not supported in this browser', 'error');
  }
}

function tvOnDrivePos(p) {
  if (!tvAutoFollow || !tvRoutePts) return;
  const lat = p.coords.latitude, lng = p.coords.longitude;
  let best = Infinity, curI = 0;
  for (let i = 0; i < tvRoutePts.length; i++) {
    const d = tvMeters(lat, lng, tvRoutePts[i].lat, tvRoutePts[i].lng);
    if (d < best) { best = d; curI = i; }
  }
  const curAlong = tvRouteCum[curI];
  let nextIdx = tvRouteCams.findIndex(rc => rc.along > curAlong + 80);
  if (nextIdx < 0) nextIdx = tvRouteCams.length - 1;

  if (nextIdx !== tvDriveIndex) {
    tvDriveIndex = nextIdx;
    tvShowDriveCam(nextIdx);
  }
  tvUpdateAhead(curAlong);
}

function tvUpdateAhead(curAlong) {
  const rc = tvRouteCams[tvDriveIndex];
  if (!rc) return;
  const ahead = rc.along - curAlong;
  document.getElementById('driveAhead').textContent =
    ahead > 30 ? tvMiles(ahead) + ' ahead' : 'Here now';
}

function tvShowDriveCam(idx) {
  const rc = tvRouteCams[idx];
  if (!rc) return;
  const cam = rc.cam;
  document.getElementById('driveCamName').textContent = cam.name;
  document.getElementById('driveCamMeta').textContent =
    [cam.roadway, cam.direction, cam.distName].filter(Boolean).join(' · ');
  document.getElementById('driveAhead').textContent =
    (idx + 1) + ' / ' + tvRouteCams.length;

  const next = tvRouteCams[idx + 1];
  document.getElementById('driveNext').textContent =
    next ? 'Next: ' + next.cam.name : 'Final camera on route';

  document.getElementById('drivePrevBtn').disabled = idx <= 0;
  document.getElementById('driveNextBtn').disabled = idx >= tvRouteCams.length - 1;

  // Always load the still first (instant feedback / View Mode / stream fallback)
  tvLoadDriveImg(cam);
  if (tvFeedMode === 'stream') {
    tvAttemptDriveStream(cam);
  } else {
    tvSetStreamStatus('', ''); // clear any leftover badge in View Mode
  }
}

function tvRefreshDriveImg() {
  const rc = tvRouteCams[tvDriveIndex];
  if (!rc) return;
  if (tvFeedMode === 'view') {
    // View Mode: refresh the still on every tick
    tvLoadDriveImg(rc.cam);
  } else {
    // Stream Mode: if stream died, try to reconnect; otherwise leave it running
    const video = document.getElementById('driveVideo');
    if (video && video.paused && !video.src) tvAttemptDriveStream(rc.cam);
  }
}

function tvLoadDriveImg(cam) {
  const img  = document.getElementById('driveImage');
  const load = document.getElementById('driveImageLoading');
  const ov   = document.getElementById('driveImageOverlay');
  const msg  = document.getElementById('driveOverlayMsg');

  if (!cam || !cam.imageUrl) {
    load.classList.add('hidden');
    msg.textContent = 'No still image for this camera';
    ov.classList.remove('hidden');
    img.style.opacity = '0';
    return;
  }
  ov.classList.add('hidden');
  load.classList.remove('hidden');

  const src = cam.imageUrl + '?t=' + Date.now();
  const tmp = new Image();
  let done = false;
  const timer = setTimeout(() => {
    if (done) return; done = true;
    load.classList.add('hidden');
    msg.textContent = 'Image unavailable';
    ov.classList.remove('hidden');
  }, 12000);

  tmp.onload = () => {
    if (done) return; done = true; clearTimeout(timer);
    img.src = src; img.style.opacity = '1'; img.setAttribute('data-loaded', '1');
    load.classList.add('hidden');
  };
  tmp.onerror = () => {
    if (done) return; done = true; clearTimeout(timer);
    load.classList.add('hidden');
    msg.textContent = 'Image unavailable';
    ov.classList.remove('hidden');
  };
  tmp.src = src;
}

function tvDriveNav(delta) {
  const n = tvDriveIndex + delta;
  if (n < 0 || n >= tvRouteCams.length) return;
  tvAutoFollow = false; // manual override stops GPS auto-advance
  tvDriveIndex = n;
  tvShowDriveCam(n);
}

// ── Mode switching ─────────────────────────────────────────────────────────
function tvSetMode(mode) {
  if (mode === tvMode) return;
  tvMode = mode;
  const travel = mode === 'travel';
  document.body.classList.toggle('mode-travel', travel);

  document.getElementById('modeBrowse').classList.toggle('active', !travel);
  document.getElementById('modeTravel').classList.toggle('active', travel);
  document.getElementById('modeBrowse').setAttribute('aria-selected', String(!travel));
  document.getElementById('modeTravel').setAttribute('aria-selected', String(travel));

  if (travel && isMobile()) tvOpenMobilePanel();
  else tvCloseMobilePanel();

  setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 220);
}

function tvOpenMobilePanel() {
  document.getElementById('travelPanel').classList.add('mobile-open');
  tvPanelOpen = true;
}
function tvCloseMobilePanel() {
  document.getElementById('travelPanel').classList.remove('mobile-open');
  tvPanelOpen = false;
}

// ── Wiring ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modeBrowse').addEventListener('click', () => tvSetMode('browse'));
  document.getElementById('modeTravel').addEventListener('click', () => tvSetMode('travel'));

  // Quick route buttons
  document.querySelectorAll('.quick-route-btn').forEach(btn => {
    btn.addEventListener('click', () => tvUseQuickRoute(btn.dataset.key));
  });
  // Save-as buttons
  document.querySelectorAll('.save-as-btn').forEach(btn => {
    btn.addEventListener('click', () => tvSaveAs(btn.dataset.key));
  });
  // Init quick route display
  tvRenderQuickRoutes();

  document.getElementById('routeGoBtn').addEventListener('click', tvGetRoute);
  document.getElementById('routeClearBtn').addEventListener('click', tvClearRoute);
  document.getElementById('driveBtn').addEventListener('click', tvStartDriving);

  document.getElementById('routeEnd').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); tvGetRoute(); }
  });
  document.getElementById('routeStartLoc').addEventListener('click', () => {
    document.getElementById('routeStart').value = 'My Location';
    tvStartPt = null;
  });

  tvAttachSuggest(document.getElementById('routeStart'),
    document.getElementById('startSuggest'), pt => { tvStartPt = pt; });
  tvAttachSuggest(document.getElementById('routeEnd'),
    document.getElementById('endSuggest'), pt => { tvEndPt = pt; });

  // Driving overlay
  document.getElementById('driveExitBtn').addEventListener('click', tvStopDriving);
  document.getElementById('drivePrevBtn').addEventListener('click', () => tvDriveNav(-1));
  document.getElementById('driveNextBtn').addEventListener('click', () => tvDriveNav(1));
  document.getElementById('driveFeedToggle').addEventListener('click', tvToggleFeedMode);

  // Mobile: menu button toggles the travel panel while in travel mode
  document.getElementById('menuBtn').addEventListener('click', () => {
    if (tvMode === 'travel' && isMobile()) {
      tvPanelOpen ? tvCloseMobilePanel() : tvOpenMobilePanel();
    }
  });
  // Tapping the map closes the mobile travel panel
  map.on('click', () => { if (tvPanelOpen) tvCloseMobilePanel(); });

  // Escape exits driving mode
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && tvDriving) tvStopDriving();
  });
});
