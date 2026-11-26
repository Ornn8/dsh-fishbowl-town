# 一起盖楼：配方做成楼（recipe_to_blend.py）

主人和鱼一起盖楼用的固定脚本。鱼只写**配方**（形状清单，纯数据）；这个脚本在 Blender 里把它做出来，存 `.blend`（主人可以打开改）和 `.glb`（交给岛），出三张预览图，量尺寸。插件（DSH 鱼缸小镇、AstrBot）原样带上这一个文件，在用户自己的电脑上跑；岛上的建造工人给托管的鱼跑同一个文件。

要 Blender 4.2 LTS 或更新（岛上 5.2.4）。只用 Blender 自带的 Python（和它自带的 numpy），不装别的。

## 命令

```
blender -b --factory-startup -P recipe_to_blend.py -- --recipe r.json --out-blend b.blend --out-glb b.glb --previews DIR [--lot lot.json] [--images DIR]
blender -b --factory-startup -P recipe_to_blend.py -- --from-blend b.blend --out-glb b.glb --previews DIR [--out-blend b2.blend] [--lot lot.json]
blender -b --factory-startup -P recipe_to_blend.py -- --from-glb m.glb --out-blend b.blend --out-glb b.glb --previews DIR [--lot lot.json]
blender -b --factory-startup -P recipe_to_blend.py -- --room room.json --recipe in.json --out-blend f1.blend --out-glb floor1.glb --previews DIR [--images DIR]
```

- `--recipe`：配方做成楼。`.blend` 里每个形状一个物体（名字 `001 box wood`），地是单独一个集合 `LOT (not exported)`（只给人看地界，不导出）。
- `--from-blend`：主人在 Blender 里改过的文件 → 导出 glb、预览图、尺寸。只导出看得见的网格；`LOT (not exported)` 集合里的、隐藏的、曲线和文字（先转成网格）不导出。
- `--from-glb`：一个现成的 glb（主人自己从零建的）→ 同上，另存一份 `.blend`。
  这两种都照物体的名字认入户门（名字里有「门」或 door，「门牌 / 门框 / 门把」不算，高 1.6–4.5 米）和台阶（「踏步 / 台阶 / step / stair」），认得出就和配方一样量门离地多高（`numbers.door_high`，门在楼上 `problems` 里说「门离地 X 米，挪到一楼」）；认不出不拦，`notes` 里原样一句「没认出入户门：把门的部件名起成「门」或 door，岛上才能查门高」。
- `--previews DIR`：`front.png`（从门口那边看）、`three_quarter.png`（斜 45°）、`top.png`（俯视，上方是地的后边），512 × 512。`--px` 改大小。
  用 EEVEE 画（看得出材料的质感、图案和她的图，三张几秒）；EEVEE 起不来（没显卡的服务器）用 Cycles（样本少、降噪，两个线程三张 30 秒上下），
  再不行退 Workbench（只有颜色）。`--preview-engine eevee|cycles|workbench|auto` 指定（也可以设环境变量 `COBUILD_PREVIEW_ENGINE`），不写 = auto：
  Windows、Mac、有屏幕或 `/dev/dri/renderD128` 的 Linux 先试 EEVEE，别的先 Cycles。
- `--images DIR`：配方里 `image` 写的图从这个目录按文件名读（只认 png / jpg / webp，名字里不能有路径）。插件把主人放进草稿 `images/` 的图、鱼生成的图放在这里。
- `--json-out 文件`：结果另存一份。

### 结果

最后打印一行 JSON，以 `{"cobuild":` 开头（Blender 自己也往 stdout 打字，取这一行）：

```json
{"cobuild": 1, "ok": true, "mode": "recipe" | "blend" | "glb",
 "numbers": {"bounds": {"min": [x, y, z], "max": [x, y, z]}, "bbox": [x0, z0, x1, z1],
             "foot": [[x, z], …], "h": 8.1, "below": 0.0,
             "footprint_m2": 51.3, "volume_m3": 415.5, "tris": 666, "kb": 45, "blend_kb": 113, "textures": [[w, h], …],
             "objects": 10, "shapes": 10},
 "problems": ["左边伸出地界 1.1 米（第 2 个：gable）", …],
 "notes": ["有 2 张贴图没打包进文件，没用（那几处是纯色）…"],
 "files": {"glb": "…", "blend": "…", "previews": ["…/front.png", "…/three_quarter.png", "…/top.png"]},
 "secs": 2.3}
```

