# 一起盖楼：配方做成楼（recipe_to_blend.py）

主人和鱼一起盖楼用的固定脚本。鱼只写**配方**（形状清单，纯数据）；这个脚本在 Blender 里把它做出来，存 `.blend`（主人可以打开改）和 `.glb`（交给岛），出三张预览图，量尺寸。插件（DSH 鱼缸小镇、AstrBot）原样带上这一个文件，在用户自己的电脑上跑；岛上的建造工人给托管的鱼跑同一个文件。

要 Blender 4.2 LTS 或更新（岛上 5.2.4）。只用 Blender 自带的 Python，不装别的。

## 命令

```
blender -b --factory-startup -P recipe_to_blend.py -- --recipe r.json --out-blend b.blend --out-glb b.glb --previews DIR [--lot lot.json]
blender -b --factory-startup -P recipe_to_blend.py -- --from-blend b.blend --out-glb b.glb --previews DIR [--out-blend b2.blend] [--lot lot.json]
blender -b --factory-startup -P recipe_to_blend.py -- --from-glb m.glb --out-blend b.blend --out-glb b.glb --previews DIR [--lot lot.json]
blender -b --factory-startup -P recipe_to_blend.py -- --room room.json --recipe in.json --out-blend f1.blend --out-glb floor1.glb --previews DIR
```

- `--recipe`：配方做成楼。`.blend` 里每个形状一个物体（名字 `001 box wood`），地是单独一个集合 `LOT (not exported)`（只给人看地界，不导出）。
- `--from-blend`：主人在 Blender 里改过的文件 → 导出 glb、预览图、尺寸。只导出看得见的网格；`LOT (not exported)` 集合里的、隐藏的、曲线和文字（先转成网格）不导出。
- `--from-glb`：一个现成的 glb（主人自己从零建的）→ 同上，另存一份 `.blend`。
- `--previews DIR`：`front.png`（从门口那边看）、`three_quarter.png`（斜 45°）、`top.png`（俯视，上方是地的后边），512 × 512，Workbench，一张一两秒。`--px` 改大小。
- `--json-out 文件`：结果另存一份。

### 结果

最后打印一行 JSON，以 `{"cobuild":` 开头（Blender 自己也往 stdout 打字，取这一行）：

```json
{"cobuild": 1, "ok": true, "mode": "recipe" | "blend" | "glb",
 "numbers": {"bounds": {"min": [x, y, z], "max": [x, y, z]}, "bbox": [x0, z0, x1, z1], "h": 8.1, "below": 0.0,
             "footprint_m2": 51.3, "volume_m3": 415.5, "tris": 666, "kb": 45, "blend_kb": 113, "textures": [[w, h], …],
             "objects": 10, "shapes": 10},
 "problems": ["左边伸出地界 1.1 米（第 2 个：gable）", …],
 "notes": ["有 2 张贴图没打包进文件，没用（那几处是纯色）…"],
 "files": {"glb": "…", "blend": "…", "previews": ["…/front.png", "…/three_quarter.png", "…/top.png"]},
 "secs": 2.3}
```

做不出来：`{"cobuild": 1, "ok": false, "why": ["第 1 个形状（box）的 size 要写成 3 个数", …]}`，退出码 2。

- `h` 最高点，`below` 最低点在石台下面多深，`bbox` 外接框（x 最小、z 最小、x 最大、z 最大），`footprint_m2` = 外接框的面积，`volume_m3` = 面积 × 高（岛上按外轮廓收钱，和这里一样），`tris` 三角面，`kb` glb 的大小。
- `problems`：写了 `--lot` 才查地界；面数、文件、高度、贴图张数总是查。空的 = 能交。和岛上量出来的话一样，只是出地界的话后面多一个括号，说是哪几个伸出去了（配方：`第 7 个：sphere`，形状里写了 `name` 的带上它；`.blend` / `.glb`：`物体「046 sphere paint」`，只有一个物体时不说），最远的在前，最多说 3 个。

## 正门（盖楼的配方，11-23）

配方里可以写 `"door": {"side": "front", "at": 0}`（和 `shapes` 放在一起）：`side` 是 `front`（门口那面）/ `back` / `left` / `right`，`at` 是离那一面正中几米（前后两面往右 x 正为正，左右两面往前 z 正为正），可不写。门宽 1.2 米、高 2.2 米，要在那面墙上（`at` 最多 ±（那面宽 / 2 − 0.6））。写错了 `problems` 里说；写对了 `numbers.door` 带出来，插件交楼时原样带上（岛上再查门外能不能走到）。不写 = 岛上照朝着最近的路的那一面开，之后鱼可以用 `front_door` 挪（不收钱）。

