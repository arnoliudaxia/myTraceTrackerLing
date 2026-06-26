import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const run = (cmd, ...args) => {
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      cwd: process.cwd(),
      shell: false,
    });
    if (result.error) throw result.error;
    return (result.stdout || '').trim();
  } catch (e) {
    return e.stderr?.toString?.() || e.message || '';
  }
};

const escapeHtml = (str) =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const branch = run('git', 'branch', '--show-current');
const status = run('git', 'status', '--short');
const statusLines = status ? status.split('\n').filter(Boolean) : [];

const aheadBehind = run('git', 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}');
let ahead = 0, behind = 0;
if (/^(\d+)\s+(\d+)$/.test(aheadBehind)) {
  ahead = RegExp.$1;
  behind = RegExp.$2;
}

const logLines = run('git', 'log', '--oneline', '--decorate', '-20').split('\n').filter(Boolean);
const stat = run('git', 'diff', '--stat');

const modifiedFiles = statusLines
  .filter((line) => line.startsWith(' M ') || line.startsWith('M  ') || line.startsWith('MM ') || line.startsWith(' A ') || line.startsWith('A  '))
  .map((line) => line.slice(3).trim());

const untrackedFiles = statusLines
  .filter((line) => line.startsWith('?? '))
  .map((line) => line.slice(3).trim());

const MAX_DIFF_LINES = 120;
const renderFileDiff = (file) => {
  const diff = run('git', 'diff', '--', file);
  if (!diff) return '<p class="muted">无 diff 内容</p>';
  const lines = diff.split('\n');
  const truncated = lines.length > MAX_DIFF_LINES;
  const displayLines = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines;
  const html = displayLines
    .map((line) => {
      let cls = '';
      if (line.startsWith('+')) cls = 'add';
      else if (line.startsWith('-')) cls = 'del';
      else if (line.startsWith('@@')) cls = 'meta';
      else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) cls = 'header';
      return `<div class="line ${cls}">${escapeHtml(line)}</div>`;
    })
    .join('');
  const note = truncated
    ? `<p class="truncated">⚠️ 该文件 diff 共 ${lines.length} 行，仅展示前 ${MAX_DIFF_LINES} 行。完整内容请用命令行查看。</p>`
    : '';
  return `<div class="diff">${html}</div>${note}`;
};

const fileCards = modifiedFiles
  .map((file) => {
    const statLine = (stat.split('\n').find((l) => l.trim().startsWith(file)) || '').trim();
    return `
      <div class="card">
        <div class="card-header" onclick="this.parentElement.classList.toggle('open')">
          <span class="filename">${escapeHtml(file)}</span>
          <span class="filestat">${escapeHtml(statLine)}</span>
        </div>
        <div class="card-body">
          ${renderFileDiff(file)}
        </div>
      </div>
    `;
  })
  .join('');

const untrackedList = untrackedFiles.length
  ? `<ul>${untrackedFiles.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
  : '<p class="muted">无未跟踪文件</p>';

const statusTableRows = statusLines
  .map((line) => {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    let desc = '';
    if (code === ' M') desc = '已修改（未暂存）';
    else if (code === 'M ') desc = '已修改（已暂存）';
    else if (code === 'MM') desc = '已修改（部分暂存）';
    else if (code === 'A ') desc = '新增（已暂存）';
    else if (code === 'AM') desc = '新增（部分暂存）';
    else if (code === '??') desc = '未跟踪';
    else if (code === 'D ') desc = '已删除（已暂存）';
    else if (code === ' D') desc = '已删除（未暂存）';
    else desc = '状态 ' + code;
    return `<tr><td class="code">${escapeHtml(code)}</td><td>${escapeHtml(file)}</td><td>${escapeHtml(desc)}</td></tr>`;
  })
  .join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Git 差别报告</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --muted: #8b949e;
      --accent: #58a6ff;
      --add: #238636;
      --add-bg: rgba(35, 134, 54, 0.15);
      --del: #da3633;
      --del-bg: rgba(218, 54, 51, 0.15);
      --meta: #d2a8ff;
      --header: #8b949e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 24px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { font-size: 20px; margin-top: 32px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .meta { color: var(--muted); font-size: 14px; margin-bottom: 24px; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--surface);
      border: 1px solid var(--border);
      font-size: 13px;
      margin-right: 8px;
    }
    .badge.ok { border-color: var(--add); color: #3fb950; }
    .badge.warn { border-color: #d29922; color: #d29922; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; font-size: 13px; }
    td.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-top: 12px;
      overflow: hidden;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      cursor: pointer;
      user-select: none;
      background: rgba(88, 166, 255, 0.05);
    }
    .card-header:hover { background: rgba(88, 166, 255, 0.1); }
    .filename { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
    .filestat { color: var(--muted); font-size: 13px; }
    .card-body { display: none; padding: 12px; }
    .card.open .card-body { display: block; }
    .diff {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      line-height: 1.5;
    }
    .diff .line { padding: 0 12px; white-space: pre; }
    .diff .line.add { background: var(--add-bg); color: #7ee787; }
    .diff .line.del { background: var(--del-bg); color: #ffa198; }
    .diff .line.meta { color: var(--meta); }
    .diff .line.header { color: var(--header); }
    .muted { color: var(--muted); }
    .truncated { color: #d29922; font-size: 13px; margin: 8px 0 0; }
    ul { padding-left: 20px; }
    li { margin: 4px 0; }
    .log { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
    .log div { padding: 2px 0; }
    .summary { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Git 差别报告</h1>
    <div class="meta">生成时间：${new Date().toLocaleString('zh-CN')}</div>

    <section>
      <h2>分支状态</h2>
      <div class="summary">
        <span class="badge">分支：${escapeHtml(branch)}</span>
        <span class="badge ${ahead == 0 && behind == 0 ? 'ok' : 'warn'}">
          本地 vs 远程：${ahead} 领先 / ${behind} 落后
        </span>
      </div>
      <p>${ahead == 0 && behind == 0 ? '✅ 本地分支已与远程同步。' : '⚠️ 本地与远程存在差异。'}</p>
    </section>

    <section>
      <h2>工作区状态</h2>
      <table>
        <thead>
          <tr><th>状态码</th><th>文件</th><th>说明</th></tr>
        </thead>
        <tbody>
          ${statusTableRows || '<tr><td colspan="3" class="muted">工作区干净</td></tr>'}
        </tbody>
      </table>
    </section>

    <section>
      <h2>最近提交历史</h2>
      <div class="log">
        ${logLines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
      </div>
    </section>

    <section>
      <h2>修改文件 Diff（点击展开）</h2>
      ${fileCards || '<p class="muted">没有已修改的文件</p>'}
    </section>

    <section>
      <h2>未跟踪文件</h2>
      ${untrackedList}
    </section>
  </div>
</body>
</html>`;

const outPath = resolve(process.cwd(), 'diff-report.html');
writeFileSync(outPath, html, 'utf8');
console.log('报告已生成：', outPath);