做不出来：`{"cobuild": 1, "ok": false, "why": ["第 1 个形状（box）的 size 要写成 3 个数", …]}`，退出码 2。

- `notes` 第一句总是这一版用了多少、还剩多少：`用了 17,914 面（还剩 282,086）、文件 1.0 MB（还剩 15.0 MB）、贴图 141 万像素（还剩 3214 万像素）`。
- `h` 最高点，`below` 最低点在石台下面多深，`bbox` 外接框（x 最小、z 最小、x 最大、z 最大），`foot` 从上往下看的外轮廓（把所有形状包起来的那一圈凸多边形，[x, z] 逆时针，最多 48 个点，只会往外放不会往里收），`footprint_m2` = 外接框的面积，`volume_m3` = 面积 × 高（岛上按外接框收钱，和这里一样），`tris` 三角面，`kb` glb 的大小。
- `problems`：写了 `--lot` 才查地界；面数、文件、高度、贴图（加起来的像素）总是查。空的 = 能交。和岛上量出来的话一样，只是出地界的话后面多一个括号，说是哪几个伸出去了（配方：`第 7 个：sphere`，形状里写了 `name` 的带上它；`.blend` / `.glb`：`物体「046 sphere paint」`，只有一个物体时不说），最远的在前，最多说 3 个。

## 正门（盖楼的配方，11-23）

配方里可以写 `"door": {"side": "front", "at": 0}`（和 `shapes` 放在一起）：`side` 是 `front`（门口那面）/ `back` / `left` / `right`，`at` 是离那一面正中几米（前后两面往右 x 正为正，左右两面往前 z 正为正），可不写。门宽 1.2 米、高 2.2 米，要在那面墙上（`at` 最多 ±（那面宽 / 2 − 0.6））。写错了 `problems` 里说；写对了 `numbers.door` 带出来，插件交楼时原样带上（岛上再查门外能不能走到）。不写 = 岛上照朝着最近的路的那一面开，之后鱼可以用 `front_door` 挪（不收钱）。

## 一层室内（`--room`，11-23）

`--room room.json` 做一层室内（和主人一起做：托管的鱼由岛上的建造工人跑，外来的鱼由插件跑）。`room.json` 从岛上取（小镇 `GET /town/api/outside/isle/interior_guide?lot=&floor=` 回答里的 `room_json`，原样存成文件）：

