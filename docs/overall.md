# 项目整体说明

本文档用于说明当前项目的技术结构和核心程序逻辑。项目已经迁移为本地 Node.js 服务 + SQLite 数据库 + Leaflet 前端页面的结构，运行时数据以 `data.db` 为中心。

## 🔧 技术说明

### 运行结构

项目由三层组成：

- `server.mjs`：本地 HTTP 服务，托管 `public/` 静态资源，并提供轨迹、标签、收藏、数据库导入导出、地图瓦片代理等接口。
- `lib/db.mjs`：SQLite 数据访问层，负责初始化表结构、读写轨迹、标签、收藏和自定义标签。
- `public/`：前端页面，使用 Leaflet 绘制地图、轨迹、速度可视化、数据点、标签和收藏面板。

启动命令：

```bash
npm start
```

默认服务地址：

```text
http://localhost:3000
```

如果项目根目录没有 `data.db`，服务仍然可以启动。SQLite 会自动创建空数据库，`lib/db.mjs` 会初始化所需表结构。此时页面没有轨迹数据，需要通过设置面板上传 DB，或使用生成脚本从 CSV 生成数据。

### 数据存储

所有运行时数据集中保存在项目根目录的 `data.db` 中。

数据库表：

- `tracks`：每日轨迹汇总，包括日期、点数、起止时间、海拔范围、速度范围。
- `track_points`：轨迹点明细，包括坐标、时间戳、海拔、速度、展示时间。
- `path_labels`：路径段标签，按日期和路径段索引保存。
- `path_favorites`：路径段收藏，保存备注、收藏时间、收藏图片等数据。
- `custom_labels`：用户新建的标签列表。

收藏图片目前直接存储在数据库中：

- `image_mime`：图片 MIME 类型。
- `image_data`：缩放后的图片 data URL。
- `image_updated_at`：图片更新时间。

因此迁移到另一台机器时，只要带上同一个 `data.db`，轨迹、标签、收藏、收藏图片都会一起迁移。

### 接口说明

前端通过本地 API 获取数据：

- `GET /api/tracks`：读取全部轨迹数据。
- `GET /api/path-labels`：读取路径标签。
- `POST /api/path-labels`：保存路径标签。
- `GET /api/path-favorites`：读取路径收藏。
- `POST /api/path-favorites`：保存路径收藏。
- `GET /api/custom-labels`：读取自定义标签。
- `POST /api/custom-labels`：保存自定义标签。
- `GET /api/database/download`：导出当前 `data.db`。
- `POST /api/database/upload`：上传并替换当前 `data.db`，替换前会备份旧数据库。

运行时不再读取旧版数据文件名，例如 `all_dates_points.json`、`path_labels.json`、`path_favorites.json`、`custom_labels.json`。这些旧文件名只应保留在历史迁移脚本中。

### 地图和外部服务

前端使用 Leaflet.js 作为地图渲染库。

可用底图包括：

- OpenStreetMap。
- Esri World Imagery。
- 天地图。
- GEOVIS Earth。
- Tracestrack。

部分底图需要在 `.env` 中配置 key：

```text
TIANDITU_KEY=...
GEOVIS_TOKEN=...
TRACESTRACK_KEY=...
```

如果没有这些 key，项目仍然可以使用不需要 key 的底图。

### 坐标纠偏

国内地图 APP 常使用 GCJ-02 坐标系，国际地图服务通常使用 WGS84 坐标系。前端会在绘制轨迹前执行坐标纠偏，将轨迹点从 GCJ-02 近似转换到 WGS84。

核心过程：

```javascript
dLat = transformLat(lng - 105.0, lat - 35.0);
dLng = transformLng(lng - 105.0, lat - 35.0);

correctedLat = lat - dLat;
correctedLng = lng - dLng;
```

如果输入数据本身已经是 WGS84，需要检查 `public/app.js` 中的坐标纠偏逻辑，避免重复纠偏。

### 路径分段

路径段根据相邻轨迹点的时间间隔自动切分。

默认阈值为 1 小时：

```javascript
const PATH_GAP_THRESHOLD_MS = 60 * 60 * 1000;
```

如果两个相邻点的 `geoTime` 间隔超过 1 小时，则认为路径中断，开始新的路径段。

生成数据时还会处理跨天连续路径：如果前一天最后一段和后一天第一段之间的时间差不超过 1 小时，会把后一天第一段合并到前一天最后一段中，避免凌晨跨天导致路径被错误切断。

### 速度可视化

速度可视化使用 CSV 中的 `speed` 字段。前端会根据相邻轨迹点的平均速度给路径分段着色。

颜色含义：

- 低速：偏蓝。
- 高速：偏红。
- 图例显示当前选中路径范围内的最低速度和最高速度。