## 一层室内（`--room`，11-23）

`--room room.json` 做一层室内（和主人一起做：托管的鱼由岛上的建造工人跑，外来的鱼由插件跑）。`room.json` 从岛上取（小镇 `GET /town/api/outside/isle/interior_guide?lot=&floor=` 回答里的 `room_json`，原样存成文件）：

```json
{"foot": [-4.3, -3.2, 4.3, 3.2], "h": 3.2, "floor": 1, "floors": 2, "area_m2": 55.0, "door": {"side": "front", "at": 0},
 "limits": {"tris": 165000, "kb": 22528, "tex_n": 6, "tex_px": 2048}}
```

- `foot` 这一层的占地（地块自己的坐标，x 最小、z 最小、x 最大、z 最大；按天租的铺位是她那一份，一层分两边的是一半），墙在占地里面、厚 0.12 米；`h` 层高；`floors` 外面的楼几层；`area_m2` 这一层多大；`door` 只有一层有（楼上的写 `stairs_down`）。
- 室内跟着外面的楼走：几层就做几层，每层不比外面大，面数和文件按面积给。一层一个 .glb，按外面的楼层叫（`floor1.glb` 就是 1 楼）。
- 脚本自己做地板（顶面 y = 0）、四面墙（一层在正门那里开 1.2 × 2.2 米的洞）、天花板，再放配方里的家具。坐标和盖楼一样，原点是地块正中、这一层的地面。
- 室内配方：

```json
{"room": {"floor": {"material": "wood"}, "walls": {"material": "plaster", "color": "#f2e2c4"}, "ceiling": {"material": "plaster"}},
 "shapes": [{"type": "box", "name": "柜台", "pos": [-2.2, 0, 1.2], "size": [2.4, 1.0, 0.6], "material": "wood"}],
 "lights": [{"at": [0, 2.7, 0], "power": 200}],
 "points": {"table": [0.8, 0.75, -1.2], "seats": [[0.8, 0.45, -0.4], [0.8, 0.45, -2.0]], "stairs_up": [3, -2]}}
```

  `shapes` 和盖楼的形状一样（可以一个都没有）；`lights` 最多 16 盏，没写就在天花板正中挂一盏；`points` 认 `table`、`seats`（最多 12 个）、`stairs_up`、`stairs_down`、`stairs_up_3`（通到第 3 层）。`door` 空点脚本自己放（正门往里 0.6 米），岛的建造工具从那里量客人走得到的地面。
- 结果多 `"inside": true`，`numbers` 多 `floor`、`room`、`room_h`、`lights`、`points`、`furniture_top`；`problems` 查家具出墙、顶到天花板、点在屋子外面、一层的面数 / 文件 / 贴图（`room.json` 的 `limits`，岛上按这一层的面积给；没写时脚本用 30 万面、16 MB、8 张、2048 像素）。
- 一层的上限按这一层的面积（数在岛上的价目表里，说明里写着当下的）：每平方米 3000 面（一层最多 150 万面、再小也给 3 万面）、0.4 MB（最多 64 MB、再小也给 4 MB），贴图 4 张起、每 25 平方米多 1 张（最多 16 张，每张 ≤ 2048 像素）；交上来的原始文件每层 ≤ 64 MB。层数不比外面的楼多（楼高去掉 1.5 米，每 3.2 米一层），每层的占地（墙算 5% 的余量）和能走的面积不比外面那一层大。
- 价按岛上量出来的数（小镇 11-23 下午起的价目，以岛上报的为准）：起步 20 鲸币 + 每平方米 0.2 鲸币；每层含每平方米 2700 面、0.16 MB（一层至少含 3 万面、6 MB，最多到这一层的上限），多出来的面每 1 万面 10 鲸币，多出来的文件含量的 1–2 倍每 MB 10 鲸币、2–4 倍 40 鲸币、4 倍以上 100 鲸币；看图检查每层 3 鲸币（含在价里）；物业每天每平方米 0.01 鲸币 + 多出来的文件每 MB 0.5 鲸币。能住几间 = 能走的面积 ÷ 20 平方米。

## 坐标

长度都是米。原点 = 地块正中、石台顶面（y = 0）；x 向右，y 向上，z 朝门口（地块前面）。glb 按 glTF 的规矩 Y 朝上，坐标就是上面这一套：**岛上原样放，不挪、不居中**。

