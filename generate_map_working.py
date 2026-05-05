import json
import pandas as pd
import datetime
import math
from pathlib import Path
from zoneinfo import ZoneInfo

BASE_DIR = Path(__file__).resolve().parent
CSV_FILE = BASE_DIR / '灵敢足迹(2020.06.25-2026.05.01).csv'
JSON_FILE = BASE_DIR / 'all_dates_points.json'
PATH_LABELS_FILE = BASE_DIR / 'path_labels.json'
HTML_FILE = BASE_DIR / '灵敢足迹_轨迹可视化.html'
LOCAL_TIMEZONE = ZoneInfo('Asia/Shanghai')
PATH_GAP_THRESHOLD_MS = 60 * 60 * 1000


def ensure_date_column(dataframe):
    """Ensure a YYYY-MM-DD date column exists for grouping tracks."""
    if 'date' in dataframe.columns:
        dataframe['date'] = dataframe['date'].astype(str)
        return dataframe

    if 'dayTime' in dataframe.columns:
        day_seconds = pd.to_numeric(dataframe['dayTime'], errors='coerce')
        dataframe['date'] = (
            pd.to_datetime(day_seconds, unit='s', utc=True)
            .dt.tz_convert('Asia/Shanghai')
            .dt.strftime('%Y-%m-%d')
        )
        return dataframe

    if 'geoTime' in dataframe.columns:
        geo_milliseconds = pd.to_numeric(dataframe['geoTime'], errors='coerce')
        dataframe['date'] = (
            pd.to_datetime(geo_milliseconds, unit='ms', utc=True)
            .dt.tz_convert('Asia/Shanghai')
            .dt.strftime('%Y-%m-%d')
        )
        return dataframe

    raise ValueError('CSV 中缺少 date、dayTime 或 geoTime 字段，无法按日期分组')


def read_altitude(row):
    """Return a finite altitude value in meters, or None when unavailable."""
    if 'altitude' not in row:
        return None

    try:
        altitude = float(row['altitude'])
    except (TypeError, ValueError):
        return None

    if not math.isfinite(altitude):
        return None
    return altitude


def read_speed(row):
    """Return a finite speed value in m/s, or None when unavailable."""
    if 'speed' not in row:
        return None

    try:
        speed = float(row['speed'])
    except (TypeError, ValueError):
        return None

    if not math.isfinite(speed):
        return None
    return speed


def split_group_into_segments(group):
    """Split one day's sorted rows into continuous path segments."""
    group = group.copy()
    group['geoTimeNumber'] = pd.to_numeric(group['geoTime'], errors='coerce')
    group = group.sort_values('geoTimeNumber')

    segments = []
    start = 0
    rows = list(group.index)
    times = group['geoTimeNumber'].tolist()
    for position in range(1, len(rows)):
        if times[position] - times[position - 1] > PATH_GAP_THRESHOLD_MS:
            segments.append(group.loc[rows[start:position]])
            start = position
    if rows:
        segments.append(group.loc[rows[start:]])
    return segments


def merge_cross_day_segments(date_segments):
    """Merge next day's first segment into previous day when time-continuous."""
    last_nonempty_date = None
    for date in sorted(date_segments.keys()):
        segments = date_segments[date]
        if last_nonempty_date is None:
            if segments:
                last_nonempty_date = date
            continue

        if not segments:
            continue

        previous_segments = date_segments[last_nonempty_date]
        previous_last_time = previous_segments[-1]['geoTimeNumber'].iloc[-1]
        next_first_time = segments[0]['geoTimeNumber'].iloc[0]
        gap = next_first_time - previous_last_time
        if 0 <= gap <= PATH_GAP_THRESHOLD_MS:
            previous_segments[-1] = pd.concat([previous_segments[-1], segments[0]]).sort_values('geoTimeNumber')
            date_segments[date] = segments[1:]
            if date_segments[date]:
                last_nonempty_date = date
        else:
            last_nonempty_date = date

    return date_segments


# 读取当前CSV。filter_csv_days.py 会直接清洗并覆盖这个文件。
df = pd.read_csv(CSV_FILE)
df = ensure_date_column(df)

# 确保geoTime是字符串类型
df['geoTime'] = df['geoTime'].astype(str)

# 按日期分组并先切分路径段；跨天连续的路径段会合并到前一天
date_segments = {
    date: split_group_into_segments(group)
    for date, group in df.groupby('date')
}
date_segments = merge_cross_day_segments(date_segments)

# 准备数据
all_data = {}
for date in sorted(date_segments.keys()):
    segments = date_segments[date]
    if not segments:
        continue
    group = pd.concat(segments).sort_values('geoTimeNumber')
    points = []
    elevations = []
    speeds = []
    timestamps = []
    times = []
    for _, row in group.iterrows():
        lat = float(row['latitude'])
        lng = float(row['longitude'])
        points.append([lat, lng])
        elevations.append(read_altitude(row))
        speeds.append(read_speed(row))
        
        # 转换时间戳为可读时间
        timestamp = int(row['geoTime'])
        timestamps.append(timestamp)
        dt = datetime.datetime.fromtimestamp(timestamp / 1000, datetime.timezone.utc).astimezone(LOCAL_TIMEZONE)
        times.append(dt.strftime('%H:%M:%S'))
    
    valid_elevations = [elevation for elevation in elevations if elevation is not None]
    valid_speeds = [speed for speed in speeds if speed is not None]
    all_data[date] = {
        'count': len(points),
        'points': points,
        'timestamps': timestamps,
        'elevations': elevations,
        'altitude_min': min(valid_elevations) if valid_elevations else None,
        'altitude_max': max(valid_elevations) if valid_elevations else None,
        'speeds': speeds,
        'speed_min': min(valid_speeds) if valid_speeds else None,
        'speed_max': max(valid_speeds) if valid_speeds else None,
        'times': times,
        'start_time': times[0],
        'end_time': times[-1]
    }

