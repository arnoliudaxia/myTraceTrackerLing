import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const dataFiles = new Map([
  ['/all_dates_points.json', path.join(rootDir, 'all_dates_points.json')],
  ['/path_labels.json', path.join(rootDir, 'path_labels.json')],
  ['/path_favorites.json', path.join(rootDir, 'path_favorites.json')],
]);

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
]);

const tiandituServices = new Set(['vec_w', 'cva_w', 'img_w', 'cia_w', 'ter_w', 'cta_w', 'ibo_w']);
const geovisTileTypes = new Set(['img', 'cia']);
const geovisTileFormat = new Set(['webp']);
const geovisTmsIds = new Set(['w', 'c']);
const tracestrackStyles = new Set(['topo']);
const shanghaiAreaId = 3600913067;
const shanghaiAdminCacheTtlMs = 6 * 60 * 60 * 1000;
let shanghaiAdminCache = null;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.join(rootDir, '.env'));

function send(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(body);
}

function safePublicPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const candidate = path.normalize(path.join(publicDir, decodedPath));
  if (!candidate.startsWith(publicDir)) return null;
  return candidate;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function handlePathLabelsSave(req, res) {
  try {
    const body = await readBody(req);
    const labels = JSON.parse(body || '{}');
    if (!labels || Array.isArray(labels) || typeof labels !== 'object') {
      send(res, 400, JSON.stringify({ error: '标签数据必须是对象' }), 'application/json; charset=utf-8');
      return;
    }
    fs.writeFileSync(path.join(rootDir, 'path_labels.json'), `${JSON.stringify(labels, null, 2)}\n`, 'utf8');
    send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
  } catch (error) {
    send(res, 400, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8');
  }
}

async function handlePathFavoritesSave(req, res) {
  try {
    const body = await readBody(req);
    const favorites = JSON.parse(body || '{}');
    if (!favorites || Array.isArray(favorites) || typeof favorites !== 'object') {
      send(res, 400, JSON.stringify({ error: '收藏数据必须是对象' }), 'application/json; charset=utf-8');
      return;
    }
    fs.writeFileSync(path.join(rootDir, 'path_favorites.json'), `${JSON.stringify(favorites, null, 2)}\n`, 'utf8');
    send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
  } catch (error) {
    send(res, 400, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8');
  }
}

async function handleTiandituTile(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const subdomain = parts[2];
  const serviceName = parts[3];

  if (!/^t[0-7]$/.test(subdomain) || !tiandituServices.has(serviceName)) {
    send(res, 404, 'Not found');
    return;
  }

  const tk = process.env.TIANDITU_KEY;
  if (!tk) {
    send(res, 500, JSON.stringify({ error: '缺少环境变量 TIANDITU_KEY' }), 'application/json; charset=utf-8');
    return;
  }

  const upstream = new URL(`https://${subdomain}.tianditu.gov.cn/${serviceName}/wmts`);
  for (const [key, value] of url.searchParams) {
    upstream.searchParams.set(key, value);
  }
  upstream.searchParams.set('tk', tk);

  try {
    const response = await fetch(upstream, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: `http://localhost:${port}/`,
      },
    });
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(body);
  } catch (error) {
    send(res, 502, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8');
  }
}

async function handleGeovisImageTile(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const [apiPrefix, provider, tileType, z, x, y] = parts;

  if (apiPrefix !== 'api' || provider !== 'geovis' || !geovisTileTypes.has(tileType)) {
    send(res, 404, 'Not found');
    return;
  }
  if (![z, x, y].every((value) => /^\d+$/.test(value))) {
    send(res, 400, JSON.stringify({ error: 'Invalid tile coordinate' }), 'application/json; charset=utf-8');
    return;
  }

  const token = process.env.GEOVIS_TOKEN;
  if (!token) {
    send(res, 500, JSON.stringify({ error: '缺少环境变量 GEOVIS_TOKEN' }), 'application/json; charset=utf-8');
    return;
  }

  const format = url.searchParams.get('format') || 'webp';
  const tmsIds = url.searchParams.get('tmsIds') || 'w';
  if (!geovisTileFormat.has(format) || !geovisTmsIds.has(tmsIds)) {
    send(res, 400, JSON.stringify({ error: 'Invalid GEOVIS tile parameter' }), 'application/json; charset=utf-8');
    return;
  }

  const upstream = new URL(`https://tiles1.geovisearth.com/base/v3/${tileType}/${z}/${x}/${y}`);
  upstream.searchParams.set('format', format);
  upstream.searchParams.set('tmsIds', tmsIds);
  upstream.searchParams.set('token', token);

  try {
    const response = await fetch(upstream, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: `http://localhost:${port}/`,
      },
    });
    const contentType = response.headers.get('content-type') || 'image/webp';
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(body);
  } catch (error) {
    send(res, 502, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8');
  }
}

