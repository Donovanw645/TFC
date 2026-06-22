/* ═══════════════════════════════════════════
   CA Traffic Cams — App Logic
   Pulls live data from Caltrans CWWP2 API
════════════════════════════════════════════ */

'use strict';

// ── On-screen debug panel (append ?debug to URL) ──
const DEBUG = location.search.includes('debug');
if (DEBUG) {
  const box = document.createElement('div');
  box.id = 'debugBox';
  box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:40vh;overflow-y:auto;background:rgba(0,0,0,.92);color:#4ade80;font:11px/1.5 monospace;padding:8px 10px;z-index:9999;border-top:1px solid #333';
  document.body.appendChild(box);
  ['log','warn','error'].forEach(function(lvl) {
    var orig = console[lvl].bind(console);
    console[lvl] = function() {
      orig.apply(console, arguments);
      var line = document.createElement('div');
      line.style.color = lvl === 'error' ? '#f87171' : lvl === 'warn' ? '#fbbf24' : '#4ade80';
      line.textContent = '[' + lvl + '] ' + Array.from(arguments).map(function(a) {
        return typeof a === 'object' ? JSON.stringify(a) : String(a);
      }).join(' ');
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
    };
  });
  console.log('Debug mode on — ' + new Date().toLocaleTimeString());
}

// ── Constants ──────────────────────────────
const BASE_URL    = 'https://cwwp2.dot.ca.gov';
const DISTRICTS   = [1,2,3,4,5,6,7,8,9,10,11,12];
const REFRESH_SEC = 120; // auto-refresh interval in seconds

const DISTRICT_NAMES = {
  1:'Eureka', 2:'Redding', 3:'Marysville', 4:'Bay Area',
  5:'San Luis Obispo', 6:'Fresno', 7:'Los Angeles',
  8:'San Bernardino', 9:'Bishop', 10:'Stockton',
  11:'San Diego', 12:'Orange County'
};

// Build image URL from camera ID and district
function imageUrl(camId, district) {
  return `${BASE_URL}/data/d${district}/cctv/image/${camId}/${camId}.jpg`;
}

// ── Fetch helper (iOS Safari-safe timeout) ──
function fetchWithTimeout(url, ms, opts) {
  ms = ms || 12000;
  opts = opts || {};
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, ms);
  return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
    .then(function(r) { clearTimeout(timer); return r; },
          function(e) { clearTimeout(timer); throw e; });
}

// ── ArcGIS FeatureServer (primary source) ──
const ARCGIS_URL = 'https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CCTV/FeatureServer/0/query';

async function fetchFromArcGIS() {
  const cameras = [];
  let offset = 0;
  const pageSize = 2000;
  let loggedFields = false;

  while (true) {
    const params = new URLSearchParams({
      where: '1=1', outFields: '*', returnGeometry: 'true',
      outSR: '4326', f: 'json',
      resultRecordCount: String(pageSize), resultOffset: String(offset),
    });
    const resp = await fetchWithTimeout(`${ARCGIS_URL}?${params}`, 15000, { mode: 'cors' });
    if (!resp.ok) throw new Error('ArcGIS HTTP ' + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || 'ArcGIS error');

    const features = data.features || [];
    // Log real field names once so we can see what the service actually returns
    if (!loggedFields && features.length) {
      console.log('[ArcGIS] field names:', Object.keys(features[0].attributes || {}));
      loggedFields = true;
    }

    features.forEach(f => {
      try {
        const c = normalizeArcGIS(f);
        if (c.lat && c.lng) cameras.push(c);
      } catch(e) {}
    });

    if (features.length < pageSize || !data.exceededTransferLimit) break;
    offset += pageSize;
  }
  return cameras;
}

function normalizeArcGIS(feature) {
  const a = feature.attributes || {};
  const g = feature.geometry   || {};

  const lat = parseFloat(g.y || a.Latitude  || a.latitude  || 0);
  const lng = parseFloat(g.x || a.Longitude || a.longitude || 0);

  const district = parseInt(a.District || a.DistrictNumber || a.DISTRICT || 0) || 0;

  // Prefer slug-style ID fields; fall back to OBJECTID only if nothing else found.
  // A slug ID contains letters (e.g. "tvd47i5santaclarita"); a pure numeric ID can't
  // be used to construct the Caltrans image URL so we leave imageUrl blank in that case.
  const rawId = a.CameraID || a.cctvID || a.ID || a.Camera_ID || a.CCTV_ID || '';
  const id    = String(rawId || a.OBJECTID || '');
  const isSlug = /[a-zA-Z]/.test(id); // slug IDs always contain letters

  const name = a.CameraName || a.Camera_Name || a.LocationDescription
            || a.Location   || a.Description || ('Camera ' + id);

  // Use embedded image URL if the service provides one, else construct from slug ID
  const directImg = a.ImageURL || a.image_url || a.Image_URL || a.imageURL || '';
  const img = directImg || (isSlug && district ? imageUrl(id, district) : '');

  const cond   = String(a.CctvCondition || a.Condition || a.Status || '').toLowerCase();
  const status = cond.includes('active')   ? 'active'
               : cond.includes('inactive') ? 'inactive'
               : cond.includes('offline')  ? 'inactive' : 'unknown';

  return {
    id, name, lat, lng, district,
    roadway:     String(a.Route       || a.Roadway  || a.Highway || ''),
    direction:   String(a.Direction   || a.Dir      || ''),
    description: String(a.LocationDescription || a.Location || a.Description || name),
    county:      String(a.County      || ''),
    elevation:   a.Elevation != null ? a.Elevation : null,
    imageUrl: img, streamUrl: null, status,
    distName: DISTRICT_NAMES[district] || ('District ' + district),
    dist: null,
  };
}

