import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export const DB_FILE = path.join(rootDir, 'data.db');

const initSql = `
CREATE TABLE IF NOT EXISTS tracks (
  date TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  start_time TEXT,
  end_time TEXT,
  altitude_min REAL,
  altitude_max REAL,
  speed_min REAL,
  speed_max REAL
);

CREATE TABLE IF NOT EXISTS track_points (
  date TEXT NOT NULL,
  idx INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  elevation REAL,
  speed REAL,
  time TEXT,
  PRIMARY KEY (date, idx),
  FOREIGN KEY (date) REFERENCES tracks(date) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS path_labels (
  date TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (date, segment_index),
  FOREIGN KEY (date) REFERENCES tracks(date) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS path_favorites (
  date TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  note TEXT,
  created_at TEXT,
  PRIMARY KEY (date, segment_index),
  FOREIGN KEY (date) REFERENCES tracks(date) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_labels (
  label TEXT PRIMARY KEY,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_track_points_date ON track_points(date);
`;

let db = null;

export function openDatabase(filePath = DB_FILE) {
  if (db) return db;
  db = new DatabaseSync(filePath);
  db.exec(initSql);
  return db;
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

export function initDatabase(filePath = DB_FILE) {
  return openDatabase(filePath);
}

export function databaseExists(filePath = DB_FILE) {
  return fs.existsSync(filePath);
}

export function replaceTracks(allData) {
  const database = openDatabase();
  const insertTrack = database.prepare(
    'INSERT OR REPLACE INTO tracks (date, count, start_time, end_time, altitude_min, altitude_max, speed_min, speed_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertPoint = database.prepare(
    'INSERT OR REPLACE INTO track_points (date, idx, lat, lng, timestamp, elevation, speed, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const deletePoints = database.prepare('DELETE FROM track_points WHERE date = ?');

  database.exec('BEGIN');
  try {
    for (const date of Object.keys(allData)) {
      const day = allData[date];
      insertTrack.run(
        date,
        day.count,
        day.start_time ?? null,
        day.end_time ?? null,
        day.altitude_min ?? null,
        day.altitude_max ?? null,
        day.speed_min ?? null,
        day.speed_max ?? null
      );

      deletePoints.run(date);
      if (Array.isArray(day.points)) {
        for (let i = 0; i < day.points.length; i++) {
          const point = day.points[i];
          insertPoint.run(
            date,
            i,
            point[0],
            point[1],
            day.timestamps ? day.timestamps[i] : null,
            day.elevations ? day.elevations[i] : null,
            day.speeds ? day.speeds[i] : null,
            day.times ? day.times[i] : null
          );
        }
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function getAllData() {
  const database = openDatabase();
  const trackRows = database.prepare('SELECT * FROM tracks ORDER BY date').all();
  const allData = {};

  for (const row of trackRows) {
    allData[row.date] = {
      count: row.count,
      points: [],
      timestamps: [],
      elevations: [],
      altitude_min: row.altitude_min,
      altitude_max: row.altitude_max,
      speeds: [],
      speed_min: row.speed_min,
      speed_max: row.speed_max,
      times: [],
      start_time: row.start_time,
      end_time: row.end_time,
    };
  }

  const pointRows = database.prepare(
    'SELECT date, idx, lat, lng, timestamp, elevation, speed, time FROM track_points ORDER BY date, idx'
  ).all();

  for (const row of pointRows) {
    const day = allData[row.date];
    if (!day) continue;
    day.points.push([row.lat, row.lng]);
    day.timestamps.push(row.timestamp);
    day.elevations.push(row.elevation);
    day.speeds.push(row.speed);
    day.times.push(row.time);
  }

  return allData;
}

export function getPathLabels() {
  const database = openDatabase();
  const rows = database.prepare('SELECT date, segment_index, label FROM path_labels ORDER BY date, segment_index').all();
  const labels = {};
  for (const row of rows) {
    labels[`${row.date}#${row.segment_index}`] = row.label;
  }
  return labels;
}

export function setPathLabels(labels) {
  const database = openDatabase();
  const insert = database.prepare(
    'INSERT OR REPLACE INTO path_labels (date, segment_index, label) VALUES (?, ?, ?)'
  );
  const clear = database.prepare('DELETE FROM path_labels');

  database.exec('BEGIN');
  try {
    clear.run();
    for (const key of Object.keys(labels)) {
      const separatorIndex = key.lastIndexOf('#');
      if (separatorIndex === -1) continue;
      const date = key.slice(0, separatorIndex);
      const segmentIndex = Number(key.slice(separatorIndex + 1));
      if (!Number.isFinite(segmentIndex)) continue;
      insert.run(date, segmentIndex, labels[key]);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function getCustomLabels() {
  const database = openDatabase();
  const rows = database.prepare('SELECT label FROM custom_labels ORDER BY label').all();
  return rows.map((row) => row.label);
}

export function setCustomLabels(labels) {
  const database = openDatabase();
  const insert = database.prepare(
    'INSERT OR REPLACE INTO custom_labels (label, created_at) VALUES (?, COALESCE((SELECT created_at FROM custom_labels WHERE label = ?), ?))'
  );
  const clear = database.prepare('DELETE FROM custom_labels');

  database.exec('BEGIN');
  try {
    clear.run();
    for (const label of labels) {
      const normalized = String(label || '').trim();
      if (!normalized) continue;
      insert.run(normalized, normalized, new Date().toISOString());
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function getPathFavorites() {
  const database = openDatabase();
  const rows = database.prepare(
    'SELECT date, segment_index, note, created_at FROM path_favorites ORDER BY date, segment_index'
  ).all();
  const favorites = {};
  for (const row of rows) {
    favorites[`${row.date}#${row.segment_index}`] = {
      note: row.note,
      createdAt: row.created_at,
    };
  }
  return favorites;
}

export function setPathFavorites(favorites) {
  const database = openDatabase();
  const insert = database.prepare(
    'INSERT OR REPLACE INTO path_favorites (date, segment_index, note, created_at) VALUES (?, ?, ?, ?)'
  );
  const clear = database.prepare('DELETE FROM path_favorites');

  database.exec('BEGIN');
  try {
    clear.run();
    for (const key of Object.keys(favorites)) {
      const separatorIndex = key.lastIndexOf('#');
      if (separatorIndex === -1) continue;
      const date = key.slice(0, separatorIndex);
      const segmentIndex = Number(key.slice(separatorIndex + 1));
      if (!Number.isFinite(segmentIndex)) continue;
      const entry = favorites[key];
      const note = entry && typeof entry === 'object' ? entry.note : String(entry);
      const createdAt = entry && typeof entry === 'object' ? entry.createdAt : '';
      insert.run(date, segmentIndex, note ?? '', createdAt ?? '');
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
