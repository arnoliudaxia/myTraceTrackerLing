import json
import pandas as pd
import datetime
import math
from pathlib import Path
from zoneinfo import ZoneInfo

BASE_DIR = Path(__file__).resolve().parent
CSV_FILE = BASE_DIR / '灵敢足迹(2020.06.25-2026.05.01).csv'
JSON_FILE = BASE_DIR / 'all_dates_points.json'
HTML_FILE = BASE_DIR / '灵敢足迹_轨迹可视化.html'
LOCAL_TIMEZONE = ZoneInfo('Asia/Shanghai')


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


# 读取当前CSV。filter_csv_days.py 会直接清洗并覆盖这个文件。
df = pd.read_csv(CSV_FILE)
df = ensure_date_column(df)

# 确保geoTime是字符串类型
df['geoTime'] = df['geoTime'].astype(str)

# 按日期分组
groups = df.groupby('date')

# 准备数据
all_data = {}
for date, group in groups:
    group = group.copy()
    group['geoTimeNumber'] = pd.to_numeric(group['geoTime'], errors='coerce')
    group = group.sort_values('geoTimeNumber')
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
        'start_time': min(times),
        'end_time': max(times)
    }

# 保存JSON数据到单独的文件
with open(JSON_FILE, 'w', encoding='utf-8') as f:
    json.dump(all_data, f, ensure_ascii=False, indent=2)

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
        .segment-selector select { width:100%; padding:5px; border:1px solid #ddd; border-radius:4px; font-size:12px; }
        .mode-button { width:100%; margin-top:10px; padding:8px; border:1px solid #ccd6e0; border-radius:4px; background:#f8fbff; color:#2c5c86; font-size:13px; font-family:"Microsoft YaHei",Arial,sans-serif; cursor:pointer; }
        .mode-button.active { background:#2c5c86; border-color:#2c5c86; color:white; }
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
        <div class="date-selector">
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
        <div class="segment-selector">
            <label>🧭 路径段:</label>
            <select id="segmentSelect" onchange="changeSegment()">
                <option value="all">全部路径</option>
            </select>
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
var map = L.map('map').setView([31.23, 121.47], 12);
var currentTileLayer = tileLayers.osm.addTo(map);
var currentLayer = null;
var metricLayer = null;
var currentDate = null;
var activeMetric = null;
var currentCorrectedPoints = [];
var currentSegments = [];
var selectedSegment = 'all';
var segmentGapThresholdMs = 60 * 60 * 1000;

function changeTile() {
    var tileType = document.getElementById('tileSelect').value;
    map.removeLayer(currentTileLayer);
    currentTileLayer = tileLayers[tileType].addTo(map);
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
    return selectedSegment === 'all' || Number(selectedSegment) === segmentIndex ? 0.85 : 0.3;
}

function segmentLabel(data, segment, index) {
    var startTime = data.times && data.times[segment.start] ? data.times[segment.start] : '';
    var endTime = data.times && data.times[segment.end] ? data.times[segment.end] : '';
    var count = segment.end - segment.start + 1;
    return '路径 ' + (index + 1) + ' (' + count + '点, ' + startTime + '-' + endTime + ')';
}

function populateSegmentSelector(data) {
    var selector = document.getElementById('segmentSelect');
    selector.innerHTML = '<option value="all">全部路径</option>';
    currentSegments.forEach(function(segment, index) {
        var option = document.createElement('option');
        option.value = String(index);
        option.textContent = segmentLabel(data, segment, index);
        selector.appendChild(option);
    });
    if (selectedSegment !== 'all' && Number(selectedSegment) >= currentSegments.length) {
        selectedSegment = 'all';
    }
    selector.value = selectedSegment;
    document.getElementById('segmentCount').textContent = currentSegments.length + ' 段';
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
                    opacity: selectedSegment === 'all' || Number(selectedSegment) === trackSegmentIndex ? 0.95 : 0.3,
                    lineCap: 'round',
                    lineJoin: 'round'
                }).addTo(metricLayer)
                  .bindPopup('<b>' + metricLabel(activeMetric) + '</b><br>起点: ' + formatMetric(activeMetric, startValue) + '<br>终点: ' + formatMetric(activeMetric, endValue));
            }
        }
    });
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

    var minAltitude = data ? data.altitude_min : null;
    var maxAltitude = data ? data.altitude_max : null;
    var minSpeed = data ? data.speed_min : null;
    var maxSpeed = data ? data.speed_max : null;
    document.getElementById('altitudeRange').textContent =
        minAltitude === null || maxAltitude === null ? '-' : formatAltitude(minAltitude) + ' - ' + formatAltitude(maxAltitude);
    document.getElementById('speedRange').textContent =
        minSpeed === null || maxSpeed === null ? '-' : formatSpeed(minSpeed) + ' - ' + formatSpeed(maxSpeed);

    if (activeMetric) {
        var metric = metricValues(data, activeMetric);
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
    drawBaseTrack(data, currentCorrectedPoints);
    drawEndpointMarkers(data, currentCorrectedPoints);
    drawMetricLayer(data, currentCorrectedPoints);
}

