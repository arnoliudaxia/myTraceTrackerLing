function tiandituTile(serviceName, layerName) {
    return L.tileLayer(
        '/api/tianditu/t{s}/' + serviceName + '/wmts?' +
        'SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
        '&LAYER=' + layerName +
        '&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles' +
        '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
        {
            subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
            maxZoom: 18,
            attribution: '© 天地图'
        }
    );
}

var tileLayers = {
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri',
        maxZoom: 19
    }),
    tiandituSatellite: L.layerGroup([
        tiandituTile('img_w', 'img'),
        tiandituTile('cia_w', 'cia')
    ])
};

function outOfChina(lat,lng){if(lng<72.004||lng>137.8347)return true;if(lat<0.8293||lat>55.8271)return true;return false;}
function transformLat(x,y){var ret=-100.0+2.0*x+3.0*y+0.2*y*y+0.1*x*y+0.2*Math.sqrt(Math.abs(x));ret+=(20.0*Math.sin(6.0*x*Math.PI)+20.0*Math.sin(2.0*x*Math.PI))*2.0/3.0;ret+=(20.0*Math.sin(y*Math.PI)+40.0*Math.sin(y/3.0*Math.PI))*2.0/3.0;ret+=(160.0*Math.sin(y/12.0*Math.PI)+320.0*Math.sin(y*Math.PI/30.0))*2.0/3.0;return ret;}
function transformLng(x,y){var ret=300.0+x+2.0*y+0.1*x*x+0.1*x*y+0.1*Math.sqrt(Math.abs(x));ret+=(20.0*Math.sin(6.0*x*Math.PI)+20.0*Math.sin(2.0*x*Math.PI))*2.0/3.0;ret+=(20.0*Math.sin(x*Math.PI)+40.0*Math.sin(x/3.0*Math.PI))*2.0/3.0;ret+=(150.0*Math.sin(x/12.0*Math.PI)+300.0*Math.sin(x/30.0*Math.PI))*2.0/3.0;return ret;}
function correctCoord(lat,lng){if(outOfChina(lat,lng))return[lat,lng];var a=6378245.0,ee=0.00669342162296594323;var dLat=transformLat(lng-105.0,lat-35.0);var dLng=transformLng(lng-105.0,lat-35.0);var radLat=lat/180.0*Math.PI;var magic=Math.sin(radLat);magic=1-ee*magic*magic;var sqrtMagic=Math.sqrt(magic);dLat=(dLat*180.0)/((a*(1-ee))/(magic*sqrtMagic)*Math.PI);dLng=(dLng*180.0)/(a/sqrtMagic*Math.cos(radLat)*Math.PI);return[lat-dLat,lng-dLng];}
function correctTrackPoints(points){return points.map(function(p){return correctCoord(p[0],p[1]);});}

var allData = null;
var pathLabels = {};
var pathFavorites = {};
var selectedLabels = [];
var map = L.map('map').setView([31.23, 121.47], 12);
var currentTileLayer = tileLayers.osm.addTo(map);
var currentLayer = null;
var metricLayer = null;
var dataPointLayer = null;
var currentDate = null;
var activeMetric = null;
var showDataPoints = false;
var dimmedSegmentOpacity = 0.3;
var currentCorrectedPoints = [];
var currentSegments = [];
var selectedSegments = 'all';
var segmentGapThresholdMs = 60 * 60 * 1000;
var pathLabelsSaveTimer = null;
var pathFavoritesSaveTimer = null;
var availableDates = [];
var availableDateSet = new Set();
var calendarViewYear = null;
var calendarViewMonth = null;
var mapRefreshTimer = null;

function changeTile() {
    var tileType = document.getElementById('tileSelect').value;
    if (!tileLayers[tileType]) tileType = 'osm';
    map.removeLayer(currentTileLayer);
    currentTileLayer = tileLayers[tileType].addTo(map);
    scheduleMapRefresh();
}

function redrawLeafletLayer(layer) {
    if (!layer || !layer.eachLayer) return;
    layer.eachLayer(function(item) {
        if (item.redraw) item.redraw();
    });
}

