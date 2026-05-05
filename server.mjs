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