// ── CWWP2 district JSON (fallback) ──────────
// corsproxy.io confirmed working on iOS Safari — try it first.
// Direct ('') hangs without a CORS error so it's last to avoid a 12s wait.
const PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
  '',
];

function cwwp2Url(d, proxy) {
  proxy = proxy || '';
  const pad = String(d).padStart(2, '0');
  const url = BASE_URL + '/data/d' + d + '/cctv/cctvStatusD' + pad + '.json';
  return proxy ? proxy + encodeURIComponent(url) : url;
}

async function detectWorkingProxy() {
  // Re-use the proxy that worked last time this session — no re-test needed
  const cached = sessionStorage.getItem('tfc_proxy');
  if (cached !== null) return cached === '__direct__' ? '' : cached;

  // Race all proxies simultaneously — first to succeed wins (~1-2s vs up to 36s sequential)
  try {
    const winner = await Promise.any(
      PROXIES.map(async proxy => {
        const opts = proxy ? { mode: 'cors' } : { mode: 'cors', cache: 'no-store' };
        const resp = await fetchWithTimeout(cwwp2Url(7, proxy), 5000, opts);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return proxy;
      })
    );
    console.log('[CWWP2] working proxy:', winner || 'direct');
    sessionStorage.setItem('tfc_proxy', winner || '__direct__');
    return winner;
  } catch(e) {
    console.log('[CWWP2] all proxies failed');
    return null;
  }
}

async function fetchFromCWWP2(proxy) {
  const results = await Promise.allSettled(DISTRICTS.map(d => fetchDistrict(d, proxy)));
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
}

async function fetchDistrict(d, proxy) {
  try {
    const resp = await fetchWithTimeout(cwwp2Url(d, proxy), 12000, { mode: 'cors' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();

    // Confirmed CWWP2 format: { "data": [ { "cctv": {...} }, ... ] }
    // Also handle legacy keyed format: { "data": { "d7": { "cctv": [...] } } }
    let rawList;
    if (Array.isArray(json.data)) {
      rawList = json.data;
    } else {
      const root = (json.data && json.data['d' + d]) || json.data || json;
      rawList = root.cctv || root.cameras || root.items || [];
    }
    if (!Array.isArray(rawList)) return [];

    return rawList
      .map(raw => { try { return normalizeCamera(raw, d); } catch(e) { return null; } })
      .filter(c => c && c.lat && c.lng);
  } catch(e) {
    return [];
  }
}

// ── State ──────────────────────────────────
let allCameras    = [];
let filtered      = [];
let selectedCam   = null;
let userLatLng    = null;
let activeDistrict= 'all';
let searchQuery   = '';
let autoRefreshTimer  = null;
let imageRefreshTimer = null;
let sidebarOpen   = false;
let markers       = new Map();
let markerCluster = null;
let hlsInstance   = null;     // active HLS.js instance
let activeFeed    = 'still';  // 'still' | 'live'
let currentProxy  = null;     // cached working proxy for reuse

// ── Map init ───────────────────────────────
const map = L.map('map', {
  center: [37.5, -119.5],
  zoom: 6,
  zoomControl: true,
  attributionControl: true,
});

window._leafletMap = map; // exposed for post-gate invalidateSize call

// Dark CartoDB tiles
const darkTiles = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> | Data: <a href="https://cwwp2.dot.ca.gov">Caltrans</a>',
    subdomains: 'abcd',
    maxZoom: 19,
    r: window.devicePixelRatio > 1 ? '@2x' : ''
  }
);
const satTiles = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, USGS, NOAA | Data: <a href="https://cwwp2.dot.ca.gov">Caltrans</a>',
    maxZoom: 19,
  }
);
const labelTiles = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
  {
    subdomains: 'abcd',
    maxZoom: 19,
    opacity: 0.9,
    r: window.devicePixelRatio > 1 ? '@2x' : '',
    pane: 'shadowPane',
  }
);
let satelliteEnabled = false;
let labelsEnabled    = localStorage.getItem('tfc_st_labels') === '1';
darkTiles.addTo(map);

