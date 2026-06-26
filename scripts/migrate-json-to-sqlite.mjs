import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initDatabase,
  replaceTracks,
  setPathLabels,
  setPathFavorites,
  DB_FILE,
} from '../lib/db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const JSON_FILES = {
  tracks: path.join(rootDir, 'all_dates_points.json'),
  labels: path.join(rootDir, 'path_labels.json'),
  favorites: path.join(rootDir, 'path_favorites.json'),
};

function readJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) return defaultValue;
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return defaultValue;
  return JSON.parse(text);
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.backup`;
  let target = backupPath;
  let counter = 1;
  while (fs.existsSync(target)) {
    target = `${backupPath}.${counter}`;
    counter++;
  }
  fs.renameSync(filePath, target);
  return target;
}

function main() {
  console.log('开始将 JSON 数据迁移到 SQLite...');
  console.log(`数据库文件: ${DB_FILE}`);

  initDatabase();

  const allData = readJsonFile(JSON_FILES.tracks, {});
  const labels = readJsonFile(JSON_FILES.labels, {});
  const favorites = readJsonFile(JSON_FILES.favorites, {});

  const trackCount = Object.keys(allData).length;
  const pointCount = Object.values(allData).reduce((sum, day) => sum + (day.count || 0), 0);
  const labelCount = Object.keys(labels).length;
  const favoriteCount = Object.keys(favorites).length;

  console.log(`读取到 ${trackCount} 个日期，共 ${pointCount} 个轨迹点`);
  console.log(`读取到 ${labelCount} 个标签，${favoriteCount} 个收藏`);

  replaceTracks(allData);
  setPathLabels(labels);
  setPathFavorites(favorites);

  console.log('迁移完成！');

  const backupPaths = [];
  for (const key of Object.keys(JSON_FILES)) {
    const backup = backupFile(JSON_FILES[key]);
    if (backup) backupPaths.push(backup);
  }

  if (backupPaths.length > 0) {
    console.log('原 JSON 文件已备份为：');
    for (const backup of backupPaths) console.log(`  - ${path.basename(backup)}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`迁移失败: ${error.message}`);
  process.exitCode = 1;
}