function scheduleMapRefresh() {
    if (mapRefreshTimer) cancelAnimationFrame(mapRefreshTimer);
    mapRefreshTimer = requestAnimationFrame(function() {
        mapRefreshTimer = null;
        map.invalidateSize({ pan: false });
        redrawLeafletLayer(currentLayer);
        redrawLeafletLayer(metricLayer);
        redrawLeafletLayer(dataPointLayer);
    });
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

    populateQuickLabelButtons();
}

function populateQuickLabelButtons() {
    var grid = document.getElementById('quickLabelGrid');
    if (!grid) return;
    grid.innerHTML = '';

    var labels = uniqueLabels();
    if (labels.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'quick-label-empty';
        empty.textContent = '暂无已有标签';
        grid.appendChild(empty);
        return;
    }

    labels.forEach(function(label) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'quick-label-button';
        button.textContent = label;
        button.title = '应用标签：' + label;
        button.onclick = function() { applyExistingLabel(label); };
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
    var selector = document.getElementById('dateSelect');
    if (selector) selector.disabled = disabled;
    document.getElementById('labelModeHint').classList.toggle('active', disabled);
}

function selectedSegmentIndexesForLabeling() {
    if (selectedSegments === 'all') {
        return currentSegments.map(function(_, index) { return index; });
    }
    return selectedSegments.slice();
}

function applyLabelToSegments(label) {
    var changed = false;
    selectedSegmentIndexesForLabeling().forEach(function(segmentIndex) {
        var key = pathLabelKey(currentDate, segmentIndex);
        if (pathLabels[key] !== label) {
            pathLabels[key] = label;
            changed = true;
        }
    });
    return changed;
}

function applyLabelToSelectedSegments() {
    if (isLabelMode()) {
        return;
    }
    if (!currentDate || currentSegments.length === 0) return;
    var label = document.getElementById('labelInput').value.trim();
    if (!label) {
        document.getElementById('labelInput').focus();
        return;
    }
    var changed = applyLabelToSegments(label);
    document.getElementById('labelInput').value = '';
    populateLabelButtons();
    populateSegmentButtons(allData[currentDate]);
    renderFavorites();
    if (changed) schedulePathLabelsSave();
}

function applyExistingLabel(label) {
    if (isLabelMode()) {
        return;
    }
    if (!currentDate || currentSegments.length === 0) return;
    var changed = applyLabelToSegments(label);
    populateLabelButtons();
    populateSegmentButtons(allData[currentDate]);
    renderFavorites();
    if (changed) schedulePathLabelsSave();
}

function schedulePathLabelsSave() {
    if (pathLabelsSaveTimer) clearTimeout(pathLabelsSaveTimer);
    pathLabelsSaveTimer = setTimeout(function() {
        pathLabelsSaveTimer = null;
        persistPathLabels({ allowFallback: false });
    }, 300);
}

async function persistPathLabels(options) {
    var allowFallback = options && options.allowFallback;
    var content = JSON.stringify(pathLabels, null, 2);
    try {
        var response = await fetch('/api/path-labels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: content
        });
        if (response.ok) {
            return true;
        }
    } catch (error) {
        // Fall back to browser-side save below when the Node API is unavailable.
    }

    if (!allowFallback) {
        console.warn('Unable to auto-save path_labels.json. Please make sure the Node server is running.');
        return false;
    }

    if (window.showSaveFilePicker) {
        try {
            var handle = await window.showSaveFilePicker({
                suggestedName: 'path_labels.json',
                types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
            });
            var writable = await handle.createWritable();
            await writable.write(content);
            await writable.close();
            return true;
        } catch (error) {
            if (error && error.name === 'AbortError') return false;
        }
    }
    var blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'path_labels.json';
    link.click();
    URL.revokeObjectURL(url);
    return true;
}

async function savePathLabels() {
    return persistPathLabels({ allowFallback: true });
}

function normalizeFavorite(entry) {
    if (!entry) return { note: '', createdAt: '' };
    if (typeof entry === 'string') return { note: entry, createdAt: '' };
    return {
        note: String(entry.note || ''),
        createdAt: String(entry.createdAt || '')
    };
}