function toggleSatellite() {
  satelliteEnabled = !satelliteEnabled;
  const btn = document.getElementById('satelliteBtn');
  btn.classList.toggle('active', satelliteEnabled);
  if (satelliteEnabled) {
    map.removeLayer(darkTiles);
    satTiles.addTo(map);
    if (labelsEnabled) labelTiles.addTo(map);
  } else {
    if (map.hasLayer(labelTiles)) map.removeLayer(labelTiles);
    map.removeLayer(satTiles);
    darkTiles.addTo(map);
  }
}

function setLabelsEnabled(enabled) {
  labelsEnabled = enabled;
  localStorage.setItem('tfc_st_labels', enabled ? '1' : '0');
  if (satelliteEnabled) {
    if (enabled) { if (!map.hasLayer(labelTiles)) labelTiles.addTo(map); }
    else         { if (map.hasLayer(labelTiles))  map.removeLayer(labelTiles); }
  }
}

// Marker cluster group
markerCluster = L.markerClusterGroup({
  maxClusterRadius: 50,
  showCoverageOnHover: false,
  iconCreateFunction(cluster) {
    const c = cluster.getChildCount();
    const size = c < 10 ? 32 : c < 100 ? 38 : 44;
    return L.divIcon({
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:rgba(59,130,246,.7);border:2px solid rgba(96,165,250,.8);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${c<100?12:10}px;box-shadow:0 0 12px rgba(59,130,246,.4)">${c}</div>`,
      className: '',
      iconSize: [size, size],
      iconAnchor: [size/2, size/2],
    });
  }
});
// markerCluster added/removed dynamically in renderMarkers()