速度可视化会跟随路径段选择变化。只显示某些路径段时，速度范围和颜色映射也会按当前可见路径重新计算。

### 标签和收藏

标签用于给路径段分类。标签保存在 `path_labels` 表中，key 由日期和路径段索引组成：

```text
日期#路径段索引
```

例如：

```text
2024-05-03#0
```

标签管理支持：

- 新建标签。
- 重命名标签。
- 删除标签。
- 重命名或删除时同步处理已绑定路径段上的标签。
- 危险操作需要手动输入标签名确认。

收藏用于保存重要路径段。收藏保存在 `path_favorites` 表中，包含：

- 备注。
- 收藏时间。
- 收藏图片。

收藏夹按路径实际时间从新到旧显示。取消收藏时需要手动输入收藏条目名称确认。

### 数据导入导出

设置面板提供两个数据库操作：

- 导出 DB：下载当前 `data.db`。
- 上传 DB：上传 SQLite 数据库文件并替换当前 `data.db`。

上传时后端会检查 SQLite 文件头：

```text
SQLite format 3
```

替换前会先关闭当前数据库连接，并把旧数据库备份为：

```text
data.db.<timestamp>.backup
```

## 程序解析

### `generate-data.mjs`

`scripts/generate-data.mjs` 用于从 APP 导出的 CSV 生成 `data.db` 中的轨迹数据。

运行方式：

```bash
npm run generate -- "灵敢足迹.csv"
```

脚本入口流程：

1. 解析命令行参数，要求传入一个 CSV 文件路径。
2. 读取 CSV 文件，并解析为对象数组。
3. 根据日期字段把轨迹点分组。
4. 按时间排序并切分路径段。
5. 合并跨天但时间连续的路径段。
6. 生成每日轨迹汇总结构。
7. 初始化 SQLite 数据库。
8. 读取数据库中已有轨迹日期。
9. 如果数据库已有非空轨迹，只保留 CSV 中数据库完全不存在的日期。
10. 调用 `replaceTracks()` 写入 `tracks` 和 `track_points`。

#### 读取字段

脚本主要读取以下字段：

- `latitude`：纬度。
- `longitude`：经度。
- `geoTime`：轨迹点时间戳，单位为毫秒。
- `dayTime`：日期分组时间戳，单位为秒。
- `altitude`：海拔。
- `speed`：速度。
- `date`：可选日期字段。

#### 日期判断

日期优先级：

1. 如果 CSV 中存在 `date` 字段，直接使用。
2. 如果没有 `date`，使用 `dayTime` 计算日期。
3. 如果没有 `dayTime`，使用 `geoTime` 计算日期。
4. 如果三者都没有，则抛出错误。

所有日期和展示时间都按 `Asia/Shanghai` 处理。

#### CSV 解析

脚本内置了一个轻量 CSV 解析器：

- 支持逗号分隔。
- 支持双引号字段。
- 支持字段内双引号转义。
- 会移除 UTF-8 BOM。
- 空行会被跳过。

解析后的每一行会按表头映射为对象。

#### 路径切分

`splitRowsIntoSegments()` 会先按 `geoTime` 排序，再按 1 小时时间间隔切段。

逻辑：

```text
当前点 geoTime - 前一个点 geoTime > 1 小时
```

满足条件时，开始新的路径段。

#### 跨天合并

`mergeCrossDaySegments()` 用于处理跨天连续路径。

如果：

```text
后一天第一段第一个点时间 - 前一天最后一段最后一个点时间 <= 1 小时
```

则把后一天第一段合并到前一天最后一段。

这样可以避免 23:50 到 00:10 这类连续移动被日期边界强行拆开。

#### 每日数据结构

`buildDayData()` 会把某一天的所有路径段展开为前端需要的数据结构：

```javascript
{
  count,
  points,
  timestamps,
  elevations,
  altitude_min,
  altitude_max,
  speeds,
  speed_min,
  speed_max,
  times,
  start_time,
  end_time
}
```

其中：

- `points` 保存 `[latitude, longitude]`。
- `timestamps` 保存毫秒时间戳。
- `elevations` 保存海拔。
- `speeds` 保存速度。
- `times` 保存本地展示时间。
- `altitude_min` / `altitude_max` 保存海拔范围。
- `speed_min` / `speed_max` 保存速度范围。

#### 写入数据库

脚本会先调用：

```javascript
initDatabase();
getExistingTrackDates();
```

如果数据库中已经有轨迹日期，脚本进入增量导入模式：CSV 中属于已有日期的行会被跳过，只有数据库完全不存在的日期才会进入生成流程。