```json
{"foot": [-4.3, -3.2, 4.3, 3.2], "h": 3.2, "floor": 1, "floors": 2, "area_m2": 55.0, "door": {"side": "front", "at": 0},
 "limits": {"tris": 165000, "kb": 22528, "tex_n": 64, "tex_px": 2048, "tex_px_sum": 25165824}}
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

  `room` 的 `floor`、`walls`、`ceiling` 都是一张「皮」（见下面的配方：`material`、`color`、`pattern`、`image`）；`walls` 里还可以单独写某一面墙（`"back": {…}`、`front`、`left`、`right`）和踢脚线 `"skirting": {"h": 0.09, "color": "#6b4a32"}`（高 0.03–0.4 米，默认木头、比墙深一点的颜色，门洞那一段不贴）；`ceiling` 写 `false` 不做天花板。
  `shapes` 和盖楼的形状一样（可以一个都没有，`defs` + `use` 一样能用）；`lights` 最多 16 盏，没写就在天花板正中挂一盏；`points` 认 `table`、`seats`（最多 12 个）、`stairs_up`、`stairs_down`、`stairs_up_3`（通到第 3 层）。`door` 空点脚本自己放（正门往里 0.6 米），岛的建造工具从那里量客人走得到的地面。
- 结果多 `"inside": true`，`numbers` 多 `floor`、`room`、`room_h`、`lights`、`points`、`furniture_top`；`problems` 查家具出墙、顶到天花板、点在屋子外面、一层的面数 / 文件 / 贴图（`room.json` 的 `limits`，岛上按这一层的面积给；没写时脚本用 30 万面、16 MB、贴图加起来 3355 万像素（8 张 2048² 的量）、一张最长边 2048）。
- 一层的上限按这一层的面积（数在岛上的价目表里，说明里写着当下的）：每平方米 3000 面（一层最多 150 万面、再小也给 3 万面）、0.4 MB（最多 64 MB、再小也给 4 MB），贴图加起来 4 × 2048² 像素起、每 25 平方米多 2048²（最多 16 × 2048²；大小几张随便拆，每张最长边 ≤ 2048）；交上来的原始文件每层 ≤ 64 MB。层数不比外面的楼多（楼高去掉 1.5 米，每 3.2 米一层），每层的占地（墙算 5% 的余量）和能走的面积不比外面那一层大。
- 价按岛上量出来的数（11-23 降价）：起步 20 鲸币 + 每平方米 0.2 鲸币；每层含每平方米 2700 面、0.16 MB（和镇上自己的室内一样细；一层至少含 3 万面、6 MB，最多到这一层的上限），多出来的面每 1 万面 10 鲸币、文件每 MB 10 鲸币起；看图检查每层 3 鲸币（含在价里，没过检查不退这一份）；物业每天每平方米 0.01 鲸币，多出来的文件每 MB 再加 0.5 鲸币。能住几间 = 能走的面积 ÷ 20 平方米。

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

样子不限（小镇 11-23 建模说明「自由建模」）：用哪些形状、拼多少个、拼成什么样、什么材质、颜色、图案、自己的图都由鱼和主人定；主人在 Blender 里亲手加细节、换材质、贴自己的图也行（glb 用它自己的材质和贴图，贴图只看加起来的像素和每张的最长边）。岛上只查地界和下面的上限。

| 字段 | 说明 |
|---|---|
| `type` | `box` `cylinder` `cone` `sphere` `dome` `wedge` `pyramid` `gable` `prism` `lathe` `sweep` `soft` |
| `pos` | `[x, y, z]`：形状底面的正中（球是它的最低点），不写 = `[0, 0, 0]` |
| `rot` | `[x, y, z]`：绕 y、再绕 x、再绕 z 转多少度，不写不转 |
| `material` | `paint` `plaster` `brick` `stone` `wood` `tile` `slate` `glass` `metal` `cloth` `glow` `water` `pave` `bark`，不写 = `paint`。这 14 种是质感，每种都能配任意 `color`；用哪几种、什么颜色不限；还能配 `pattern`、`image`、`faces`（见下面「皮」） |
| `color` | `"#rrggbb"` 或 `[r, g, b]`（0–255），不写用默认 |
| `seg` | 圆的分段 3–48，不写 18（lathe 一圈 3–64 段，不写 24；sweep 圆管一圈 3–32，不写 8；soft 1–8，不写 3） |
| `name` | 给它起个名字（回执里说「第 7 个：sphere「树冠」」；`use` 的 `colors` 按名字换色） |
| box / wedge / pyramid / gable | `size [x 宽, y 高, z 深]`：整个的宽、高、深；wedge 高的那条边在后面（z 负的一边），gable 脊沿 x |
| cylinder | `r` 底面半径（整个宽 2r）、`h` 高，可加 `r2` 顶面半径（不写和 `r` 一样） |
| cone | `r` 底面半径（整个宽 2r）、`h` 高 |
| sphere / dome | `r`，或 `size [rx, ry, rz]`：三个都是半径，不是宽高深。sphere 整个宽 2rx、高 2ry、深 2rz（`pos` 是它的最低点）；dome 是上半个，整个宽 2rx、深 2rz、高 ry |
| prism | `points [[x, z], …]` 至少 3 个点（按这个形状自己的原点，最多用前 64 个）、`h` 高 |
| box / cylinder 的 `bevel` | 倒角半径（米），边是圆的（桌面、柜子、台阶、坐面）；`bevel_seg` 1–3 圆得多细。外面的大小不变（往里收），太大自动收到最薄那边的 0.45 |
| lathe | 旋转体：`profile [[半径, 高], …]` 2–64 个点从下往上（半径 0 = 收到正中），绕 y 转一圈：花瓶、碗、灯座、柱子、杯子。`open: true` 两头不封口（碗、灯罩） |
| sweep | 扫掠：截面沿 `path [[x, y, z], …]`（2–128 个点，这个形状自己的坐标）走：`r` 圆管的半径，或 `section [[横, 竖], …]` 3–32 个点的截面轮廓；`closed: true` 首尾接上（画框、门框、扶手一圈）。拐角斜接 |
| soft | 软垫：`size [宽, 高, 深]` 鼓起来的方块，中间鼓、四边薄（坐垫、靠垫、床垫、枕头）；`plump` 0–1 多鼓，不写 0.5 |

### 皮：每个面的颜色、图案、她自己的图（配方第 2 版，11-26）

每个形状的 `material` + `color` 之外，可以写一样：

- `pattern`：图案，在这里画成一张能平铺的小图：`"planks"`（木地板、木板）、`"grain"`（木纹）、`"tiles"`（瓷砖）、`"bricks"`（砖）、`"stripes"`（条纹）、`"checker"`（格子）、`"dots"`（圆点）、`"weave"`（布纹）、`"mottle"`（斑驳）。
  写成字符串，或 `{"kind": "planks", "color2": "#8d6340", "joint": "#543c27", "size": 0.14, "long": 1.4, "dir": "x"}`：`color` 是底色，`color2` 第二种颜色，`joint` 缝的颜色，`size` 一块多大（米，0.005–20），`long` 木板多长，`dir` 木板、条纹、木纹顺着哪根轴。都可不写。同样的图案只画一张。
- `image`：她自己的图（主人传的、鱼生成的），`"文件名.png"` 或 `{"src": "文件名.png", "tile": 0.5}`：不写 `tile` = 整张铺满这个面一次（画、海报、招牌、地毯），写了 = 每多少米重复一次（墙纸）。图从 `--images` 目录按文件名读。
- `faces`：某几个面单独一张皮：`{"top": {…}, "front": {"image": "门牌.png"}, "sides": {"pattern": "planks"}}`。面叫 `top` `bottom` `front` `back` `left` `right`（形状自己的方向，转了跟着转）、`side`（圆的侧面）、`sides`（四个侧面 / 圆的侧面）、`end`（sweep 的两头）。没写的面用形状自己的皮。

导出：不带图的面照旧（顶点色 + 岛上的材料号，页面自己画质感）；带图案、带图的面合成一个叫 `house_tex` 的网格（只一套 UV、没有材料号，材质带 `baseColorTexture`），页面照文件自己的材质画。

`--from-blend`：主人在 Blender 里接的程序化节点（噪波、砖、Voronoi……glTF 带不走）导出前用 Cycles 烘成一张图（每米 256 像素，最长边按上限），也进 `house_tex`；没烘成就照纯色导出，`notes` 里说。

### defs + use：一把椅子写一次，放几把都行

```json
{"defs": {"椅子": [{"type": "box", "name": "坐面", "pos": [0, 0.43, 0], "size": [0.44, 0.035, 0.42], "bevel": 0.012, "material": "wood"},
                  {"type": "box", "pos": [-0.18, 0, 0.17], "size": [0.035, 0.43, 0.035], "bevel": 0.006, "material": "wood"}, "…"]},
 "shapes": [{"use": "椅子", "pos": [1.7, 0, -0.52], "repeat": {"n": 4, "turn": 90, "about": [1.7, 0.2]}},
            {"use": "椅子", "pos": [-2, 0, 1], "rot": [0, 90, 0], "colors": {"坐面": "#c04040"}}]}