// Actual CWWP2 JSON structure (confirmed from live data):
// { cctv: { index, recordTimestamp, location: { district, locationName,
//   nearbyPlace, latitude, longitude, elevation, direction, county, route, ... },
//   inService, imageData: { streamingVideoURL, static: { currentImageURL, ... } } } }
function normalizeCamera(raw, district) {
  var c = (raw.cctv && raw.cctv.cctv) ? raw.cctv.cctv : (raw.cctv || raw);
  var loc      = c.location  || {};
  var imgBlock = c.imageData || {};
  var imgData  = imgBlock['static'] || {};

  // Extract camera ID from embedded image URL (no explicit cctvID field)
  var imgUrl  = imgData.currentImageURL || imgData.imageURL || '';
  var idMatch = imgUrl.match(/\/image\/([^/]+)\//);
  var id      = c.cctvID || c.id || (idMatch ? idMatch[1] : '') || String(c.index || '');

  var name = c.cctvName || loc.locationName || loc.nearbyPlace || ('Camera ' + id);
  var lat  = parseFloat(loc.latitude  || loc.lat || c.latitude  || 0);
  var lng  = parseFloat(loc.longitude || loc.lng || loc.lon || c.longitude || 0);
  // Some districts store longitude as a positive value (degrees west); force western hemisphere
  if (lng > 0) lng = -lng;

  var img       = imgUrl || (id ? imageUrl(id, district) : '');
  var streamUrl = imgBlock.streamingVideoURL || null;

  // inService:"true"/"false" is the status field
  var svc    = String(c.inService || c.cctvCondition || '').toLowerCase();
  var status = (svc === 'true'  || svc.includes('active'))   ? 'active'
             : (svc === 'false' || svc.includes('inactive')) ? 'inactive'
             : 'unknown';

  // Camera capability type based on available feeds
  var hasStill  = !!img;
  var hasStream = !!streamUrl;
  var type = (hasStill && hasStream) ? 'both'
           : hasStream               ? 'video'
           : hasStill                ? 'still'
           : 'unknown';

  var distNum = parseInt(loc.district || district || 0) || district;

  return {
    id, name, lat, lng,
    district:    distNum,
    roadway:     String(loc.route     || loc.roadway  || loc.highway || ''),
    direction:   String(loc.direction || loc.dir      || ''),
    description: String(loc.locationName || loc.nearbyPlace || name),
    county:      String(loc.county    || ''),
    elevation:   loc.elevation != null ? parseFloat(loc.elevation) : null,
    imageUrl:    img,
    streamUrl,
    status,
    type,
    distName: DISTRICT_NAMES[distNum] || ('District ' + distNum),
    dist: null,
  };
}

// ── Load all cameras ────────────────────────
async function loadAllCameras() {
  showLoading(true, 'Loading cameras…');
  const startTime = Date.now();
  let cameras = [];

  // Try CWWP2 first (richer: stream URLs, district info, inService status)
  const proxy = await detectWorkingProxy();
  currentProxy = proxy;
  if (proxy !== null) {
    try {
      cameras = await fetchFromCWWP2(proxy);
      console.log('[CWWP2] loaded', cameras.length, 'cameras via "' + (proxy || 'direct') + '"');
    } catch(e) {
      console.warn('[CWWP2] failed:', e.message);
    }
  }

  // ArcGIS fallback — no CORS proxy required, Caltrans allows direct cross-origin
  if (!cameras.length) {
    showLoading(true, 'Trying backup source…');
    try {
      cameras = await fetchFromArcGIS();
      console.log('[ArcGIS] loaded', cameras.length, 'cameras');
    } catch(e) {
      console.warn('[ArcGIS] failed:', e.message);
    }
  }

  allCameras = cameras.filter(c =>
    isFinite(c.lat) && isFinite(c.lng) &&
    c.lat >= 32 && c.lat <= 42.5 &&
    c.lng >= -125 && c.lng <= -113
  );

  if (!allCameras.length) {
    showLoading(false);
    showToast('Could not load cameras — tap ↺ to retry', 'error', 6000);
    showListPlaceholder('No cameras loaded. Tap the refresh button to retry.');
    return;
  }

  allCameras.sort((a, b) => a.district - b.district || a.name.localeCompare(b.name));
  updateUserDistances();
  applyFilter();
  showLoading(false);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  showToast('Loaded ' + allCameras.length.toLocaleString() + ' cameras in ' + elapsed + 's', 'success', 3000);

  // Apply cached unavailable list instantly, then run full scan only if cache is stale/missing
  if (!applyUnavailableCache()) {
    checkUnavailableImages(); // first-ever load or cache expired → full background scan
  }
}

async function refreshStatuses() {
  const proxy = await detectWorkingProxy();
  if (proxy === null) return;
  currentProxy = proxy; // keep cached proxy fresh for the unavailable scan below
  let fresh;
  try { fresh = await fetchFromCWWP2(proxy); } catch(e) { return; }
  if (!fresh.length) return;

  const freshMap = new Map(fresh.map(c => [c.id, c]));
  let changed = 0;

  allCameras.forEach(cam => {
    const update = freshMap.get(cam.id);
    if (!update || update.status === cam.status) return;
    cam.status = update.status;
    changed++;

    // Dot color represents camera type (not status), so no dot update needed
  });

  if (changed > 0) renderList();
  checkUnavailableImages(); // re-scan all cameras and refresh cache
}

function markCameraUnavailable(cam) {
  if (cam.unavailable) return;
  cam.unavailable = true;
  const marker = markers.get(cam.id);
  const dot = marker && marker.getElement() && marker.getElement().querySelector('.cam-dot');
  if (dot) {
    dot.classList.remove('dot-still', 'dot-video', 'dot-both', 'dot-unknown');
    dot.classList.add('dot-unavailable');
  }
}

// ── Unavailable image detection ─────────────────────────────────────────────
// Caltrans "Temporarily Unavailable" placeholder JPEGs are < 8 KB.
// Real camera frames are 20–150 KB. Results are cached in localStorage for
// ~31 days so the full scan only runs once per month (or on first ever load).

const UNAVAIL_CACHE_KEY  = 'tfc_unavail_v1';
const UNAVAIL_CACHE_DAYS = 31;

function saveUnavailableCache() {
  try {
    localStorage.setItem(UNAVAIL_CACHE_KEY, JSON.stringify({
      ts:  Date.now(),
      ids: allCameras.filter(c => c.unavailable).map(c => c.id),
    }));
  } catch(e) {}
}

// Returns true if a fresh cache was applied (skip full scan), false if scan needed.
function applyUnavailableCache() {
  try {
    const raw = localStorage.getItem(UNAVAIL_CACHE_KEY);
    if (!raw) return false;
    const { ts, ids } = JSON.parse(raw);
    if ((Date.now() - ts) > UNAVAIL_CACHE_DAYS * 864e5) return false; // stale
    const idSet = new Set(ids);
    allCameras.forEach(cam => {
      cam.imageChecked = true;
      if (idSet.has(cam.id)) markCameraUnavailable(cam);
    });
    return true;
  } catch(e) { return false; }
}

async function checkUnavailableImages() {
  if (!currentProxy) return;
  const toCheck = allCameras.filter(c => c.imageUrl);

  for (let i = 0; i < toCheck.length; i += 8) {
    const batch = toCheck.slice(i, i + 8);
    await Promise.all(batch.map(async cam => {
      try {
        const res = await fetchWithTimeout(
          currentProxy + encodeURIComponent(cam.imageUrl + '?t=' + Date.now()),
          10000, { mode: 'cors' }
        );
        const size = (await res.blob()).size;
        cam.imageChecked = true;
        if (size < 8000) {
          markCameraUnavailable(cam);
        } else if (cam.unavailable) {
          // Camera came back online — restore type colour
          cam.unavailable = false;
          const marker = markers.get(cam.id);
          const dot = marker && marker.getElement() && marker.getElement().querySelector('.cam-dot');
          if (dot) {
            dot.classList.remove('dot-unavailable');
            dot.classList.add(
              cam.type === 'both'  ? 'dot-both'  :
              cam.type === 'video' ? 'dot-video' :
              cam.type === 'still' ? 'dot-still' : 'dot-unknown'
            );
          }
        }
      } catch(e) {}
    }));
    if (i + 8 < toCheck.length) await new Promise(r => setTimeout(r, 200));
  }

  saveUnavailableCache(); // persist results for next app open
}

// Re-check camera statuses and unavailable feeds on the 1st of each month at 3 AM
(function scheduleMonthlyRefresh() {
  var now  = new Date();
  var next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 3, 0, 0, 0);
  var ms   = next - now;
  setTimeout(function() {
    refreshStatuses();
    setInterval(refreshStatuses, 30 * 24 * 60 * 60 * 1000); // fallback monthly interval
  }, ms);
}());

