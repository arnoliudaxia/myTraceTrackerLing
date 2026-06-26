
`generate-data.mjs` 会读取字段：

- `latitude`
- `longitude`
- `geoTime`
- `dayTime`
- `altitude`
- `speed`

日期优先级：

1. 如果 CSV 有 `date` 字段，直接使用
2. 否则用 `dayTime`
3. 再否则用 `geoTime`

所有日期按 `Asia/Shanghai` 处理。

**数据库结构**
`lib/db.mjs` 初始化 4 张表：

- `tracks`：每日轨迹汇总，包含日期、点数、起止时间、海拔/速度范围
- `track_points`：每日轨迹点，包含坐标、时间戳、海拔、速度、显示时间
- `path_labels`：路径段标签
- `path_favorites`：路径段收藏


标签和收藏的 key 逻辑是：

```text
日期#路径段索引
```

例如：

```json
{
  "2024-05-03#0": "通勤"
}
```

收藏格式是：

```json
{
  "2024-05-03#0": {
    "note": "这一段风景很好",
    "createdAt": "2026-05-05T12:00:00.000Z"
  }
}
```