function changeSegment() {
    selectedSegment = document.getElementById('segmentSelect').value;
    redrawCurrentTrack();
}

function drawEndpointMarkers(data, points) {
    if (!currentLayer || !points || points.length === 0) return;
    var startIndex = 0;
    var endIndex = points.length - 1;
    var label = '全部路径';
    if (selectedSegment !== 'all') {
        var segmentIndex = Number(selectedSegment);
        var segment = currentSegments[segmentIndex];
        if (segment) {
            startIndex = segment.start;
            endIndex = segment.end;
            label = '路径 ' + (segmentIndex + 1);
        }
    }

    var startPoint = points[startIndex];
    var endPoint = points[endIndex];
    var startTime = data.times && data.times[startIndex] ? data.times[startIndex] : data.start_time;
    var endTime = data.times && data.times[endIndex] ? data.times[endIndex] : data.end_time;

    L.marker(startPoint, { title:'起点' }).addTo(currentLayer)
        .bindPopup('<b>🟢 起点</b><br>' + label + '<br>时间: ' + startTime + '<br>坐标: ' + startPoint[0].toFixed(6) + ', ' + startPoint[1].toFixed(6));
    if (endIndex !== startIndex) {
        L.marker(endPoint, { title:'终点' }).addTo(currentLayer)
            .bindPopup('<b>🔴 终点</b><br>' + label + '<br>时间: ' + endTime + '<br>坐标: ' + endPoint[0].toFixed(6) + ', ' + endPoint[1].toFixed(6));
    }
}

function loadTrack(date) {
    if (!allData) return;
    
    currentDate = date;
    selectedSegment = 'all';
    if (currentLayer) { map.removeLayer(currentLayer); }
    clearMetricLayer();
    var data = allData[date];
    if (!data || data.points.length === 0) { alert('该日期没有轨迹数据！'); return; }
    var points = correctTrackPoints(data.points);
    currentCorrectedPoints = points;
    currentSegments = buildSegments(data);
    populateSegmentSelector(data);
    drawBaseTrack(data, points);
    drawEndpointMarkers(data, points);
    map.fitBounds(L.latLngBounds(points), { padding:[50, 50] });
    document.getElementById('pointCount').textContent = data.count + ' 个点';
    document.getElementById('timeRange').textContent = data.start_time + ' - ' + data.end_time;
    updateMetricUi(data);
    drawMetricLayer(data, points);
}

function changeDate() {
    var date = document.getElementById('dateSelect').value;
    loadTrack(date);
}

// 加载JSON数据
fetch('all_dates_points.json')
    .then(response => response.json())
    .then(data => {
        allData = data;
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