function favoriteTitle(date, segmentIndex) {
    var data = allData ? allData[date] : null;
    var label = pathLabels[pathLabelKey(date, segmentIndex)];
    if (!data) return date + ' 路径 ' + (segmentIndex + 1);
    var segment = buildSegments(data)[segmentIndex];
    var base = date + ' 路径 ' + (segmentIndex + 1);
    return label ? base + ' · ' + label : base;
}

function favoriteMeta(date, segmentIndex) {
    var data = allData ? allData[date] : null;
    if (!data) return '';
    var segment = buildSegments(data)[segmentIndex];
    if (!segment) return '';
    var count = segment.end - segment.start + 1;
    var startTime = data.times && data.times[segment.start] ? data.times[segment.start] : '';
    var endTime = data.times && data.times[segment.end] ? data.times[segment.end] : '';
    return count + ' 个点 · ' + startTime + ' - ' + endTime;
}

function favoriteKeys() {
    return Object.keys(pathFavorites).sort(function(a, b) {
        var favA = normalizeFavorite(pathFavorites[a]);
        var favB = normalizeFavorite(pathFavorites[b]);
        return (favB.createdAt || b).localeCompare(favA.createdAt || a);
    });
}

function renderFavorites() {
    var list = document.getElementById('favoriteList');
    if (!list) return;
    list.innerHTML = '';

    var keys = favoriteKeys();
    if (keys.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'favorite-empty';
        empty.textContent = '暂无收藏路径';
        list.appendChild(empty);
        return;
    }

    keys.forEach(function(key) {
        var parts = key.split('#');
        var date = parts[0];
        var segmentIndex = parseInt(parts[1], 10);
        var favorite = normalizeFavorite(pathFavorites[key]);

        var item = document.createElement('div');
        item.className = 'favorite-item';

        var openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'favorite-open';
        openButton.onclick = function() { openFavoritePath(key); };

        var title = document.createElement('div');
        title.className = 'favorite-title';
        title.textContent = favoriteTitle(date, segmentIndex);
        openButton.appendChild(title);

        var note = document.createElement('div');
        note.className = 'favorite-note';
        note.textContent = favorite.note || '无备注';
        openButton.appendChild(note);

        var meta = document.createElement('div');
        meta.className = 'favorite-meta';
        meta.textContent = favoriteMeta(date, segmentIndex);
        openButton.appendChild(meta);

        var deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'favorite-delete';
        deleteButton.title = '取消收藏';
        deleteButton.textContent = '×';
        deleteButton.onclick = function(event) {
            event.stopPropagation();
            delete pathFavorites[key];
            renderFavorites();
            if (currentDate === date) populateSegmentButtons(allData[currentDate]);
            persistPathFavorites({ showStatus: true });
        };

        item.appendChild(openButton);
        item.appendChild(deleteButton);
        list.appendChild(item);
    });
}

function setFavoriteSaveStatus(message, type) {
    var status = document.getElementById('favoriteSaveStatus');
    if (!status) return;
    status.textContent = message || '';
    status.className = 'favorite-save-status' + (type ? ' ' + type : '');
}

async function favoriteSelectedSegments() {
    if (isLabelMode() || !currentDate || currentSegments.length === 0) return;

    var noteInput = document.getElementById('favoriteNoteInput');
    var note = noteInput ? noteInput.value.trim() : '';
    var createdAt = new Date().toISOString();
    var changed = false;

    selectedSegmentIndices().forEach(function(segmentIndex) {
        var key = pathLabelKey(currentDate, segmentIndex);
        var previous = normalizeFavorite(pathFavorites[key]);
        if (previous.note !== note || !pathFavorites[key]) {
            pathFavorites[key] = {
                note: note,
                createdAt: previous.createdAt || createdAt
            };
            changed = true;
        }
    });

    if (noteInput) noteInput.value = '';
    renderFavorites();
    populateSegmentButtons(allData[currentDate]);
    if (changed) {
        await persistPathFavorites({ showStatus: true });
    }
}