async function handleTracestrackTile(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const [apiPrefix, provider, styleName, z, x, yFile] = parts;

  if (apiPrefix !== 'api' || provider !== 'tracestrack' || !tracestrackStyles.has(styleName)) {
    send(res, 404, 'Not found');
    return;
  }
  const yMatch = /^(\d+)\.webp$/.exec(yFile || '');
  if (!/^\d+$/.test(z || '') || !/^\d+$/.test(x || '') || !yMatch) {
    send(res, 400, JSON.stringify({ error: 'Invalid Tracestrack tile coordinate' }), 'application/json; charset=utf-8');
    return;
  }

  const upstream = new URL(`https://tile.tracestrack.com/topo__/${z}/${x}/${yMatch[1]}.webp`);

  try {
    const response = await fetch(upstream, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://www.openstreetmap.org/',
      },
    });
    const contentType = response.headers.get('content-type') || 'image/webp';
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(body);
  } catch (error) {
    send(res, 502, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8');
  }
}

function normalizeOsmFeature(feature) {
  const properties = feature.properties || {};
  const extraTags = properties.extratags || {};
  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      display_name: properties.display_name || properties.name || '',
      name: properties.name || properties.display_name || '',
      class: properties.class || properties.category || '',
      type: properties.type || '',
      osm_type: properties.osm_type || '',
      osm_id: properties.osm_id || '',
      admin_level: properties.admin_level || extraTags.admin_level || '',
      importance: properties.importance || null,
    },
  };
}

async function handleOsmAdminBoundaries(req, res, url) {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) {
    send(res, 400, JSON.stringify({ error: 'Missing query parameter q' }), 'application/json; charset=utf-8');
    return;
  }

  const upstream = new URL('https://nominatim.openstreetmap.org/search');
  upstream.searchParams.set('q', query);
  upstream.searchParams.set('format', 'geojson');
  upstream.searchParams.set('polygon_geojson', '1');
  upstream.searchParams.set('polygon_threshold', '0.0005');
  upstream.searchParams.set('addressdetails', '1');
  upstream.searchParams.set('extratags', '1');
  upstream.searchParams.set('layer', 'address');
  upstream.searchParams.set('limit', '10');

  try {
    const response = await fetch(upstream, {
      headers: {
        'Accept': 'application/geo+json, application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        'User-Agent': 'LingganFootprintsMap/2.0 local development',
        Referer: `http://localhost:${port}/`,
      },
    });
    const payload = await response.json();
    if (!response.ok) {
      send(res, response.status, JSON.stringify({ error: payload.error || response.statusText }), 'application/json; charset=utf-8');
      return;
    }

    const features = (payload.features || [])
      .filter((feature) => feature && feature.geometry && feature.geometry.type !== 'Point')
      .map(normalizeOsmFeature);

    send(res, 200, JSON.stringify({
      type: 'FeatureCollection',
      source: 'OpenStreetMap Nominatim',
      features,
    }), 'application/json; charset=utf-8');
  } catch (error) {
    send(res, 502, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8');
  }
}

function osmTypePrefix(osmType) {
  const normalized = String(osmType || '').toLowerCase();
  if (normalized === 'relation') return 'R';
  if (normalized === 'way') return 'W';
  if (normalized === 'node') return 'N';
  return null;
}