// ── Filter & Render ─────────────────────────
function applyFilter() {
  const q = searchQuery.toLowerCase().trim();

  filtered = allCameras.filter(cam => {
    const distMatch = activeDistrict === 'all' || cam.district === Number(activeDistrict);
    if (!distMatch) return false;
    if (!q) return true;
    return (
      cam.name.toLowerCase().includes(q) ||
      cam.roadway.toLowerCase().includes(q) ||
      cam.description.toLowerCase().includes(q) ||
      cam.county.toLowerCase().includes(q)
    );
  });

  // Sort by distance if user location known, else by district/name
  if (userLatLng) {
    filtered.sort((a,b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
  }

  renderMarkers();
  renderList();
  updateCamCount();
}

// ── Markers ────────────────────────────────

function renderMarkers() {
  markerCluster.clearLayers();
  markers.clear();

  filtered.forEach(cam => {
    // Red overrides type color when image feed is confirmed unavailable
    const colorClass = cam.unavailable     ? 'dot-unavailable'
                     : cam.type === 'both'  ? 'dot-both'
                     : cam.type === 'video' ? 'dot-video'
                     : cam.type === 'still' ? 'dot-still'
                     : 'dot-unknown';

    const icon = L.divIcon({
      html: `<div class="cam-dot ${colorClass}" data-id="${cam.id}"></div>`,
      className: 'cam-marker-icon',
      iconSize: [10, 10],
      iconAnchor: [5, 5],
    });

    const marker = L.marker([cam.lat, cam.lng], { icon });
    marker.camData = cam;
    marker.on('click', () => {
      if (!isMobile()) openCamera(cam, marker);
      // Mobile: bindPopup's built-in toggle opens/closes popup naturally
    });

    const popup = L.popup({ maxWidth: 220, className: 'cam-popup', closeButton: false, offset: [0, -6], autoPan: false })
      .setContent(() => buildPopupHtml(cam));
    marker.bindPopup(popup);
    marker.on('mouseover', () => { if (!isMobile()) marker.openPopup(); });
    marker.on('mouseout',  () => { if (!isMobile()) marker.closePopup(); });

    markers.set(cam.id, marker);
    markerCluster.addLayer(marker);
  });

  map.addLayer(markerCluster);
}

function buildPopupHtml(cam) {
  const imgSrc = cam.imageUrl ? `${cam.imageUrl}?t=${Date.now()}` : '';
  return `
    <div class="map-popup">
      ${imgSrc ? `<img class="map-popup-img" src="${imgSrc}" alt="${escHtml(cam.name)}" loading="lazy" onerror="this.style.display='none'">` : ''}
      <div class="map-popup-body">
        <div class="map-popup-name">${escHtml(cam.name)}</div>
        <div class="map-popup-road">${escHtml(cam.roadway)} ${cam.direction ? '· ' + cam.direction : ''} &nbsp;D${cam.district}</div>
        <button class="map-popup-btn" onclick="openCameraById('${cam.id}')">
          View Camera
        </button>
      </div>
    </div>`;
}

// ── Sidebar List ────────────────────────────
function renderList() {
  const list = document.getElementById('sidebarList');
  if (!filtered.length) {
    list.innerHTML = `<div class="no-results">No cameras match your search</div>`;
    return;
  }

  const frag = document.createDocumentFragment();

  filtered.forEach(cam => {
    const item = document.createElement('div');
    item.className = 'cam-list-item' + (selectedCam?.id === cam.id ? ' active' : '');
    item.dataset.id = cam.id;

    const distStr = cam.dist != null ? formatDist(cam.dist) : '';
    const imgSrc  = cam.imageUrl ? `${cam.imageUrl}?t=${Date.now()}` : '';

    item.innerHTML = `
      <div class="cam-thumb">
        ${imgSrc ? `<img src="${imgSrc}" alt="" loading="lazy" onerror="this.parentElement.style.background='#1e293b'">` : ''}
      </div>
      <div class="cam-list-info">
        <div class="cam-list-name">${escHtml(cam.name)}</div>
        <div class="cam-list-road">${escHtml(cam.roadway)} ${cam.direction ? '· ' + cam.direction : ''} · D${cam.district}</div>
      </div>
      ${distStr ? `<div class="cam-list-dist">${distStr}</div>` : ''}
      <div class="cam-list-status ${cam.status}"></div>`;

    item.addEventListener('click', () => {
      openCamera(cam);
      if (isMobile()) closeSidebarMobile();
    });
    frag.appendChild(item);
  });

  list.innerHTML = '';
  list.appendChild(frag);
}

function updateCamCount() {
  const el = document.getElementById('camCount');
  el.textContent = filtered.length.toLocaleString();
}

// ── Camera Panel ────────────────────────────
function openCamera(cam, marker) {
  selectedCam = cam;

  // Update panel content
  document.getElementById('camPanelTitle').textContent = cam.name;
  document.getElementById('camPanelSub').textContent   =
    [cam.description !== cam.name ? cam.description : '', cam.county].filter(Boolean).join(' · ');

  // Status badge
  const badgeColor = cam.status === 'active' ? 'green' : cam.status === 'inactive' ? 'red' : 'yellow';
  const badgeLabel = cam.status === 'active' ? '● Live' : cam.status === 'inactive' ? '● Offline' : '● Unknown';
  let badges = `<span class="badge ${badgeColor}">${badgeLabel}</span>`;
  if (cam.streamUrl) badges += `<span class="badge blue">▶ Stream</span>`;
  document.getElementById('camPanelBadges').innerHTML = badges;

  // Reset to still view and stop any running stream
  stopLiveStream();
  activeFeed = 'still';
  document.getElementById('stillView').classList.remove('hidden');
  document.getElementById('liveView').classList.add('hidden');
  document.getElementById('tabStill').classList.add('active');
  document.getElementById('tabLive').classList.remove('active');

  // Show/hide Live tab based on stream availability
  document.getElementById('tabLive').classList.toggle('hidden', !cam.streamUrl);

  // Load still image
  loadCameraImage(cam);

  // Detail rows
  const details = [
    ['Roadway',   cam.roadway || '—'],
    ['Direction', cam.direction || '—'],
    ['District',  `D${cam.district} · ${cam.distName}`],
    ['County',    cam.county || '—'],
    ['Elevation', cam.elevation != null ? `${cam.elevation} ft` : '—'],
    ['Location',  `${cam.lat.toFixed(5)}, ${cam.lng.toFixed(5)}`],
    ...(cam.dist != null ? [['Distance', formatDist(cam.dist) + ' away']] : []),
  ];
  document.getElementById('camDetails').innerHTML = details.map(([k,v]) =>
    `<div class="detail-row"><span class="detail-label">${k}</span><span class="detail-value">${escHtml(String(v))}</span></div>`
  ).join('');

  // Timestamp
  document.getElementById('camTimestamp').textContent = 'Just now';

  // Open panel
  document.getElementById('camPanel').classList.add('open');
  if (isMobile()) document.getElementById('backdrop').classList.remove('hidden');

  // Fly to camera on map
  map.setView([cam.lat, cam.lng], Math.max(map.getZoom(), 13), { animate: true, duration: .8 });

  // Highlight marker
  highlightMarker(cam.id);

  // Update list active state
  document.querySelectorAll('.cam-list-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === cam.id);
  });

  // Scroll list item into view
  const listItem = document.querySelector(`.cam-list-item[data-id="${cam.id}"]`);
  listItem?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function openCameraById(id) {
  const cam = allCameras.find(c => c.id === id);
  if (cam) openCamera(cam);
}
window.openCameraById = openCameraById; // expose for popup onclick

function closePanel() {
  document.getElementById('camPanel').classList.remove('open');
  document.getElementById('backdrop').classList.add('hidden');
  stopAutoRefresh();
  stopLiveStream();
  selectedCam = null;
  activeFeed = 'still';
  highlightMarker(null);
}

// ── Feed tab switching ──────────────────────
function switchFeed(tab) {
  activeFeed = tab;
  document.getElementById('tabStill').classList.toggle('active', tab === 'still');
  document.getElementById('tabLive').classList.toggle('active', tab === 'live');
  document.getElementById('stillView').classList.toggle('hidden', tab !== 'still');
  document.getElementById('liveView').classList.toggle('hidden', tab !== 'live');

  if (tab === 'live' && selectedCam) {
    startLiveStream(selectedCam);
  } else {
    stopLiveStream();
  }
}

// ── HLS Live stream ─────────────────────────
function startLiveStream(cam) {
  const video   = document.getElementById('camVideo');
  const loading = document.getElementById('camVideoLoading');
  const overlay = document.getElementById('camVideoOverlay');

  loading.classList.remove('hidden');
  overlay.classList.add('hidden');
  stopLiveStream();

  if (!cam.streamUrl) {
    loading.classList.add('hidden');
    overlay.classList.remove('hidden');
    return;
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari — native HLS
    video.src = cam.streamUrl;
    video.load();
    video.play().catch(() => {});
    video.addEventListener('canplay', function onCanPlay() {
      loading.classList.add('hidden');
      video.removeEventListener('canplay', onCanPlay);
    }, { once: true });
    video.addEventListener('error', function onErr() {
      loading.classList.add('hidden');
      overlay.classList.remove('hidden');
      video.removeEventListener('error', onErr);
    }, { once: true });
  } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    // Chrome/Firefox — hls.js
    hlsInstance = new Hls({ enableWorker: false });
    hlsInstance.loadSource(cam.streamUrl);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
      loading.classList.add('hidden');
      video.play().catch(() => {});
    });
    hlsInstance.on(Hls.Events.ERROR, function(e, data) {
      if (data.fatal) {
        loading.classList.add('hidden');
        overlay.classList.remove('hidden');
      }
    });
  } else {
    loading.classList.add('hidden');
    overlay.classList.remove('hidden');
  }
}

