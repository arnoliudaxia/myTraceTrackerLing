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