async function lookupOsmBoundary(osmType, osmId) {
  const prefix = osmTypePrefix(osmType);
  if (!prefix || !/^\d+$/.test(String(osmId))) {
    throw new Error('Invalid OSM object');
  }

  const upstream = new URL('https://nominatim.openstreetmap.org/lookup');
  upstream.searchParams.set('osm_ids', `${prefix}${osmId}`);
  upstream.searchParams.set('format', 'geojson');
  upstream.searchParams.set('polygon_geojson', '1');
  upstream.searchParams.set('polygon_threshold', '0.0005');
  upstream.searchParams.set('extratags', '1');

  const response = await fetch(upstream, {
    headers: {
      'Accept': 'application/geo+json, application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
      'User-Agent': 'LingganFootprintsMap/2.0 local development',
      Referer: `http://localhost:${port}/`,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return (payload.features || [])
    .filter((feature) => feature && feature.geometry && feature.geometry.type !== 'Point')
    .map(normalizeOsmFeature);
}

async function handleOsmBoundaryLookup(req, res, url) {
  try {
    const features = await lookupOsmBoundary(url.searchParams.get('osmType'), url.searchParams.get('osmId'));
    send(res, 200, JSON.stringify({
      type: 'FeatureCollection',
      source: 'OpenStreetMap Nominatim',
      features,
    }), 'application/json; charset=utf-8');
  } catch (error) {
    send(res, 400, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8');
  }
}

function elementName(element) {
  const tags = element.tags || {};
  return tags.name || tags['name:zh'] || tags['name:en'] || `OSM ${element.id}`;
}

function elementCenter(element) {
  if (element.center) return { lat: element.center.lat, lon: element.center.lon };
  if (element.bounds) {
    return {
      lat: (element.bounds.minlat + element.bounds.maxlat) / 2,
      lon: (element.bounds.minlon + element.bounds.maxlon) / 2,
    };
  }
  return null;
}

function boundsArea(bounds) {
  if (!bounds) return Number.POSITIVE_INFINITY;
  return Math.abs((bounds.maxlat - bounds.minlat) * (bounds.maxlon - bounds.minlon));
}

function boundsContainPoint(bounds, center) {
  return bounds && center
    && center.lat >= bounds.minlat
    && center.lat <= bounds.maxlat
    && center.lon >= bounds.minlon
    && center.lon <= bounds.maxlon;
}

function adminElementSummary(element) {
  const tags = element.tags || {};
  return {
    name: elementName(element),
    osmType: element.type,
    osmId: String(element.id),
    adminLevel: tags.admin_level || '',
    type: tags.type || '',
    boundary: tags.boundary || '',
  };
}

function buildShanghaiAdminIndex(elements) {
  const adminElements = elements
    .filter((element) => element.type === 'relation' && element.tags && element.tags.boundary === 'administrative');
  const districts = adminElements
    .filter((element) => String(element.tags.admin_level) === '6')
    .sort((a, b) => elementName(a).localeCompare(elementName(b), 'zh-CN'))
    .map((element) => ({
      ...adminElementSummary(element),
      bounds: element.bounds || null,
      children: [],
    }));

  const children = adminElements
    .filter((element) => {
      const adminLevel = Number(element.tags.admin_level);
      return adminLevel > 6 && adminLevel <= 8;
    })
    .sort((a, b) => elementName(a).localeCompare(elementName(b), 'zh-CN'));

  for (const child of children) {
    const center = elementCenter(child);
    const parent = districts
      .filter((district) => boundsContainPoint(district.bounds, center))
      .sort((a, b) => boundsArea(a.bounds) - boundsArea(b.bounds))[0];
    if (parent) parent.children.push(adminElementSummary(child));
  }

  return districts.map(({ bounds, ...district }) => district);
}

async function fetchShanghaiAdminIndex() {
  if (shanghaiAdminCache && Date.now() - shanghaiAdminCache.createdAt < shanghaiAdminCacheTtlMs) {
    return shanghaiAdminCache.payload;
  }

  const query = `[out:json][timeout:45];area(${shanghaiAreaId})->.shanghai;(relation(area.shanghai)["boundary"="administrative"]["admin_level"~"^(6|7|8|9|10)$"];);out tags center bb;`;
  const response = await fetch('https://overpass.kumi.systems/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'LingganFootprintsMap/2.0 local development',
    },
    body: new URLSearchParams({ data: query }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text.slice(0, 200) || response.statusText);
  }
  const payload = JSON.parse(text);
  const districts = buildShanghaiAdminIndex(payload.elements || []);
  shanghaiAdminCache = {
    createdAt: Date.now(),
    payload: {
      source: 'OpenStreetMap Overpass',
      districts,
    },
  };
  return shanghaiAdminCache.payload;
}

async function handleShanghaiAdminIndex(req, res) {
  try {
    send(res, 200, JSON.stringify(await fetchShanghaiAdminIndex()), 'application/json; charset=utf-8');
  } catch (error) {
    send(res, 502, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8');
  }
}

function serveFile(filePath, res) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    send(res, 404, 'Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes.get(ext) || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/path-labels') {
    await handlePathLabelsSave(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/path-favorites') {
    await handlePathFavoritesSave(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/tianditu/')) {
    await handleTiandituTile(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/geovis/')) {
    await handleGeovisImageTile(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/tracestrack/')) {
    await handleTracestrackTile(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/osm/admin-boundaries') {
    await handleOsmAdminBoundaries(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/osm/boundary') {
    await handleOsmBoundaryLookup(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/osm/shanghai-admin-index') {
    await handleShanghaiAdminIndex(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }

  if (dataFiles.has(url.pathname)) {
    serveFile(dataFiles.get(url.pathname), res);
    return;
  }

  serveFile(safePublicPath(url.pathname), res);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`灵敢足迹 Node 服务已启动: http://localhost:${port}`);
});