# 保存JSON数据到单独的文件
with open(JSON_FILE, 'w', encoding='utf-8') as f:
    json.dump(all_data, f, ensure_ascii=False, indent=2)

if not PATH_LABELS_FILE.exists():
    with open(PATH_LABELS_FILE, 'w', encoding='utf-8') as f:
        json.dump({}, f, ensure_ascii=False, indent=2)

# 生成HTML
html_template = '''<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>灵敢足迹 - 地理路径可视化</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:"Microsoft YaHei",Arial,sans-serif; }
        #map { width:100%; height:100vh; }
        .control-panel { position:fixed; top:10px; left:50px; background:white; padding:15px; border-radius:8px; box-shadow:0 2px 15px rgba(0,0,0,0.3); z-index:1000; min-width:340px; }
        .control-panel h2 { margin:0 0 12px 0; color:#333; font-size:18px; }
        .date-selector { margin-bottom:12px; }
        .date-selector.disabled { opacity:0.45; pointer-events:none; }
        .date-selector label { display:block; margin-bottom:5px; color:#666; font-size:14px; font-weight:bold; }
        .date-selector select { width:100%; padding:8px; border:1px solid #ddd; border-radius:4px; font-size:13px; font-family:"Microsoft YaHei",Arial,sans-serif; cursor:pointer; }
        .coord-info { font-size:12px; color:#999; margin-top:8px; line-height:1.5; }
        .info-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
        .info-item { padding:8px; background:#f5f5f5; border-radius:4px; font-size:13px; }
        .info-item .label { color:#999; font-size:11px; margin-bottom:2px; }
        .info-item .value { color:#333; font-weight:bold; }
        .legend { position:fixed; bottom:30px; right:10px; background:white; padding:12px; border-radius:5px; box-shadow:0 2px 10px rgba(0,0,0,0.3); z-index:1000; font-size:12px; }
        .legend-item { margin:6px 0; display:flex; align-items:center; }
        .legend-color { display:inline-block; width:24px; height:3px; margin-right:8px; }
        .legend-dot { display:inline-block; width:12px; height:12px; border-radius:50%; margin-right:8px; }
        .stats-panel { position:fixed; bottom:10px; left:10px; background:white; padding:10px 15px; border-radius:5px; box-shadow:0 2px 10px rgba(0,0,0,0.3); z-index:1000; font-size:12px; color:#666; }
        .tile-selector { margin-top:10px; }
        .tile-selector label { display:block; margin-bottom:5px; color:#666; font-size:12px; }
        .tile-selector select { width:100%; padding:5px; border:1px solid #ddd; border-radius:4px; font-size:12px; }
        .segment-selector { margin-top:10px; }
        .segment-selector label { display:block; margin-bottom:5px; color:#666; font-size:12px; }
        .segment-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; max-height:120px; overflow-y:auto; padding-right:2px; }
        .segment-button { padding:6px 4px; border:1px solid #ddd; border-radius:4px; background:#fafafa; color:#555; font-size:12px; font-family:"Microsoft YaHei",Arial,sans-serif; cursor:pointer; }
        .segment-button.active { background:#3388ff; border-color:#3388ff; color:white; font-weight:bold; }
        .label-selector { margin-bottom:12px; }
        .label-selector label { display:block; margin-bottom:5px; color:#666; font-size:12px; font-weight:bold; }
        .label-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; max-height:96px; overflow-y:auto; padding-right:2px; }
        .label-button { padding:6px 4px; border:1px solid #ddd; border-radius:4px; background:#fafafa; color:#555; font-size:12px; font-family:"Microsoft YaHei",Arial,sans-serif; cursor:pointer; }
        .label-button.active { background:#7c3aed; border-color:#7c3aed; color:white; font-weight:bold; }
        .label-editor { display:grid; grid-template-columns:1fr auto auto; gap:6px; margin-top:8px; }
        .label-editor input { min-width:0; padding:6px; border:1px solid #ddd; border-radius:4px; font-size:12px; }
        .label-editor button { padding:6px 8px; border:1px solid #ccd6e0; border-radius:4px; background:#f8fbff; color:#2c5c86; font-size:12px; cursor:pointer; }
        .mode-hint { display:none; margin-bottom:8px; padding:6px 8px; border-radius:4px; background:#f5efff; color:#6d28d9; font-size:12px; }
        .mode-hint.active { display:block; }
        .mode-button { width:100%; margin-top:10px; padding:8px; border:1px solid #ccd6e0; border-radius:4px; background:#f8fbff; color:#2c5c86; font-size:13px; font-family:"Microsoft YaHei",Arial,sans-serif; cursor:pointer; }
        .mode-button.active { background:#2c5c86; border-color:#2c5c86; color:white; }
        .point-toggle.active { background:#166534; border-color:#166534; }
        .metric-legend { display:none; margin-top:10px; padding-top:10px; border-top:1px solid #eee; }
        .metric-legend.active { display:block; }
        .metric-gradient { height:10px; width:140px; margin:6px 0; border-radius:999px; background:linear-gradient(90deg,#2b6cff,#00c2ff,#21c45d,#ffd23f,#ff4d4f); }
        .metric-scale { display:flex; justify-content:space-between; gap:10px; color:#666; font-size:11px; }
    </style>
</head>
<body>
    <div id="map"></div>
    <div class="control-panel">
        <h2>📍 灵敢足迹可视化</h2>
        <div class="label-selector">
            <label>🏷️ 标签:</label>
            <div id="labelGrid" class="label-grid"></div>
            <div class="label-editor">
                <input id="labelInput" type="text" placeholder="给选中路径打标签">
                <button type="button" onclick="applyLabelToSelectedSegments()">应用</button>
                <button type="button" onclick="savePathLabels()">保存</button>
            </div>
        </div>
        <div id="labelModeHint" class="mode-hint">标签模式：日期选择暂时无效</div>
        <div id="dateSelectorPanel" class="date-selector">
            <label>📅 选择日期:</label>
            <select id="dateSelect" onchange="changeDate()">
'''