function stopLiveStream() {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  const video = document.getElementById('camVideo');
  if (video) { video.pause(); video.src = ''; video.load(); }
}

function loadCameraImage(cam) {
  if (!cam.imageUrl) {
    showImageError();
    return;
  }

  const img     = document.getElementById('camImage');
  const loading = document.getElementById('camImageLoading');
  const overlay = document.getElementById('camImageOverlay');

  loading.classList.remove('hidden');
  overlay.classList.add('hidden');
  img.style.opacity = '0';

  const src = cam.imageUrl + '?t=' + Date.now();
  const tmp = new Image();
  let done = false;

  // 12-second hard timeout — never leave the spinner spinning
  const timer = setTimeout(function() {
    if (done) return;
    done = true;
    tmp.src = '';
    loading.classList.add('hidden');
    showImageError();
  }, 12000);

  tmp.onload = function() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    img.src = src;
    img.style.opacity = '1';
    loading.classList.add('hidden');
    document.getElementById('camTimestamp').textContent = new Date().toLocaleTimeString();
    // Lazy check: if we haven't verified this camera's image size yet, do it now
    if (!cam.imageChecked && currentProxy) {
      fetchWithTimeout(currentProxy + encodeURIComponent(src), 10000, { mode: 'cors' })
        .then(function(res) { return res.blob(); })
        .then(function(blob) {
          cam.imageChecked = true;
          if (blob.size < 8000) markCameraUnavailable(cam);
        })
        .catch(function() {});
    }
  };
  tmp.onerror = function() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    loading.classList.add('hidden');
    showImageError();
  };
  tmp.src = src;
}