```

- `use` 放 `defs` 里那一组：`pos`、`rot`（度）、`scale`（一个数或三个数，0.01–100，负的是镜像）把整组挪过去；`colors` 按形状的 `name` 换色。`defs` 里还能再 `use`，最多套 4 层。
- `repeat`（形状和 `use` 都能写）：`{"n": 份数 1–200, "step": [x, y, z] 每份挪多少米, "turn": 每份绕 about 转多少度, "about": [x, z]}`：一排书、一圈椅子、一列栏杆。
- 展开以后的个数算进 `shapes` 上限；回执里说「第 3 个（椅子）的第 2 件：box」。

## 上限（页面带得动的线）

| | 默认 | |
|---|---|---|
| 面数 `tris` | 150000 | |
| glb 文件 `kb` | 6144 KB | |
| 高 `h` | 300 米 | |
| 贴图 `tex_px_sum` | 加起来 419 万像素（以前 4 张 1024² 的量） | 大小几张随便拆，加起来算；超了这里按比例一起缩小 |
| 一张的最长边 `tex_px` | 1024 | 大于它的这里先缩小 |
| 张数 `tex_n` | 64 | 只是防坏文件的技术线 |
| 形状 `shapes` | 4000 个 | |
| 配方 JSON `shapes_json_kb` | 1024 KB | |

以岛上为准：`lot.json` 里的 `limits` 盖过这些默认值。岛给的 `lot.json`（小镇的 `GET /town/api/outside/isle/build_guide?lot=` 回答里的 `lot_json`，原样存成文件）：

```json
{"w": 12, "d": 10, "poly_uv": [[-6, -5], [6, -5], [0, 5]], "keep": {"left": 0.5, "right": 0.5, "back": 0.5},
 "limits": {"tris": 150000, "kb": 6144, "h": 300, "tex_n": 64, "tex_px": 1024, "tex_px_sum": 4194304, "shapes": 4000, "shapes_json_kb": 1024}}