function openFavoritePath(key) {
    var parts = key.split('#');
    var date = parts[0];
    var segmentIndex = parseInt(parts[1], 10);
    if (!allData || !allData[date] || !isFinite(segmentIndex)) return;

    selectedLabels = [];
    populateLabelButtons();
    setDateControlsDisabled(false);

    var parsed = parseDateKey(date);
    calendarViewYear = parsed.getFullYear();
    calendarViewMonth = parsed.getMonth();
    loadTrack(date);

    if (!currentSegments[segmentIndex]) return;
    selectedSegments = [segmentIndex];
    redrawCurrentTrack();

    var segment = currentSegments[segmentIndex];
    var segmentPoints = currentCorrectedPoints.slice(segment.start, segment.end + 1);
    if (segmentPoints.length > 0) {
        map.fitBounds(L.latLngBounds(segmentPoints), { padding:[60, 60] });
    }
    scheduleMapRefresh();
}

function schedulePathFavoritesSave() {
    if (pathFavoritesSaveTimer) clearTimeout(pathFavoritesSaveTimer);
    pathFavoritesSaveTimer = setTimeout(function() {
        pathFavoritesSaveTimer = null;
        persistPathFavorites({ showStatus: false });
    }, 300);
}

async function persistPathFavorites(options) {
    var showStatus = options && options.showStatus;
    try {
        var response = await fetch('/api/path-favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pathFavorites, null, 2)
        });
        if (response.ok) {
            if (showStatus) setFavoriteSaveStatus('收藏已保存', 'saved');
            return true;
        }
        if (showStatus) setFavoriteSaveStatus('收藏保存失败：请重启 Node 服务后重试', 'error');
        console.warn('Unable to save path_favorites.json. HTTP status:', response.status);
        return false;
    } catch (error) {
        if (showStatus) setFavoriteSaveStatus('收藏保存失败：请确认正在通过 npm start 打开页面', 'error');
        console.warn('Unable to auto-save path_favorites.json. Please make sure the Node server is running.');
        return false;
    }
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

function parseDateKey(dateKey) {
    var parts = String(dateKey).split('-').map(function(value) { return parseInt(value, 10); });
    return new Date(parts[0], parts[1] - 1, parts[2]);
}

function formatDateKey(year, month, day) {
    return [
        String(year),
        String(month + 1).padStart(2, '0'),
        String(day).padStart(2, '0')
    ].join('-');
}

function updateHiddenDateSelect(date) {
    var selector = document.getElementById('dateSelect');
    if (selector) selector.value = date;
}

function renderDateCalendar() {
    var grid = document.getElementById('calendarGrid');
    var title = document.getElementById('calendarTitle');
    if (!grid || !title || calendarViewYear === null || calendarViewMonth === null) return;

    grid.innerHTML = '';
    title.textContent = calendarViewYear + '年' + String(calendarViewMonth + 1).padStart(2, '0') + '月';

    var firstDay = new Date(calendarViewYear, calendarViewMonth, 1);
    var daysInMonth = new Date(calendarViewYear, calendarViewMonth + 1, 0).getDate();
    var leadingDays = (firstDay.getDay() + 6) % 7;
    var totalCells = Math.ceil((leadingDays + daysInMonth) / 7) * 7;
    var startDate = new Date(calendarViewYear, calendarViewMonth, 1 - leadingDays);

    for (var i = 0; i < totalCells; i++) {
        var cellDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
        var dateKey = formatDateKey(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate());
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'calendar-day';
        button.textContent = cellDate.getDate();
        if (cellDate.getMonth() !== calendarViewMonth) button.className += ' outside';
        if (availableDateSet.has(dateKey)) {
            button.className += ' available';
            button.title = dateKey + ' · ' + allData[dateKey].count + ' 个点';
            button.onclick = function(selectedDate) {
                return function() { selectCalendarDate(selectedDate); };
            }(dateKey);
        } else {
            button.disabled = true;
        }
        if (dateKey === currentDate) button.className += ' active';
        grid.appendChild(button);
    }
}