function showImageError() {
  document.getElementById('camImage').src = '';
  document.getElementById('camImageOverlay').classList.remove('hidden');
}

function highlightMarker(id) {
  markers.forEach((m, mId) => {
    const dot = m.getElement()?.querySelector('.cam-dot');
    if (dot) dot.classList.toggle('active-selected', mId === id);
  });
}

// ── Auto Refresh ────────────────────────────
function startAutoRefresh() {
  stopAutoRefresh();
  const btn = document.getElementById('autoRefreshBtn');
  btn.classList.add('active-refresh');
  btn.dataset.active = 'true';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg> Stop Auto`;

  imageRefreshTimer = setInterval(() => {
    if (selectedCam) loadCameraImage(selectedCam);
  }, REFRESH_SEC * 1000);
}

function stopAutoRefresh() {
  if (imageRefreshTimer) { clearInterval(imageRefreshTimer); imageRefreshTimer = null; }
  const btn = document.getElementById('autoRefreshBtn');
  if (btn) {
    btn.classList.remove('active-refresh');
    btn.dataset.active = 'false';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
      </svg> Auto Refresh`;
  }
}

// ── User Location ───────────────────────────
let userMarker  = null;
let userWatchId = null;

function locateUser() {
  const btn = document.getElementById('locateBtn');

  // Second click — stop tracking
  if (userWatchId !== null) {
    navigator.geolocation.clearWatch(userWatchId);
    userWatchId = null;
    btn.classList.remove('active', 'spinning');
    if (userMarker) { userMarker.remove(); userMarker = null; }
    userLatLng = null;
    updateUserDistances();
    applyFilter();
    showToast('Location tracking stopped', '', 2000);
    return;
  }

  if (!navigator.geolocation) {
    showToast('Geolocation not supported by your browser', 'error');
    return;
  }

  btn.classList.add('spinning');
  let firstFix = true;

  userWatchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      userLatLng = { lat, lng };

      placeUserMarker(lat, lng);
      updateUserDistances();

      if (firstFix) {
        firstFix = false;
        btn.classList.remove('spinning');
        btn.classList.add('active');
        map.setView([lat, lng], 12, { animate: true, duration: 1 });
        showToast('Location tracking active — cameras sorted by distance', 'success', 3000);
        applyFilter(); // full render + resort on first fix
      } else {
        renderList(); // silent resort on subsequent updates — don't re-render map
      }
    },
    err => {
      btn.classList.remove('spinning');
      userWatchId = null;
      const msg = err.code === 1 ? 'Location permission denied'
                : err.code === 2 ? 'Position unavailable'
                : 'Location request timed out';
      showToast(msg, 'error', 4000);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );
}

