import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const CSV_FILE = path.join(rootDir, '灵敢足迹(2020.06.25-2026.05.01).csv');
const JSON_FILE = path.join(rootDir, 'all_dates_points.json');
const PATH_LABELS_FILE = path.join(rootDir, 'path_labels.json');
const TIME_ZONE = 'Asia/Shanghai';
const PATH_GAP_THRESHOLD_MS = 60 * 60 * 1000;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readCsvObjects(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV is empty');

  const header = rows[0];
  return rows.slice(1)
    .filter((row) => row.some((value) => value !== ''))
    .map((row) => Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])));
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TIME_ZONE,
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function localDate(timestampMs) {
  return dateFormatter.format(new Date(timestampMs));
}

function localTime(timestampMs) {
  return timeFormatter.format(new Date(timestampMs));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ensureDate(row) {
  if (row.date) return String(row.date);

  const dayTime = finiteNumber(row.dayTime);
  if (dayTime !== null) return localDate(dayTime * 1000);

  const geoTime = finiteNumber(row.geoTime);
  if (geoTime !== null) return localDate(geoTime);

  throw new Error('CSV 中缺少 date、dayTime 或 geoTime 字段，无法按日期分组');
}

function splitRowsIntoSegments(rows) {
  const sortedRows = rows
    .map((row) => ({ ...row, geoTimeNumber: Number(row.geoTime) }))
    .filter((row) => Number.isFinite(row.geoTimeNumber))
    .sort((a, b) => a.geoTimeNumber - b.geoTimeNumber);

  const segments = [];
  let start = 0;
  for (let i = 1; i < sortedRows.length; i++) {
    if (sortedRows[i].geoTimeNumber - sortedRows[i - 1].geoTimeNumber > PATH_GAP_THRESHOLD_MS) {
      segments.push(sortedRows.slice(start, i));
      start = i;
    }
  }
  if (sortedRows.length > 0) segments.push(sortedRows.slice(start));
  return segments;
}

function mergeCrossDaySegments(dateSegments) {
  let lastNonEmptyDate = null;
  for (const date of Object.keys(dateSegments).sort()) {
    const segments = dateSegments[date];
    if (lastNonEmptyDate === null) {
      if (segments.length > 0) lastNonEmptyDate = date;
      continue;
    }

    if (segments.length === 0) continue;

    const previousSegments = dateSegments[lastNonEmptyDate];
    const previousLast = previousSegments[previousSegments.length - 1];
    const previousLastTime = previousLast[previousLast.length - 1].geoTimeNumber;
    const nextFirstTime = segments[0][0].geoTimeNumber;
    const gap = nextFirstTime - previousLastTime;

    if (gap >= 0 && gap <= PATH_GAP_THRESHOLD_MS) {
      previousSegments[previousSegments.length - 1] = previousLast
        .concat(segments[0])
        .sort((a, b) => a.geoTimeNumber - b.geoTimeNumber);
      dateSegments[date] = segments.slice(1);
      if (dateSegments[date].length > 0) lastNonEmptyDate = date;
    } else {
      lastNonEmptyDate = date;
    }
  }
  return dateSegments;
}

function range(values) {
  const finiteValues = values.filter((value) => value !== null && Number.isFinite(value));
  if (finiteValues.length === 0) return { min: null, max: null };
  return {
    min: Math.min(...finiteValues),
    max: Math.max(...finiteValues),
  };
}

function buildDayData(segments) {
  const rows = segments.flat().sort((a, b) => a.geoTimeNumber - b.geoTimeNumber);
  const points = [];
  const elevations = [];
  const speeds = [];
  const timestamps = [];
  const times = [];

  for (const row of rows) {
    points.push([Number(row.latitude), Number(row.longitude)]);
    elevations.push(finiteNumber(row.altitude));
    speeds.push(finiteNumber(row.speed));
    timestamps.push(row.geoTimeNumber);
    times.push(localTime(row.geoTimeNumber));
  }

  const altitudeRange = range(elevations);
  const speedRange = range(speeds);
  return {
    count: points.length,
    points,
    timestamps,
    elevations,
    altitude_min: altitudeRange.min,
    altitude_max: altitudeRange.max,
    speeds,
    speed_min: speedRange.min,
    speed_max: speedRange.max,
    times,
    start_time: times[0],
    end_time: times[times.length - 1],
  };
}

function generate() {
  const rows = readCsvObjects(CSV_FILE);
  const grouped = new Map();

  for (const row of rows) {
    const date = ensureDate(row);
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(row);
  }

  let dateSegments = Object.fromEntries(
    [...grouped.entries()].map(([date, dateRows]) => [date, splitRowsIntoSegments(dateRows)]),
  );
  dateSegments = mergeCrossDaySegments(dateSegments);

  const allData = {};
  for (const date of Object.keys(dateSegments).sort()) {
    const segments = dateSegments[date];
    if (segments.length === 0) continue;
    allData[date] = buildDayData(segments);
  }

  fs.writeFileSync(JSON_FILE, `${JSON.stringify(allData, null, 2)}\n`, 'utf8');
  if (!fs.existsSync(PATH_LABELS_FILE)) {
    fs.writeFileSync(PATH_LABELS_FILE, '{}\n', 'utf8');
  }

  const latestDate = Object.keys(allData).sort().at(-1);
  const totalRecords = Object.values(allData).reduce((sum, day) => sum + day.count, 0);
  console.log(`完成！生成了 ${Object.keys(allData).length} 个日期的数据`);
  console.log(`总记录数: ${totalRecords}`);
  console.log(`最新日期: ${latestDate} (默认选中)`);
  console.log(`数据文件: ${JSON_FILE}`);
  console.log(`标签文件: ${PATH_LABELS_FILE}`);
}

generate();