function selectCalendarDate(date) {
    if (!availableDateSet.has(date) || isLabelMode()) return;
    var parsed = parseDateKey(date);
    calendarViewYear = parsed.getFullYear();
    calendarViewMonth = parsed.getMonth();
    updateHiddenDateSelect(date);
    loadTrack(date);
}

function changeCalendarMonth(offset) {
    if (calendarViewYear === null || calendarViewMonth === null) return;
    var next = new Date(calendarViewYear, calendarViewMonth + offset, 1);
    calendarViewYear = next.getFullYear();
    calendarViewMonth = next.getMonth();
    renderDateCalendar();
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
    return isSegmentSelected(segmentIndex) ? 0.85 : dimmedSegmentOpacity;
}

function metricSegmentOpacity(segmentIndex) {
    return isSegmentSelected(segmentIndex) ? 0.95 : dimmedSegmentOpacity;
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
        var key = pathLabelKey(currentDate, index);
        button.className = 'segment-button'
            + (isSegmentSelected(index) && selectedSegments !== 'all' ? ' active' : '')
            + (pathFavorites[key] ? ' favorited' : '');
        var label = pathLabels[key];
        var prefix = pathFavorites[key] ? '★ ' : '';
        button.textContent = prefix + (label ? String(index + 1) + ' ' + label : String(index + 1));
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
            opacity: activeMetric ? dimmedSegmentOpacity : 0.85,
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
    scheduleMapRefresh();
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
    scheduleMapRefresh();
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

function updateDimOpacityUi() {
    var range = document.getElementById('dimOpacityRange');
    var value = document.getElementById('dimOpacityValue');
    if (!range || !value) return;
    var percent = Math.round(dimmedSegmentOpacity * 100);
    range.value = String(percent);
    value.textContent = percent + '%';
}

function changeDimOpacity() {
    var range = document.getElementById('dimOpacityRange');
    if (!range) return;
    dimmedSegmentOpacity = Number(range.value) / 100;
    updateDimOpacityUi();
    if (isLabelMode()) {
        renderLabelMode();
    } else {
        redrawCurrentTrack();
    }
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
    updateHiddenDateSelect(date);
    selectedSegments = 'all';
    renderDateCalendar();
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
    scheduleMapRefresh();
}

function changeDate() {
    var date = document.getElementById('dateSelect').value;
    loadTrack(date);
}

function populateDateSelector(data) {
    var selector = document.getElementById('dateSelect');
    var dates = Object.keys(data).sort();
    var latestDate = dates[dates.length - 1];
    availableDates = dates;
    availableDateSet = new Set(dates);

    if (selector) {
        selector.innerHTML = '';
        dates.forEach(function(date) {
            var item = data[date];
            var option = document.createElement('option');
            option.value = date;
            option.textContent = date + ' (' + item.count + '个点, ' + item.start_time + '-' + item.end_time + ')';
            option.selected = date === latestDate;
            selector.appendChild(option);
        });
    }

    if (latestDate) {
        var latest = parseDateKey(latestDate);
        calendarViewYear = latest.getFullYear();
        calendarViewMonth = latest.getMonth();
        currentDate = latestDate;
        renderDateCalendar();
    }
}

// 加载JSON数据
Promise.all([
    fetch('all_dates_points.json').then(response => response.json()),
    fetch('path_labels.json').then(response => response.ok ? response.json() : {}).catch(() => ({})),
    fetch('path_favorites.json').then(response => response.ok ? response.json() : {}).catch(() => ({}))
])
    .then(([data, labels, favorites]) => {
        allData = data;
        pathLabels = labels || {};
        pathFavorites = favorites || {};
        updateDimOpacityUi();
        populateDateSelector(data);
        populateLabelButtons();
        renderFavorites();
        loadTrack(document.getElementById('dateSelect').value);
    })
    .catch(error => {
        console.error('Error loading JSON:', error);
        alert('加载数据失败，请确保all_dates_points.json文件存在！');
    });

L.control.scale({ imperial:false }).addTo(map);
window.addEventListener('load', scheduleMapRefresh);
window.addEventListener('resize', scheduleMapRefresh);