function placeUserMarker(lat, lng) {
  if (userMarker) userMarker.remove();
  const icon = L.divIcon({
    html: '<div class="user-dot"></div>',
    className: '',
    iconSize: [14,14],
    iconAnchor: [7,7],
  });
  userMarker = L.marker([lat, lng], { icon, zIndexOffset: 2000 })
    .addTo(map)
    .bindTooltip('Your Location', { permanent: false, direction: 'top', offset: [0,-8] });
}

function updateUserDistances() {
  if (!userLatLng) return;
  allCameras.forEach(cam => {
    cam.dist = haversine(userLatLng.lat, userLatLng.lng, cam.lat, cam.lng);
  });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function toRad(d) { return d * Math.PI / 180; }
function formatDist(miles) {
  if (miles < 0.1) return `${Math.round(miles * 5280)} ft`;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}

// ── Near Me ─────────────────────────────────
function handleNearMe() {
  if (!userLatLng) {
    locateUser();
    return;
  }
  // Already have location — fly to user and highlight nearest
  map.setView([userLatLng.lat, userLatLng.lng], 13, { animate: true, duration: 1 });
  applyFilter();
}

// ── Loading / Toast ─────────────────────────
function showLoading(visible, text = '') {
  const el = document.getElementById('mapLoading');
  el.classList.toggle('hidden', !visible);
  if (text) document.getElementById('loadingText').textContent = text;
}

let toastTimer = null;
function showToast(msg, type = '', duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${type ? ' ' + type : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

function showListPlaceholder(msg) {
  document.getElementById('sidebarList').innerHTML =
    `<div class="list-placeholder"><p>${escHtml(msg)}</p></div>`;
}

// ── Sidebar (mobile) ────────────────────────
function toggleSidebarMobile() {
  const sidebar = document.getElementById('sidebar');
  sidebarOpen = !sidebarOpen;
  sidebar.classList.toggle('mobile-open', sidebarOpen);
  // Close panel if open
  if (sidebarOpen && document.getElementById('camPanel').classList.contains('open')) {
    closePanel();
  }
}

function closeSidebarMobile() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.remove('mobile-open');
  sidebarOpen = false;
}

// ── Helpers ─────────────────────────────────
function isMobile() { return window.innerWidth <= 768; }
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Event Wiring ────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Menu toggle
  document.getElementById('menuBtn').addEventListener('click', () => {
    if (isMobile()) {
      toggleSidebarMobile();
    } else {
      document.getElementById('sidebar').classList.toggle('collapsed');
    }
  });

  // Search
  const searchInput = document.getElementById('searchInput');
  const clearBtn    = document.getElementById('clearSearch');

  searchInput.addEventListener('input', e => {
    searchQuery = e.target.value;
    clearBtn.classList.toggle('hidden', !searchQuery);
    applyFilter();
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    clearBtn.classList.add('hidden');
    applyFilter();
    searchInput.focus();
  });

  // District chips
  document.querySelectorAll('.district-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.district-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeDistrict = btn.dataset.district;
      applyFilter();
    });
  });

  // Satellite toggle
  document.getElementById('satelliteBtn').addEventListener('click', toggleSatellite);

  // Locate / refresh
  document.getElementById('locateBtn').addEventListener('click', locateUser);
  document.getElementById('refreshBtn').addEventListener('click', () => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    sessionStorage.removeItem('tfc_proxy'); // force re-detect in case proxy went down
    loadAllCameras().finally(() => btn.classList.remove('spinning'));
  });

  // Near Me
  document.getElementById('nearMeBtn').addEventListener('click', handleNearMe);

  // Feed tabs
  document.getElementById('tabStill').addEventListener('click', () => switchFeed('still'));
  document.getElementById('tabLive').addEventListener('click',  () => switchFeed('live'));

  // Panel close
  document.getElementById('closePanelBtn').addEventListener('click', closePanel);
  document.getElementById('backdrop').addEventListener('click', closePanel);
  map.on('click', () => { if (sidebarOpen) closeSidebarMobile(); });

  // Camera refresh
  document.getElementById('camRefreshBtn').addEventListener('click', () => {
    if (selectedCam) loadCameraImage(selectedCam);
  });

  // Auto-refresh toggle
  document.getElementById('autoRefreshBtn').addEventListener('click', () => {
    const btn = document.getElementById('autoRefreshBtn');
    if (btn.dataset.active === 'true') stopAutoRefresh();
    else startAutoRefresh();
  });

  // Center on map
  document.getElementById('camMapBtn').addEventListener('click', () => {
    if (selectedCam) map.setView([selectedCam.lat, selectedCam.lng], 15, { animate: true });
  });

  // Map click — close panel on blank map click (mobile)
  map.on('click', () => {
    if (isMobile() && document.getElementById('camPanel').classList.contains('open')) {
      closePanel();
    }
  });

  // Keyboard shortcut: Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('camPanel').classList.contains('open')) closePanel();
      if (sidebarOpen) closeSidebarMobile();
    }
  });

  // Start
  loadAllCameras();
});