# 找到最新日期
latest_date = max(all_data.keys())

# 添加日期选项
for date in sorted(all_data.keys()):
    data = all_data[date]
    selected = ' selected' if date == latest_date else ''
    html_template += f'        <option value="{date}"{selected}>{date} ({data["count"]}个点, {data["start_time"]}-{data["end_time"]})</option>\n'

html_template += '''            </select>
        </div>
        <div class="coord-info">📌 已启用坐标纠正（国内APP数据→WGS84）</div>
        <button id="altitudeToggle" class="mode-button" type="button" onclick="toggleAltitudeMode()">海拔路径：关闭</button>
        <button id="speedToggle" class="mode-button" type="button" onclick="toggleSpeedMode()">速度路径：关闭</button>
        <button id="dataPointToggle" class="mode-button point-toggle" type="button" onclick="toggleDataPoints()">数据点：关闭</button>
        <div class="segment-selector">
            <label>🧭 路径段:</label>
            <div id="segmentGrid" class="segment-grid"></div>
        </div>
        <div class="tile-selector">
            <label>🗺️ 地图源:</label>
            <select id="tileSelect" onchange="changeTile()">
                <option value="osm">OpenStreetMap</option>
                <option value="cartodb">CartoDB 亮色</option>
                <option value="cartodb_dark">CartoDB 暗色</option>
            </select>
        </div>
        <div class="info-grid">
            <div class="info-item">
                <div class="label">轨迹点数</div>
                <div class="value" id="pointCount">-</div>
            </div>
            <div class="info-item">
                <div class="label">时间段</div>
                <div class="value" id="timeRange">-</div>
            </div>
            <div class="info-item">
                <div class="label">海拔范围</div>
                <div class="value" id="altitudeRange">-</div>
            </div>
            <div class="info-item">
                <div class="label">速度范围</div>
                <div class="value" id="speedRange">-</div>
            </div>
            <div class="info-item">
                <div class="label">路径段数</div>
                <div class="value" id="segmentCount">-</div>
            </div>
        </div>
    </div>
    <div class="legend">
        <div style="font-weight:bold; margin-bottom:8px;">图例</div>
        <div class="legend-item"><span class="legend-color" style="background:#3388ff;"></span>移动轨迹</div>
        <div id="metricLegend" class="metric-legend">
            <div id="metricLegendTitle" style="font-weight:bold;">可视化路径</div>
            <div class="metric-gradient"></div>
            <div class="metric-scale"><span id="metricMinLabel">低</span><span id="metricMaxLabel">高</span></div>
        </div>
    </div>
    <div class="stats-panel">
        📊 总日期数: ''' + str(len(all_data)) + ''' | 总记录数: ''' + str(sum(d['count'] for d in all_data.values())) + '''
    </div>
    <script>
var tileLayers = {
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }),
    cartodb: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
        attribution: '© CARTO'
    }),
    cartodb_dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
        attribution: '© CARTO'
    })
};

function outOfChina(lat,lng){if(lng<72.004||lng>137.8347)return true;if(lat<0.8293||lat>55.8271)return true;return false;}
function transformLat(x,y){var ret=-100.0+2.0*x+3.0*y+0.2*y*y+0.1*x*y+0.2*Math.sqrt(Math.abs(x));ret+=(20.0*Math.sin(6.0*x*Math.PI)+20.0*Math.sin(2.0*x*Math.PI))*2.0/3.0;ret+=(20.0*Math.sin(y*Math.PI)+40.0*Math.sin(y/3.0*Math.PI))*2.0/3.0;ret+=(160.0*Math.sin(y/12.0*Math.PI)+320.0*Math.sin(y*Math.PI/30.0))*2.0/3.0;return ret;}
function transformLng(x,y){var ret=300.0+x+2.0*y+0.1*x*x+0.1*x*y+0.1*Math.sqrt(Math.abs(x));ret+=(20.0*Math.sin(6.0*x*Math.PI)+20.0*Math.sin(2.0*x*Math.PI))*2.0/3.0;ret+=(20.0*Math.sin(x*Math.PI)+40.0*Math.sin(x/3.0*Math.PI))*2.0/3.0;ret+=(150.0*Math.sin(x/12.0*Math.PI)+300.0*Math.sin(x/30.0*Math.PI))*2.0/3.0;return ret;}
function correctCoord(lat,lng){if(outOfChina(lat,lng))return[lat,lng];var a=6378245.0,ee=0.00669342162296594323;var dLat=transformLat(lng-105.0,lat-35.0);var dLng=transformLng(lng-105.0,lat-35.0);var radLat=lat/180.0*Math.PI;var magic=Math.sin(radLat);magic=1-ee*magic*magic;var sqrtMagic=Math.sqrt(magic);dLat=(dLat*180.0)/((a*(1-ee))/(magic*sqrtMagic)*Math.PI);dLng=(dLng*180.0)/(a/sqrtMagic*Math.cos(radLat)*Math.PI);return[lat-dLat,lng-dLng];}
function correctTrackPoints(points){return points.map(function(p){return correctCoord(p[0],p[1]);});}

var allData = null;
var pathLabels = {};
var selectedLabels = [];
var map = L.map('map').setView([31.23, 121.47], 12);
var currentTileLayer = tileLayers.osm.addTo(map);
var currentLayer = null;
var metricLayer = null;
var dataPointLayer = null;
var currentDate = null;
var activeMetric = null;
var showDataPoints = false;
var currentCorrectedPoints = [];
var currentSegments = [];
var selectedSegments = 'all';
var segmentGapThresholdMs = 60 * 60 * 1000;

function changeTile() {
    var tileType = document.getElementById('tileSelect').value;
    map.removeLayer(currentTileLayer);
    currentTileLayer = tileLayers[tileType].addTo(map);
}

function pathLabelKey(date, segmentIndex) {
    return date + '#' + segmentIndex;
}

function uniqueLabels() {
    var labels = Object.values(pathLabels)
        .map(function(label) { return String(label || '').trim(); })
        .filter(function(label) { return label.length > 0; });
    return Array.from(new Set(labels)).sort();
}

function isLabelMode() {
    return selectedLabels.length > 0;
}

function populateLabelButtons() {
    var grid = document.getElementById('labelGrid');
    grid.innerHTML = '';

    var dateModeButton = document.createElement('button');
    dateModeButton.type = 'button';
    dateModeButton.className = 'label-button' + (!isLabelMode() ? ' active' : '');
    dateModeButton.textContent = '日期模式';
    dateModeButton.onclick = function() { clearLabelMode(); };
    grid.appendChild(dateModeButton);

    uniqueLabels().forEach(function(label) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'label-button' + (selectedLabels.indexOf(label) !== -1 ? ' active' : '');
        button.textContent = label;
        button.title = label;
        button.onclick = function() { toggleLabel(label); };
        grid.appendChild(button);
    });
}

function clearLabelMode() {
    selectedLabels = [];
    populateLabelButtons();
    setDateControlsDisabled(false);
    loadTrack(currentDate || document.getElementById('dateSelect').value);
}

function toggleLabel(label) {
    var index = selectedLabels.indexOf(label);
    if (index === -1) {
        selectedLabels.push(label);
        selectedLabels.sort();
    } else {
        selectedLabels.splice(index, 1);
    }
    populateLabelButtons();
    if (isLabelMode()) {
        renderLabelMode();
    } else {
        clearLabelMode();
    }
}

function setDateControlsDisabled(disabled) {
    document.getElementById('dateSelectorPanel').classList.toggle('disabled', disabled);
    document.getElementById('dateSelect').disabled = disabled;
    document.getElementById('labelModeHint').classList.toggle('active', disabled);
}

function selectedSegmentIndexesForLabeling() {
    if (selectedSegments === 'all') {
        return currentSegments.map(function(_, index) { return index; });
    }
    return selectedSegments.slice();
}

function applyLabelToSelectedSegments() {
    if (isLabelMode()) {
        alert('请先切回日期模式，再给路径打标签。');
        return;
    }
    if (!currentDate || currentSegments.length === 0) return;
    var label = document.getElementById('labelInput').value.trim();
    if (!label) {
        alert('请输入标签名称。');
        return;
    }
    selectedSegmentIndexesForLabeling().forEach(function(segmentIndex) {
        pathLabels[pathLabelKey(currentDate, segmentIndex)] = label;
    });
    document.getElementById('labelInput').value = '';
    populateLabelButtons();
    populateSegmentButtons(allData[currentDate]);
}

async function savePathLabels() {
    var content = JSON.stringify(pathLabels, null, 2);
    if (window.showSaveFilePicker) {
        try {
            var handle = await window.showSaveFilePicker({
                suggestedName: 'path_labels.json',
                types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
            });
            var writable = await handle.createWritable();
            await writable.write(content);
            await writable.close();
            alert('标签已保存。');
            return;
        } catch (error) {
            if (error && error.name === 'AbortError') return;
        }
    }
    var blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'path_labels.json';
    link.click();
    URL.revokeObjectURL(url);
}

function formatAltitude(value) {
    if (value === null || value === undefined || !isFinite(value)) return '-';
    return value.toFixed(1) + ' m';
}

function formatSpeed(value) {
    if (value === null || value === undefined || !isFinite(value)) return '-';
    return value.toFixed(2) + ' m/s';
}

function formatMetric(metric, value) {
    return metric === 'speed' ? formatSpeed(value) : formatAltitude(value);
}

function metricLabel(metric) {
    return metric === 'speed' ? '速度路径' : '海拔路径';
}

function metricValues(data, metric) {
    if (metric === 'speed') {
        return { values: data.speeds, min: data.speed_min, max: data.speed_max };
    }
    return { values: data.elevations, min: data.altitude_min, max: data.altitude_max };
}

function buildSegments(data) {
    var segments = [];
    if (!data || !data.points || data.points.length === 0) return segments;

    var start = 0;
    for (var i = 1; i < data.points.length; i++) {
        var previousTime = data.timestamps ? data.timestamps[i - 1] : null;
        var currentTime = data.timestamps ? data.timestamps[i] : null;
        if (previousTime !== null && currentTime !== null && currentTime - previousTime > segmentGapThresholdMs) {
            segments.push({ start: start, end: i - 1 });
            start = i;
        }
    }
    segments.push({ start: start, end: data.points.length - 1 });
    return segments;
}

function segmentOpacity(segmentIndex) {
    return isSegmentSelected(segmentIndex) ? 0.85 : 0.3;
}

function metricSegmentOpacity(segmentIndex) {
    return isSegmentSelected(segmentIndex) ? 0.95 : 0.3;
}

function isSegmentSelected(segmentIndex) {
    return selectedSegments === 'all' || selectedSegments.indexOf(segmentIndex) !== -1;
}

function selectedSegmentIndices() {
    if (selectedSegments === 'all') {
        return currentSegments.map(function(_, index) { return index; });
    }
    return selectedSegments.slice();
}

function selectedPointIndices() {
    var indices = [];
    selectedSegmentIndices().forEach(function(segmentIndex) {
        var segment = currentSegments[segmentIndex];
        if (!segment) return;
        for (var i = segment.start; i <= segment.end; i++) {
            indices.push(i);
        }
    });
    return indices;
}

function finiteRange(values, indices) {
    var selectedValues = indices
        .map(function(index) { return values ? values[index] : null; })
        .filter(function(value) { return value !== null && value !== undefined && isFinite(value); });
    if (selectedValues.length === 0) return { min: null, max: null };
    return {
        min: Math.min.apply(null, selectedValues),
        max: Math.max.apply(null, selectedValues)
    };
}

function currentSelectionStats(data) {
    var indices = selectedPointIndices();
    if (indices.length === 0) {
        return {
            count: 0,
            startTime: '-',
            endTime: '-',
            altitude: { min: null, max: null },
            speed: { min: null, max: null },
            selectedSegmentCount: 0
        };
    }

    return {
        count: indices.length,
        startTime: data.times && data.times[indices[0]] ? data.times[indices[0]] : '-',
        endTime: data.times && data.times[indices[indices.length - 1]] ? data.times[indices[indices.length - 1]] : '-',
        altitude: finiteRange(data.elevations, indices),
        speed: finiteRange(data.speeds, indices),
        selectedSegmentCount: selectedSegments === 'all' ? currentSegments.length : selectedSegments.length
    };
}

function updateInfoCards(data) {
    var stats = currentSelectionStats(data);
    document.getElementById('pointCount').textContent = stats.count + ' 个点';
    document.getElementById('timeRange').textContent = stats.startTime + ' - ' + stats.endTime;
    document.getElementById('altitudeRange').textContent =
        stats.altitude.min === null || stats.altitude.max === null ? '-' : formatAltitude(stats.altitude.min) + ' - ' + formatAltitude(stats.altitude.max);
    document.getElementById('speedRange').textContent =
        stats.speed.min === null || stats.speed.max === null ? '-' : formatSpeed(stats.speed.min) + ' - ' + formatSpeed(stats.speed.max);
    document.getElementById('segmentCount').textContent =
        stats.selectedSegmentCount + '/' + currentSegments.length + ' 段';
}

function segmentLabel(data, segment, index) {
    var startTime = data.times && data.times[segment.start] ? data.times[segment.start] : '';
    var endTime = data.times && data.times[segment.end] ? data.times[segment.end] : '';
    var count = segment.end - segment.start + 1;
    return '路径 ' + (index + 1) + ' (' + count + '点, ' + startTime + '-' + endTime + ')';
}

function populateSegmentButtons(data) {
    var grid = document.getElementById('segmentGrid');
    grid.innerHTML = '';

    var allButton = document.createElement('button');
    allButton.type = 'button';
    allButton.className = 'segment-button' + (selectedSegments === 'all' ? ' active' : '');
    allButton.textContent = '全部';
    allButton.onclick = function() { toggleSegment('all'); };
    grid.appendChild(allButton);

    currentSegments.forEach(function(segment, index) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'segment-button' + (isSegmentSelected(index) && selectedSegments !== 'all' ? ' active' : '');
        var label = pathLabels[pathLabelKey(currentDate, index)];
        button.textContent = label ? String(index + 1) + ' ' + label : String(index + 1);
        button.title = segmentLabel(data, segment, index);
        button.onclick = function() { toggleSegment(index); };
        grid.appendChild(button);
    });
    updateInfoCards(data);
}

var gradientStops = [
    { ratio: 0.0, color: [43, 108, 255] },
    { ratio: 0.25, color: [0, 194, 255] },
    { ratio: 0.5, color: [33, 196, 93] },
    { ratio: 0.75, color: [255, 210, 63] },
    { ratio: 1.0, color: [255, 77, 79] }
];

function interpolateColor(startColor, endColor, ratio) {
    var r = Math.round(startColor[0] + (endColor[0] - startColor[0]) * ratio);
    var g = Math.round(startColor[1] + (endColor[1] - startColor[1]) * ratio);
    var b = Math.round(startColor[2] + (endColor[2] - startColor[2]) * ratio);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function colorForMetric(value, minValue, maxValue) {
    if (value === null || value === undefined || !isFinite(value)) return '#999999';
    if (!isFinite(minValue) || !isFinite(maxValue) || minValue === maxValue) return 'rgb(33,196,93)';
    var ratio = Math.max(0, Math.min(1, (value - minValue) / (maxValue - minValue)));
    for (var i = 0; i < gradientStops.length - 1; i++) {
        var left = gradientStops[i];
        var right = gradientStops[i + 1];
        if (ratio >= left.ratio && ratio <= right.ratio) {
            var localRatio = (ratio - left.ratio) / (right.ratio - left.ratio);
            return interpolateColor(left.color, right.color, localRatio);
        }
    }
    return interpolateColor(gradientStops[gradientStops.length - 1].color, gradientStops[gradientStops.length - 1].color, 0);
}

function clearMetricLayer() {
    if (metricLayer) {
        map.removeLayer(metricLayer);
        metricLayer = null;
    }
}

function clearDataPointLayer() {
    if (dataPointLayer) {
        map.removeLayer(dataPointLayer);
        dataPointLayer = null;
    }
}

function updateDataPointToggle() {
    var button = document.getElementById('dataPointToggle');
    button.textContent = showDataPoints ? '数据点：开启' : '数据点：关闭';
    button.classList.toggle('active', showDataPoints);
}

function toggleDataPoints() {
    showDataPoints = !showDataPoints;
    updateDataPointToggle();
    if (isLabelMode()) {
        renderLabelMode();
    } else {
        redrawCurrentTrack();
    }
}

function drawDataPointsForSegment(layer, points, startIndex, endIndex, opacity, labelPrefix, data) {
    if (!showDataPoints || !layer) return;
    for (var i = startIndex; i <= endIndex; i++) {
        var point = points[i];
        var time = data && data.times && data.times[i] ? data.times[i] : '';
        L.circleMarker(point, {
            radius: 3,
            color: '#111827',
            weight: 1,
            opacity: opacity,
            fillColor: '#ffffff',
            fillOpacity: Math.max(0.25, opacity * 0.9)
        }).addTo(layer)
          .bindPopup('<b>数据点</b><br>' + labelPrefix + '<br>时间: ' + time + '<br>坐标: ' + point[0].toFixed(6) + ', ' + point[1].toFixed(6));
    }
}

function drawDataPoints(data, correctedPoints) {
    clearDataPointLayer();
    if (!showDataPoints || !data) return;
    dataPointLayer = L.layerGroup().addTo(map);
    currentSegments.forEach(function(segment, segmentIndex) {
        drawDataPointsForSegment(dataPointLayer, correctedPoints, segment.start, segment.end, segmentOpacity(segmentIndex), '路径 ' + (segmentIndex + 1), data);
    });
}

function drawBaseTrack(data, correctedPoints) {
    currentLayer = L.layerGroup().addTo(map);
    currentSegments.forEach(function(segment, segmentIndex) {
        if (segment.end <= segment.start) return;
        var segmentPoints = correctedPoints.slice(segment.start, segment.end + 1);
        L.polyline(segmentPoints, {
            color: '#3388ff',
            weight: 5,
            opacity: segmentOpacity(segmentIndex),
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(currentLayer);
    });
}

function drawMetricLayer(data, correctedPoints) {
    clearMetricLayer();
    if (!activeMetric || !data) return;

    var metric = metricValues(data, activeMetric);
    if (!metric.values || metric.min === null || metric.max === null) return;

    metricLayer = L.layerGroup().addTo(map);
    var stepsPerSegment = 8;
    currentSegments.forEach(function(trackSegment, trackSegmentIndex) {
        for (var i = trackSegment.start; i < trackSegment.end; i++) {
            var startValue = metric.values[i];
            var endValue = metric.values[i + 1];
            if (startValue === null || startValue === undefined || !isFinite(startValue)) continue;
            if (endValue === null || endValue === undefined || !isFinite(endValue)) continue;
            var startPoint = correctedPoints[i];
            var endPoint = correctedPoints[i + 1];
            for (var step = 0; step < stepsPerSegment; step++) {
                var t1 = step / stepsPerSegment;
                var t2 = (step + 1) / stepsPerSegment;
                var midT = (t1 + t2) / 2;
                var segmentValue = startValue + (endValue - startValue) * midT;
                var color = colorForMetric(segmentValue, metric.min, metric.max);
                var segmentStart = [
                    startPoint[0] + (endPoint[0] - startPoint[0]) * t1,
                    startPoint[1] + (endPoint[1] - startPoint[1]) * t1
                ];
                var segmentEnd = [
                    startPoint[0] + (endPoint[0] - startPoint[0]) * t2,
                    startPoint[1] + (endPoint[1] - startPoint[1]) * t2
                ];
                L.polyline([segmentStart, segmentEnd], {
                    color: color,
                    weight: 7,
                    opacity: metricSegmentOpacity(trackSegmentIndex),
                    lineCap: 'round',
                    lineJoin: 'round'
                }).addTo(metricLayer)
                  .bindPopup('<b>' + metricLabel(activeMetric) + '</b><br>起点: ' + formatMetric(activeMetric, startValue) + '<br>终点: ' + formatMetric(activeMetric, endValue));
            }
        }
    });
}

function matchingLabelRefs() {
    var refs = [];
    if (!isLabelMode()) return refs;
    Object.keys(allData).sort().forEach(function(date) {
        var data = allData[date];
        var segments = buildSegments(data);
        segments.forEach(function(segment, segmentIndex) {
            var label = pathLabels[pathLabelKey(date, segmentIndex)];
            if (selectedLabels.indexOf(label) !== -1) {
                refs.push({ date: date, data: data, segment: segment, segmentIndex: segmentIndex });
            }
        });
    });
    return refs;
}

function formatDateTime(timestamp) {
    if (timestamp === null || timestamp === undefined || !isFinite(timestamp)) return '-';
    return new Date(timestamp).toLocaleString('zh-CN', { hour12:false });
}

function labelModeStats(refs) {
    var count = 0;
    var timestamps = [];
    var elevations = [];
    var speeds = [];
    refs.forEach(function(ref) {
        for (var i = ref.segment.start; i <= ref.segment.end; i++) {
            count++;
            if (ref.data.timestamps && isFinite(ref.data.timestamps[i])) timestamps.push(ref.data.timestamps[i]);
            if (ref.data.elevations && ref.data.elevations[i] !== null && isFinite(ref.data.elevations[i])) elevations.push(ref.data.elevations[i]);
            if (ref.data.speeds && ref.data.speeds[i] !== null && isFinite(ref.data.speeds[i])) speeds.push(ref.data.speeds[i]);
        }
    });
    return {
        count: count,
        startTime: timestamps.length ? formatDateTime(Math.min.apply(null, timestamps)) : '-',
        endTime: timestamps.length ? formatDateTime(Math.max.apply(null, timestamps)) : '-',
        altitude: elevations.length ? { min: Math.min.apply(null, elevations), max: Math.max.apply(null, elevations) } : { min: null, max: null },
        speed: speeds.length ? { min: Math.min.apply(null, speeds), max: Math.max.apply(null, speeds) } : { min: null, max: null },
        pathCount: refs.length
    };
}

function updateLabelModeInfoCards(stats) {
    document.getElementById('pointCount').textContent = stats.count + ' 个点';
    document.getElementById('timeRange').textContent = stats.startTime + ' - ' + stats.endTime;
    document.getElementById('altitudeRange').textContent =
        stats.altitude.min === null || stats.altitude.max === null ? '-' : formatAltitude(stats.altitude.min) + ' - ' + formatAltitude(stats.altitude.max);
    document.getElementById('speedRange').textContent =
        stats.speed.min === null || stats.speed.max === null ? '-' : formatSpeed(stats.speed.min) + ' - ' + formatSpeed(stats.speed.max);
    document.getElementById('segmentCount').textContent = stats.pathCount + ' 条';
}

function drawMetricForLabelRef(ref, correctedPoints, metricStats) {
    if (!activeMetric) return;
    var metric = metricValues(ref.data, activeMetric);
    var statsRange = activeMetric === 'speed' ? metricStats.speed : metricStats.altitude;
    if (!metric.values || statsRange.min === null || statsRange.max === null) return;

    var stepsPerSegment = 8;
    for (var i = ref.segment.start; i < ref.segment.end; i++) {
        var startValue = metric.values[i];
        var endValue = metric.values[i + 1];
        if (startValue === null || startValue === undefined || !isFinite(startValue)) continue;
        if (endValue === null || endValue === undefined || !isFinite(endValue)) continue;
        var startPoint = correctedPoints[i];
        var endPoint = correctedPoints[i + 1];
        for (var step = 0; step < stepsPerSegment; step++) {
            var t1 = step / stepsPerSegment;
            var t2 = (step + 1) / stepsPerSegment;
            var midT = (t1 + t2) / 2;
            var segmentValue = startValue + (endValue - startValue) * midT;
            var color = colorForMetric(segmentValue, statsRange.min, statsRange.max);
            var segmentStart = [
                startPoint[0] + (endPoint[0] - startPoint[0]) * t1,
                startPoint[1] + (endPoint[1] - startPoint[1]) * t1
            ];
            var segmentEnd = [
                startPoint[0] + (endPoint[0] - startPoint[0]) * t2,
                startPoint[1] + (endPoint[1] - startPoint[1]) * t2
            ];
            L.polyline([segmentStart, segmentEnd], {
                color: color,
                weight: 7,
                opacity: 0.95,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(metricLayer)
              .bindPopup('<b>' + metricLabel(activeMetric) + '</b><br>' + ref.date + ' 路径 ' + (ref.segmentIndex + 1) + '<br>起点: ' + formatMetric(activeMetric, startValue) + '<br>终点: ' + formatMetric(activeMetric, endValue));
        }
    }
}

function renderLabelMode() {
    setDateControlsDisabled(true);
    if (currentLayer) {
        map.removeLayer(currentLayer);
        currentLayer = null;
    }
    clearMetricLayer();
    clearDataPointLayer();

    var refs = matchingLabelRefs();
    var stats = labelModeStats(refs);
    updateLabelModeInfoCards(stats);
    updateMetricUiForStats(stats);

    currentLayer = L.layerGroup().addTo(map);
    metricLayer = L.layerGroup().addTo(map);
    var boundsPoints = [];
    refs.forEach(function(ref) {
        var correctedPoints = correctTrackPoints(ref.data.points);
        var segmentPoints = correctedPoints.slice(ref.segment.start, ref.segment.end + 1);
        boundsPoints = boundsPoints.concat(segmentPoints);
        L.polyline(segmentPoints, {
            color: '#3388ff',
            weight: 5,
            opacity: activeMetric ? 0.3 : 0.85,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(currentLayer).bindPopup(ref.date + ' 路径 ' + (ref.segmentIndex + 1));

        var startPoint = correctedPoints[ref.segment.start];
        var endPoint = correctedPoints[ref.segment.end];
        var startTime = ref.data.times && ref.data.times[ref.segment.start] ? ref.data.times[ref.segment.start] : '';
        var endTime = ref.data.times && ref.data.times[ref.segment.end] ? ref.data.times[ref.segment.end] : '';
        L.marker(startPoint, { title:'起点' }).addTo(currentLayer)
            .bindPopup('<b>🟢 起点</b><br>' + ref.date + ' 路径 ' + (ref.segmentIndex + 1) + '<br>时间: ' + startTime + '<br>坐标: ' + startPoint[0].toFixed(6) + ', ' + startPoint[1].toFixed(6));
        if (ref.segment.end !== ref.segment.start) {
            L.marker(endPoint, { title:'终点' }).addTo(currentLayer)
                .bindPopup('<b>🔴 终点</b><br>' + ref.date + ' 路径 ' + (ref.segmentIndex + 1) + '<br>时间: ' + endTime + '<br>坐标: ' + endPoint[0].toFixed(6) + ', ' + endPoint[1].toFixed(6));
        }
        if (showDataPoints) {
            if (!dataPointLayer) dataPointLayer = L.layerGroup().addTo(map);
            drawDataPointsForSegment(dataPointLayer, correctedPoints, ref.segment.start, ref.segment.end, 0.85, ref.date + ' 路径 ' + (ref.segmentIndex + 1), ref.data);
        }
        drawMetricForLabelRef(ref, correctedPoints, stats);
    });

    if (boundsPoints.length > 0) {
        map.fitBounds(L.latLngBounds(boundsPoints), { padding:[50, 50] });
    }
}

function updateMetricUi(data) {
    var altitudeButton = document.getElementById('altitudeToggle');
    var speedButton = document.getElementById('speedToggle');
    var legend = document.getElementById('metricLegend');
    altitudeButton.textContent = activeMetric === 'altitude' ? '海拔路径：开启' : '海拔路径：关闭';
    speedButton.textContent = activeMetric === 'speed' ? '速度路径：开启' : '速度路径：关闭';
    altitudeButton.classList.toggle('active', activeMetric === 'altitude');
    speedButton.classList.toggle('active', activeMetric === 'speed');
    legend.classList.toggle('active', activeMetric !== null);

    updateInfoCards(data);

    if (activeMetric) {
        var stats = currentSelectionStats(data);
        var metric = activeMetric === 'speed' ? stats.speed : stats.altitude;
        document.getElementById('metricLegendTitle').textContent = metricLabel(activeMetric);
        document.getElementById('metricMinLabel').textContent = metric.min === null ? '低' : formatMetric(activeMetric, metric.min);
        document.getElementById('metricMaxLabel').textContent = metric.max === null ? '高' : formatMetric(activeMetric, metric.max);
    } else {
        document.getElementById('metricLegendTitle').textContent = '可视化路径';
        document.getElementById('metricMinLabel').textContent = '低';
        document.getElementById('metricMaxLabel').textContent = '高';
    }
}

function updateMetricUiForStats(stats) {
    var altitudeButton = document.getElementById('altitudeToggle');
    var speedButton = document.getElementById('speedToggle');
    var legend = document.getElementById('metricLegend');
    altitudeButton.textContent = activeMetric === 'altitude' ? '海拔路径：开启' : '海拔路径：关闭';
    speedButton.textContent = activeMetric === 'speed' ? '速度路径：开启' : '速度路径：关闭';
    altitudeButton.classList.toggle('active', activeMetric === 'altitude');
    speedButton.classList.toggle('active', activeMetric === 'speed');
    legend.classList.toggle('active', activeMetric !== null);

    if (activeMetric) {
        var metric = activeMetric === 'speed' ? stats.speed : stats.altitude;
        document.getElementById('metricLegendTitle').textContent = metricLabel(activeMetric);
        document.getElementById('metricMinLabel').textContent = metric.min === null ? '低' : formatMetric(activeMetric, metric.min);
        document.getElementById('metricMaxLabel').textContent = metric.max === null ? '高' : formatMetric(activeMetric, metric.max);
    } else {
        document.getElementById('metricLegendTitle').textContent = '可视化路径';
        document.getElementById('metricMinLabel').textContent = '低';
        document.getElementById('metricMaxLabel').textContent = '高';
    }
}

function toggleAltitudeMode() {
    activeMetric = activeMetric === 'altitude' ? null : 'altitude';
    applyMetricMode();
}

function toggleSpeedMode() {
    activeMetric = activeMetric === 'speed' ? null : 'speed';
    applyMetricMode();
}

function applyMetricMode() {
    if (isLabelMode()) {
        renderLabelMode();
        return;
    }
    if (!allData || !currentDate) return;
    var data = allData[currentDate];
    updateMetricUi(data);
    if (!activeMetric) {
        clearMetricLayer();
        return;
    }
    drawMetricLayer(data, correctTrackPoints(data.points));
}

function redrawCurrentTrack() {
    if (!allData || !currentDate) return;
    var data = allData[currentDate];
    if (currentLayer) {
        map.removeLayer(currentLayer);
        currentLayer = null;
    }
    clearMetricLayer();
    clearDataPointLayer();
    populateSegmentButtons(data);
    drawBaseTrack(data, currentCorrectedPoints);
    drawEndpointMarkers(data, currentCorrectedPoints);
    drawMetricLayer(data, currentCorrectedPoints);
    drawDataPoints(data, currentCorrectedPoints);
}

function toggleSegment(segmentIndex) {
    if (segmentIndex === 'all') {
        selectedSegments = 'all';
        redrawCurrentTrack();
        return;
    }

    if (selectedSegments === 'all') {
        selectedSegments = [segmentIndex];
    } else {
        var existingIndex = selectedSegments.indexOf(segmentIndex);
        if (existingIndex === -1) {
            selectedSegments.push(segmentIndex);
            selectedSegments.sort(function(a, b) { return a - b; });
        } else {
            selectedSegments.splice(existingIndex, 1);
            if (selectedSegments.length === 0) {
                selectedSegments = 'all';
            }
        }
    }
    redrawCurrentTrack();
}

function drawEndpointMarkers(data, points) {
    if (!currentLayer || !points || points.length === 0) return;
    var markerSegments = selectedSegments === 'all'
        ? [{ start: 0, end: points.length - 1, label: '全部路径' }]
        : selectedSegments.map(function(segmentIndex) {
            var segment = currentSegments[segmentIndex];
            return segment ? { start: segment.start, end: segment.end, label: '路径 ' + (segmentIndex + 1) } : null;
        }).filter(Boolean);

    markerSegments.forEach(function(segment) {
        var startPoint = points[segment.start];
        var endPoint = points[segment.end];
        var startTime = data.times && data.times[segment.start] ? data.times[segment.start] : data.start_time;
        var endTime = data.times && data.times[segment.end] ? data.times[segment.end] : data.end_time;

        L.marker(startPoint, { title:'起点' }).addTo(currentLayer)
            .bindPopup('<b>🟢 起点</b><br>' + segment.label + '<br>时间: ' + startTime + '<br>坐标: ' + startPoint[0].toFixed(6) + ', ' + startPoint[1].toFixed(6));
        if (segment.end !== segment.start) {
            L.marker(endPoint, { title:'终点' }).addTo(currentLayer)
                .bindPopup('<b>🔴 终点</b><br>' + segment.label + '<br>时间: ' + endTime + '<br>坐标: ' + endPoint[0].toFixed(6) + ', ' + endPoint[1].toFixed(6));
        }
    });
}

function loadTrack(date) {
    if (!allData) return;
    
    currentDate = date;
    selectedSegments = 'all';
    if (currentLayer) { map.removeLayer(currentLayer); }
    clearMetricLayer();
    clearDataPointLayer();
    var data = allData[date];
    if (!data || data.points.length === 0) { alert('该日期没有轨迹数据！'); return; }
    var points = correctTrackPoints(data.points);
    currentCorrectedPoints = points;
    currentSegments = buildSegments(data);
    populateSegmentButtons(data);
    drawBaseTrack(data, points);
    drawEndpointMarkers(data, points);
    drawDataPoints(data, points);
    map.fitBounds(L.latLngBounds(points), { padding:[50, 50] });
    updateMetricUi(data);
    drawMetricLayer(data, points);
}

function changeDate() {
    var date = document.getElementById('dateSelect').value;
    loadTrack(date);
}

// 加载JSON数据
Promise.all([
    fetch('all_dates_points.json').then(response => response.json()),
    fetch('path_labels.json').then(response => response.ok ? response.json() : {}).catch(() => ({}))
])
    .then(([data, labels]) => {
        allData = data;
        pathLabels = labels || {};
        populateLabelButtons();
        loadTrack(document.getElementById('dateSelect').value);
    })
    .catch(error => {
        console.error('Error loading JSON:', error);
        alert('加载数据失败，请确保all_dates_points.json文件存在！');
    });

L.control.scale({ imperial:false }).addTo(map);
    </script>
</body>
</html>'''

# 写入HTML文件
with open(HTML_FILE, 'w', encoding='utf-8') as f:
    f.write(html_template)

print(f"完成！生成了 {len(all_data)} 个日期的数据")
print(f"总记录数: {sum(d['count'] for d in all_data.values())}")
print(f"最新日期: {latest_date} (默认选中)")
print(f"文件已保存: {HTML_FILE}")
print(f"数据文件: {JSON_FILE}")