这样可以避免重写已有日期的轨迹点，从而保护基于 `日期#路径段索引` 的标签、收藏和收藏图片关联。

随后调用：

```javascript
replaceTracks(allData);
```

`initDatabase()` 会确保 `data.db` 和表结构存在。

`replaceTracks()` 会写入：

- `tracks`
- `track_points`

注意：`generate-data.mjs` 只写入轨迹数据，不负责管理标签、收藏和自定义标签。这些用户数据由前端操作通过 API 写入数据库。已有非空数据库下，脚本不会更新已有日期，即使新 CSV 中包含同一日期的更多点，也会跳过该日期。

### `filter-csv-days.mjs`

`scripts/filter-csv-days.mjs` 用于清洗低质量日期。

运行方式：

```bash
npm run filter -- "灵敢足迹.csv" --in-place
```

默认规则：

- 按 `dayTime` 对 CSV 行进行日期分组。
- 如果某一天的轨迹点数量不超过阈值，则删除这一天所有记录。
- 默认阈值为 10。
- 可通过 `--threshold` 调整。

示例：

```bash
npm run filter -- "灵敢足迹.csv" --in-place --threshold 20
```

如果不想覆盖原文件，可以输出到新文件：

```bash
npm run filter -- "灵敢足迹.csv" -o "灵敢足迹_filtered.csv" --threshold 10
```

脚本只保留或删除原始行，不会重新格式化 CSV 字段、数字精度或引号。

### `lib/db.mjs`

`lib/db.mjs` 是数据库访问层。

核心职责：

- 定义 `data.db` 路径。
- 初始化 SQLite 表结构。
- 执行轻量 schema migration。
- 读取全部轨迹数据。
- 保存路径标签。
- 保存路径收藏。
- 保存自定义标签。
- 关闭数据库连接，供 DB 上传替换时使用。

关键导出：

- `DB_FILE`
- `initDatabase()`
- `closeDatabase()`
- `getAllData()`
- `getExistingTrackDates()`
- `getPathLabels()`
- `setPathLabels()`
- `getPathFavorites()`
- `setPathFavorites()`
- `getCustomLabels()`
- `setCustomLabels()`
- `replaceTracks()`

### `server.mjs`

`server.mjs` 是本地服务入口。

核心职责：

- 加载 `.env`。
- 初始化数据库。
- 托管 `public/`。
- 提供轨迹、标签、收藏、自定义标签接口。
- 提供 DB 导出和上传接口。
- 代理需要 key 的地图瓦片服务。
- 代理 OSM 行政区划查询。

数据库上传逻辑：

1. 读取请求体二进制内容。
2. 限制最大上传大小为 200 MB。
3. 检查 SQLite 文件头。
4. 关闭当前数据库连接。
5. 备份旧 `data.db`。
6. 写入新数据库。
7. 重新初始化数据库连接。

### `public/app.js`

`public/app.js` 是前端主逻辑。

核心职责：

- 初始化 Leaflet 地图。
- 加载 `/api/tracks` 等本地 API 数据。
- 渲染日期日历和路径段选择。
- 绘制基础轨迹。
- 绘制速度可视化。
- 绘制原始数据点。
- 管理标签面板。
- 管理收藏夹面板。
- 管理设置面板。
- 处理 DB 导出和上传。

前端初始化时会并行请求：

```javascript
fetch('/api/tracks')
fetch('/api/path-labels')
fetch('/api/path-favorites')
fetch('/api/custom-labels')
```

页面不直接读取本地数据文件，所有运行数据都通过本地 API 从 SQLite 读取。

### `public/index.html`

`public/index.html` 定义页面结构。

主要区域：

- 地图容器。
- 左侧控制面板。
- 日期日历。
- 路径段选择。
- 标签管理面板。
- 收藏夹面板。
- 设置面板。
- 地图源选择。
- 速度可视化图例。
- 行政区划面板。

### `public/styles.css`

`public/styles.css` 负责界面样式。

主要样式范围：

- 地图全屏布局。
- 左侧控制面板。
- 图标按钮。
- 独立标签面板。
- 独立收藏夹面板。
- 设置面板。
- 路径段按钮网格。
- 收藏卡片。
- 图片预览。
- 日历控件。
- 行政区划控件。

### 数据链路

完整数据链路：

```text
CSV 原始轨迹
  -> scripts/filter-csv-days.mjs 清洗低质量日期
  -> scripts/generate-data.mjs 解析、分组、分段、跨天合并
  -> lib/db.mjs 写入 data.db
  -> server.mjs 提供本地 API
  -> public/app.js 拉取 API 并绘制地图
```

用户在页面中创建的标签、收藏、收藏图片和自定义标签会通过 API 写回 `data.db`。
