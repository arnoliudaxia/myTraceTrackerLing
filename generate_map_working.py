import json
import pandas as pd
import datetime
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
    points = []
    times = []
    for _, row in group.iterrows():
        lat = float(row['latitude'])
        lng = float(row['longitude'])
        points.append([lat, lng])
        
        # 转换时间戳为可读时间
        timestamp = int(row['geoTime'])
        dt = datetime.datetime.fromtimestamp(timestamp / 1000, datetime.timezone.utc).astimezone(LOCAL_TIMEZONE)
        times.append(dt.strftime('%H:%M:%S'))
    
    all_data[date] = {
        'count': len(points),
        'points': points,
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
        </div>
    </div>
    <div class="legend">
        <div style="font-weight:bold; margin-bottom:8px;">图例</div>
        <div class="legend-item"><span class="legend-color" style="background:#3388ff;"></span>移动轨迹</div>
        <div class="legend-item"><span class="legend-dot" style="background:#00cc00;"></span>起点</div>
        <div class="legend-item"><span class="legend-dot" style="background:#ff3333;"></span>终点</div>
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
var currentDate = null;

function changeTile() {
    var tileType = document.getElementById('tileSelect').value;
    map.removeLayer(currentTileLayer);
    currentTileLayer = tileLayers[tileType].addTo(map);
}

function loadTrack(date) {
    if (!allData) return;
    
    currentDate = date;
    if (currentLayer) { map.removeLayer(currentLayer); }
    var data = allData[date];
    if (!data || data.points.length === 0) { alert('该日期没有轨迹数据！'); return; }
    var points = correctTrackPoints(data.points);
    currentLayer = L.layerGroup().addTo(map);
    var polyline = L.polyline(points, { color:'#3388ff', weight:5, opacity:0.8 }).addTo(currentLayer);
    if (points.length > 0) {
        L.marker(points[0], { title:'起点' }).addTo(currentLayer)
            .bindPopup('<b>🟢 起点</b><br>时间: ' + data.start_time + '<br>坐标: ' + points[0][0].toFixed(6) + ', ' + points[0][1].toFixed(6));
    }
    if (points.length > 1) {
        L.marker(points[points.length-1], { title:'终点' }).addTo(currentLayer)
            .bindPopup('<b>🔴 终点</b><br>时间: ' + data.end_time + '<br>坐标: ' + points[points.length-1][0].toFixed(6) + ', ' + points[points.length-1][1].toFixed(6));
    }
    map.fitBounds(polyline.getBounds(), { padding:[50, 50] });
    document.getElementById('pointCount').textContent = data.count + ' 个点';
    document.getElementById('timeRange').textContent = data.start_time + ' - ' + data.end_time;
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