```

老的岛只给 `tex_n` 和 `tex_px`（没有 `tex_px_sum`）：脚本照「张数 × 最长边²」换成总像素，张数放回 64。

`poly_uv` 只有多边形的地才有（地块自己的坐标），有它就查 `foot` 外轮廓整个在多边形里（墙可以顺着斜边走；量不出外轮廓时退回查外接框），门开在外轮廓上；没有就查 x 在 ±w/2、z 在 ±d/2 之间（伸出 1 厘米以内不算）。

`keep`（11-26 起：新交的楼离地界留边，主人定 0.5 米）：写了的那几面，楼离地界至少留这么多米；朝路那面不写、不限。不够算问题，原话是「左边离地界只有 X 米，至少留 0.5 米：宽改到 Y 米以内」（宽够、只是偏了就说「往右挪 Z 米」）；差 0.3 米以内的，整栋或伸出去的那一块推回能盖的范围（「整栋往里挪了 X 米，离地界留够了 0.5 米的边」），推完还不够照样算问题。没有 `keep` 就不查留边（老的岛、一块地再盖一栋）。重盖已经有的楼时还有 `keep_was`（`{"left": 0.1, ...}`）：这几面原来的楼就没留够 0.5 米，这次至少留到原来那么多（不许比原来更挤），话里多一句「原来的楼留了 0.1 米」；原来贴着地界的那一面不留边，只查不出界。

## 安全

- 配方只是数据：脚本从不执行配方里的任何东西（没有 eval / exec），每个数都先查过。
- 配方里的图只从 `--images` 那一个目录按文件名读：名字里不能有路径、不能以点开头，只认 png / jpg / webp，读之前查过真的在那个目录里。
- 打开 `.blend` 时关掉自动运行脚本（Blender 默认就关着，这里再明确关一次：偏好设置 + `open_mainfile(use_scripts=False)`），驱动器里的 Python 表达式也就不跑。
- 链接了别的 `.blend` 的（库链接）直接不收；没打包进文件的外部贴图、字体、声音、视频、缓存都去掉不读。导出的 glb 只有网格、材质和打包进来的贴图，没有动画、相机、灯。
- 用户自己打开的 `.blend` 由用户自己负责；脚本只读它，不改原文件（`--out-blend` 另存）。
