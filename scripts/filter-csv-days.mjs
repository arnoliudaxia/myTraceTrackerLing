import fs from 'node:fs';
import path from 'node:path';

function splitCsvRecords(text) {
  const records = [];
  let start = 0;
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        i++;
      } else if (char === '"') {
        inQuotes = false;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === '\n') {
      records.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }

  if (start < text.length) records.push(text.slice(start));
  return records;
}

function parseCsvRecord(record) {
  const line = record.replace(/[\r\n]+$/, '');
  const fields = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

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
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    inPlace: false,
    dayColumn: 'dayTime',
    maxPoints: 10,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--in-place') {
      args.inPlace = true;
    } else if (arg === '-o' || arg === '--output') {
      args.output = argv[++i];
    } else if (arg === '--day-column') {
      args.dayColumn = argv[++i];
    } else if (arg === '--max-points') {
      args.maxPoints = Number(argv[++i]);
    } else if (!args.input) {
      args.input = arg;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (!args.input) {
    throw new Error('用法: node scripts/filter-csv-days.mjs <input.csv> [--in-place|-o output.csv]');
  }
  if (args.inPlace && args.output) {
    throw new Error('--in-place 不能和 --output 同时使用');
  }
  if (!Number.isFinite(args.maxPoints)) {
    throw new Error('--max-points 必须是数字');
  }
  return args;
}

function defaultOutputPath(inputPath) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}_filtered${parsed.ext}`);
}

function filterCsvDays({ input, output, inPlace, dayColumn, maxPoints }) {
  const inputPath = path.resolve(input);
  const outputPath = path.resolve(inPlace ? inputPath : (output || defaultOutputPath(inputPath)));
  const text = fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, '');
  const records = splitCsvRecords(text);
  if (records.length === 0) throw new Error('CSV 为空');

  const headerRecord = records[0];
  const header = parseCsvRecord(headerRecord);
  const dayIndex = header.indexOf(dayColumn);
  if (dayIndex === -1) throw new Error(`找不到列: ${dayColumn}`);

  const dataRecords = [];
  const counts = new Map();
  for (const record of records.slice(1)) {
    if (record.replace(/[\r\n]+$/, '') === '') continue;
    const fields = parseCsvRecord(record);
    const day = fields[dayIndex];
    dataRecords.push({ record, day });
    counts.set(day, (counts.get(day) || 0) + 1);
  }

  const keepDays = new Set([...counts.entries()]
    .filter(([, count]) => count > maxPoints)
    .map(([day]) => day));
  const keptRecords = dataRecords.filter(({ day }) => keepDays.has(day));
  const outputText = headerRecord + keptRecords.map(({ record }) => record).join('');
  fs.writeFileSync(outputPath, outputText, 'utf8');

  const removedDays = [...counts.values()].filter((count) => count <= maxPoints).length;
  return {
    outputPath,
    originalRecords: dataRecords.length,
    keptRecords: keptRecords.length,
    removedRecords: dataRecords.length - keptRecords.length,
    originalDays: counts.size,
    keptDays: keepDays.size,
    removedDays,
  };
}

try {
  const stats = filterCsvDays(parseArgs(process.argv.slice(2)));
  console.log(`Output: ${stats.outputPath}`);
  console.log(`Original records: ${stats.originalRecords}`);
  console.log(`Kept records: ${stats.keptRecords}`);
  console.log(`Removed records: ${stats.removedRecords}`);
  console.log(`Original days: ${stats.originalDays}`);
  console.log(`Kept days: ${stats.keptDays}`);
  console.log(`Removed days: ${stats.removedDays}`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
