/* ═══════════════════════════════════════════
   Nevada (NVRoads / NDOT) camera source

   Fetched client-side through the same CORS proxies the app uses for
   Caltrans. NVRoads exposes the same keyless DataTables list endpoint its
   own /cctv map uses:  /List/GetData/Cameras?query={…}&lang=en-US
   → { data:[ {id, location, roadway, region, latLng:{geography:{wellKnownText}},
              images:[ {imageUrl, videoUrl, disabled, blocked, videoDisabled} ] } ],
       recordsTotal, recordsFiltered }

   Depends on globals from app.js: fetchWithTimeout
════════════════════════════════════════════ */

'use strict';

const NV_BASE     = 'https://www.nvroads.com';
const NV_LIST_URL = NV_BASE + '/List/GetData/Cameras';

// Real CORS proxies only — a direct request fails (NVRoads sends no CORS headers).
const NV_PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
];

// DataTables server-side query the NVRoads /cctv page itself issues.
function nvBuildQuery(start, length) {
  return {
    columns: [
      { data: null, name: '' },
      { name: 'sortOrder', s: true },
      { name: 'region',    s: true },
      { name: 'roadway',   s: true },
      { data: 4, name: '' },
    ],
    order: [
      { column: 1, dir: 'asc' },
      { column: 2, dir: 'asc' },
      { column: 3, dir: 'asc' },
    ],
    start, length,
    search: { value: '' },
  };
}

function nvTargetUrl(start, length) {
  const q = encodeURIComponent(JSON.stringify(nvBuildQuery(start, length)));
  return NV_LIST_URL + '?query=' + q + '&lang=en-US';
}

// Fetch one page of raw rows via whichever proxy answers first.
async function nvFetchPage(start, length) {
  const target = nvTargetUrl(start, length);
  return await Promise.any(NV_PROXIES.map(async proxy => {
    const resp = await fetchWithTimeout(proxy + encodeURIComponent(target), 15000, { mode: 'cors' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    if (!json || !Array.isArray(json.data)) throw new Error('bad payload');
    return json;
  }));
}

// One raw NVRoads row → the app's normalized camera shape (state:'NV').
function nvParseRow(cam) {
  const img = cam.images && cam.images[0];
  if (!img || img.disabled || img.blocked) return null;

  // Coordinates arrive as WKT "POINT (lng lat)" (longitude first).
  let lat = 0, lng = 0;
  const wkt = cam.latLng && cam.latLng.geography && cam.latLng.geography.wellKnownText;
  const m = wkt && wkt.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/);
  if (m) { lng = parseFloat(m[1]); lat = parseFloat(m[2]); }
  else if (cam.longitude != null && cam.latitude != null) {
    lng = parseFloat(cam.longitude); lat = parseFloat(cam.latitude);
  }
  if (!isFinite(lat) || !isFinite(lng) || (!lat && !lng)) return null;

  const rel      = img.imageUrl || '';
  const imageUrl = rel ? (/^https?:/i.test(rel) ? rel : NV_BASE + rel) : '';
  const hasVideo = !!(img.videoUrl && !img.videoDisabled);
  const streamUrl = hasVideo ? img.videoUrl : null;

  const type = (imageUrl && streamUrl) ? 'both'
             : streamUrl               ? 'video'
             : imageUrl                ? 'still' : 'unknown';

  const region = cam.region || '';
  const name   = cam.location || img.description || cam.roadway || ('NV Camera ' + cam.id);

  return {
    id:          'nv-' + cam.id,
    name,
    lat, lng,
    district:    0,          // no CA district
    state:       'NV',
    region,
    roadway:     String(cam.roadway   || ''),
    direction:   String(cam.direction || ''),
    description: String(cam.location  || name),
    county:      region,
    elevation:   null,
    imageUrl,
    streamUrl,
    status:      'unknown',
    type,
    distName:    region || 'Nevada',
    dist:        null,
  };
}

// Public: fetch + normalize every Nevada camera (pages until complete).
async function nvFetchCameras() {
  const first  = await nvFetchPage(0, 2000);
  let   rows   = first.data || [];
  const total  = first.recordsTotal || rows.length;

  let guard = 0;
  while (rows.length < total && guard++ < 20) {
    const page = await nvFetchPage(rows.length, 2000);
    const d = page.data || [];
    if (!d.length) break;
    rows = rows.concat(d);
  }

  const cams = [];
  for (const row of rows) {
    try { const c = nvParseRow(row); if (c) cams.push(c); } catch (_) {}
  }
  return cams;
}