## 配方

和岛上一直认的形状清单一样（`build_guide` 里写的）：

```json
{"shapes": [
  {"type": "box",   "pos": [0, 0, 0], "size": [6, 3, 4], "material": "plaster", "color": "#f2e2c4"},
  {"type": "gable", "pos": [0, 3, 0], "size": [6, 1.5, 4], "material": "tile"}
]}
```

也认裸的 `[…]`、`{"kind": "shapes" | "recipe", "shapes": {"shapes": […]}}`。

样子不限（小镇 11-23 建模说明「自由建模」）：用哪些形状、拼多少个、拼成什么样、什么材质和颜色都由鱼和主人定；主人在 Blender 里亲手加细节、换材质、贴自己的图也行（glb 用它自己的材质和贴图，只有贴图张数和大小的上限）。岛上只查地界和下面的上限。

| 字段 | 说明 |
|---|---|
| `type` | `box` `cylinder` `cone` `sphere` `dome` `wedge` `pyramid` `gable` `prism` |
| `pos` | `[x, y, z]`：形状底面的正中（球是它的最低点），不写 = `[0, 0, 0]` |
| `rot` | `[x, y, z]`：绕 y、再绕 x、再绕 z 转多少度，不写不转 |
| `material` | `paint` `plaster` `brick` `stone` `wood` `tile` `slate` `glass` `metal` `cloth` `glow` `water` `pave` `bark`，不写 = `paint`。这 14 种是质感，每种都能配任意 `color`；用哪几种、什么颜色不限 |
| `color` | `"#rrggbb"` 或 `[r, g, b]`（0–255），不写用默认 |
| `seg` | 圆的分段 3–48，不写 18 |
| box / wedge / pyramid / gable | `size [x 宽, y 高, z 深]`：整个的宽、高、深；wedge 高的那条边在后面（z 负的一边），gable 脊沿 x |
| cylinder | `r` 底面半径（整个宽 2r）、`h` 高，可加 `r2` 顶面半径（不写和 `r` 一样） |
| cone | `r` 底面半径（整个宽 2r）、`h` 高 |
| sphere / dome | `r`，或 `size [rx, ry, rz]`：三个都是半径，不是宽高深。sphere 整个宽 2rx、高 2ry、深 2rz（`pos` 是它的最低点）；dome 是上半个，整个宽 2rx、深 2rz、高 ry |
| prism | `points [[x, z], …]` 至少 3 个点（按这个形状自己的原点，最多用前 64 个）、`h` 高 |

## 上限（页面带得动的线）

| | 默认 | |
|---|---|---|
| 面数 `tris` | 150000 | |
| glb 文件 `kb` | 6144 KB | |
| 高 `h` | 300 米 | |
| 贴图 `tex_n` / `tex_px` | 4 张 / 最长边 1024 | 大于 1024 的这里先缩小 |
| 形状 `shapes` | 4000 个 | |
| 配方 JSON `shapes_json_kb` | 1024 KB | |

以岛上为准：`lot.json` 里的 `limits` 盖过这些默认值。岛给的 `lot.json`（小镇的 `GET /town/api/outside/isle/build_guide?lot=` 回答里的 `lot_json`，原样存成文件）：

```json
{"w": 12, "d": 10, "poly_uv": [[-6, -5], [6, -5], [0, 5]],
 "limits": {"tris": 150000, "kb": 6144, "h": 300, "tex_n": 4, "tex_px": 1024, "shapes": 4000, "shapes_json_kb": 1024}}
```

`poly_uv` 只有多边形的地才有（地块自己的坐标），有它就查外接框整个在多边形里，没有就查 x 在 ±w/2、z 在 ±d/2 之间（伸出 1 厘米以内不算）。

## 安全

- 配方只是数据：脚本从不执行配方里的任何东西（没有 eval / exec），每个数都先查过。
- 打开 `.blend` 时关掉自动运行脚本（Blender 默认就关着，这里再明确关一次：偏好设置 + `open_mainfile(use_scripts=False)`），驱动器里的 Python 表达式也就不跑。
- 链接了别的 `.blend` 的（库链接）直接不收；没打包进文件的外部贴图、字体、声音、视频、缓存都去掉不读。导出的 glb 只有网格、材质和打包进来的贴图，没有动画、相机、灯。
- 用户自己打开的 `.blend` 由用户自己负责；脚本只读它，不改原文件（`--out-blend` 另存）。
