"""主人和鱼一起盖楼：把配方（形状清单，纯数据）做成 Blender 场景，存 .blend 和 .glb，出三张预览图，量尺寸。

插件（DSH 鱼缸小镇、AstrBot）原样带上这一个文件，在用户自己的电脑上跑；岛上的建造工人给托管的鱼用同一个文件。

    blender -b --factory-startup -P recipe_to_blend.py -- --recipe r.json --out-blend b.blend --out-glb b.glb --previews DIR [--lot lot.json] [--images DIR]
    blender -b --factory-startup -P recipe_to_blend.py -- --from-blend b.blend --out-glb b.glb --previews DIR [--out-blend b2.blend] [--lot lot.json]
    blender -b --factory-startup -P recipe_to_blend.py -- --from-glb m.glb --out-blend b.blend --out-glb b.glb --previews DIR [--lot lot.json]
    （都可以再加 --json-out result.json：同一份结果另存一个文件）

楼的配方可以带 "door": {"side": "front|back|left|right", "at": 米}：门开在哪一面、离那一面正中几米（量出来的数里带回 door）。

室内（11-23 主人「内部装修是必须的」）：加 --room room.json，配方就是一层的室内：地板、墙、天花板照楼的占地和层高自动做，家具用同样的
形状，灯、楼梯点、桌子座位另写；做出来的 glb 就是岛上 tools/build.py interior 收的一层（带 door / stairs_* / table / seat_n 空点和灯）。

    blender -b --factory-startup -P recipe_to_blend.py -- --room room.json --recipe in.json --out-blend f1.blend --out-glb floor1.glb --previews DIR
    room.json：{"foot": [x0, z0, x1, z1]（楼的占地，地块自己的坐标）, "h": 层高, "floor": 第几层, "floors": 一共几层,
                "door": {"side", "at"}（楼的正门，只一层用）, "limits"?: {…}}

配方第 2 版（11-26，主人 11-24「我不建议做官方库，会影响用户发挥」：不给现成的家具和贴图，把她们自己的工具做细）：
* 形状多了 lathe（旋转体：一条侧面轮廓转一圈，花瓶、灯座、碗）、sweep（扫掠：一个截面沿一条路径走，扶手、管子、画框、弯的椅背）、
  soft（软垫：鼓起来的方块，靠垫、坐垫、床垫）；box 和 cylinder 可以写 bevel（倒角，米）。
* 皮：每个形状的 material、color 之外可以写 pattern（木纹、木地板、瓷砖、砖、条纹、格子、圆点、布纹、斑驳）或 image（自己的图，
  --images 那个目录里的文件名）；faces 给某几个面单独写皮（top、bottom、front、back、left、right、side、sides、end）。
* defs + use：一把椅子在 defs 里写一次，shapes 里 {"use":"椅子","pos":…,"rot":…} 放几把都行；repeat 一次摆一排或一圈。
* 图案在这里用 numpy 画成能平铺的小图（不用 Cycles）；主人在 .blend 里自己接的程序化节点，导出前用 Cycles 烘成一张图。
  带图的面单独放在一个网格（house_tex）里导出，不带岛上的材料号（页面照文件自己的材质画）；不带图的照旧（顶点色 + 材料号）。
* 预览图用 EEVEE（看得出质感、图案和自己的图）；EEVEE 起不来退 Cycles，再不行退 Workbench。

最后打印一行 JSON（以 {"cobuild": 开头）：{"cobuild": 1, "ok", "mode", "numbers", "problems", "notes", "files", "secs"}；
做不出来是 {"cobuild": 1, "ok": false, "why": [...]}，退出码 2。格式和上限见同目录的 README.md。

安全：配方只是数据，这里从不执行配方里的任何东西（没有 eval / exec，不导入别的模块）。打开 .blend 时关掉自动运行脚本
（Blender 的默认，这里再明确关一次），连着别的 .blend 文件的（库链接）不收，没打包进文件的外部贴图去掉不读。
配方里的图只从 --images 那一个目录里按文件名读（名字里不能有路径，只认 png / jpg / webp）。"""
import heapq
import json
import math
import os
import sys
import time

VERSION = 1
RECIPE_V = 2                        # 配方第 2 版（11-26）：倒角、旋转体、扫掠、软垫，每个面的皮，图案和自己的图，defs + use
TYPES = ("box", "cylinder", "cone", "sphere", "dome", "wedge", "pyramid", "gable", "prism", "lathe", "sweep", "soft")
# 和岛上一样的 14 种材料（town_play/worlds/isle/buildings.py MATERIALS，岛的 tools/build_bl.py MATS）；后面的数是岛上着色器认的材料号
MATERIALS = {"paint": 0, "plaster": 1, "brick": 2, "stone": 3, "wood": 4, "tile": 5, "slate": 6, "glass": 7, "metal": 8, "cloth": 9,
             "glow": 11, "water": 12, "pave": 14, "bark": 15}
# 页面带得动的线（岛的价目表 building.limits）；lot.json 里的 limits 会盖过这些。
# 贴图（11-26）：按总像素给，不再按张数（tex_px_sum = 以前 4 张 1024 × 1024 的量，随便拆成大小几张；tex_px 是一张的最长边，和以前一样，
# 大的这里先缩小；tex_n 只是防坏文件的技术线）。
TEX_UNIT = 1024 * 1024
LIMITS = {"tris": 150000, "kb": 6144, "tex_n": 64, "tex_px": 1024, "tex_px_sum": 4 * TEX_UNIT, "h": 300, "shapes": 4000, "shapes_json_kb": 1024}
DEFAULT_COLOR = 0xE9E2D4
LOT_COLLECTION = "LOT (not exported)"
PREVIEWS = ("front", "three_quarter", "top")
PREVIEW_PX = 512
EDGE_EPS = 0.01                     # 和岛上量楼一样：伸出地界 1 厘米以内不算
FOOT_MAX = 48                       # 占地的外轮廓最多这么多个角（和岛上 poly.FOOT_MAX 一样）
FOOT_OUT = "楼的占地（从上往下看的外轮廓）伸出地界：要整个落在这块地的边界里面"     # 和岛上 buildings.FOOT_OUT 一样
FACES = ("top", "bottom", "front", "back", "left", "right", "side", "sides", "end")
SIDE_SLOTS = ("front", "back", "left", "right", "side")
PATTERNS = ("planks", "tiles", "bricks", "stripes", "checker", "grain", "mottle", "dots", "weave")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")
DEF_DEPTH = 4                       # use 里再 use，最多套这么多层
REPEAT_MAX = 200
SWATCH_DENSITY = 512                # 图案画成小图：每米多少像素（最长边到 SWATCH_MAX）
SWATCH_MAX = 1024


# ---------------------------------------------------------------------------------------------------------------------------------
# 纯数据的部分（不用 Blender 也能导入、能测）
# ---------------------------------------------------------------------------------------------------------------------------------
def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def color_value(v):
    """-> 0xRRGGBB，或 None（看不懂）。不写 = 默认色。"""
    if v is None:
        return DEFAULT_COLOR
    if isinstance(v, str) and len(v) == 7 and v[0] == "#":
        try:
            return int(v[1:], 16)
        except ValueError:
            return None
    if isinstance(v, (list, tuple)) and len(v) == 3 and all(_finite(q) for q in v):
        r, g, b = (int(max(0, min(255, q))) for q in v)
        return (r << 16) | (g << 8) | b
    return None


def recipe_shapes(obj):
    """配方的几种写法 -> 形状的列表（或 None）：{"shapes":[…]}、裸的 [...]、{"kind":"shapes"|"recipe","shapes":{"shapes":[…]}}、{"world":{…}}。"""
    if isinstance(obj, dict) and isinstance(obj.get("world"), dict):
        obj = obj["world"]
    if isinstance(obj, list):
        return obj
    if not isinstance(obj, dict):
        return None
    s = obj.get("shapes")
    if isinstance(s, dict):
        s = s.get("shapes")
    return s if isinstance(s, list) else None


def recipe_defs(obj):
    """配方里的 "defs"（{名字: [形状, …]}）；和 shapes 在同一层（包在 {"kind":"recipe","shapes":{…}} 里的也认）。没写 -> {}。"""
    if isinstance(obj, dict) and isinstance(obj.get("world"), dict):
        obj = obj["world"]
    if not isinstance(obj, dict):
        return {}
    d = obj.get("defs")
    if d is None and isinstance(obj.get("shapes"), dict):
        d = obj["shapes"].get("defs")
    return d if isinstance(d, dict) else ({} if d is None else None)


def _nums(sh, key, n, k, why, default=None, label=None):
    v = sh.get(key, default)
    if not (isinstance(v, (list, tuple)) and len(v) >= n and all(_finite(q) for q in v[:n])):
        why.append("%s（%s）的 %s 要写成 %d 个数" % (label or "第 %d 个形状" % (k + 1), sh.get("type"), key, n))
        return None
    return [float(q) for q in v[:n]]


def _num(sh, key, k, why, default=None, positive=True, label=None):
    v = sh.get(key, default)
    if not _finite(v) or (positive and v <= 0):
        why.append("%s（%s）缺 %s，或它不是一个大于 0 的数" % (label or "第 %d 个形状" % (k + 1), sh.get("type"), key))
        return None
    return float(v)


# --- 皮：材料、颜色、图案、自己的图 -----------------------------------------------------------------------------------------------
PATTERN_TEXT = ('pattern 要写成 {"kind":"planks|tiles|bricks|stripes|checker|grain|mottle|dots|weave","color2":"#rrggbb",'
                '"size":米,"dir":"x|y|z"}（color 是底色，color2、joint、size、long、dir 都可不写）')
IMAGE_TEXT = 'image 要写成 "文件名.png"，或 {"src":"文件名.png","tile":米}（tile 不写：整张图铺满这个面一次；写了：每多少米重复一次）'
PATTERN_SIZE = {"planks": 0.14, "tiles": 0.3, "bricks": 0.24, "stripes": 0.1, "checker": 0.3, "grain": 0.5, "mottle": 0.8, "dots": 0.12, "weave": 0.02}


def _shade(c: int, k: float) -> int:
    r, g, b = (c >> 16) & 255, (c >> 8) & 255, c & 255
    return (int(max(0, min(255, r * k))) << 16) | (int(max(0, min(255, g * k))) << 8) | int(max(0, min(255, b * k)))


def read_pattern(raw, color: int, label: str, why: list):
    """pattern -> {kind, color, color2, joint, size, long, dir} | None（没写）。"""
    if raw is None:
        return None
    if isinstance(raw, str):
        raw = {"kind": raw}
    if not isinstance(raw, dict) or raw.get("kind") not in PATTERNS:
        why.append("%s 的 %s" % (label, PATTERN_TEXT))
        return None
    kind = raw["kind"]
    out = {"kind": kind, "color": color}
    dflt2 = {"tiles": 0xD8D4CC, "bricks": 0xCFC8BC, "stripes": _shade(color, 0.8), "checker": _shade(color, 0.6)}.get(kind, _shade(color, 0.82))
    for key, dv in (("color2", dflt2), ("joint", _shade(color, 0.5))):
        c = color_value(raw.get(key)) if raw.get(key) is not None else dv
        if c is None:
            why.append('%s 的 pattern 的 %s 颜色看不懂（写成 "#f2e2c4" 或 [242, 226, 196]）' % (label, key))
            return None
        out[key] = c
    size, long_ = raw.get("size", PATTERN_SIZE[kind]), raw.get("long", 1.2 if kind == "planks" else 2.0 * float(PATTERN_SIZE[kind]))
    if not _finite(size) or not 0.005 <= size <= 20 or not _finite(long_) or not 0.01 <= long_ <= 40:
        why.append("%s 的 pattern 的 size 要在 0.005 到 20 米之间（long 在 0.01 到 40 米之间）" % label)
        return None
    d = str(raw.get("dir", "x")).lower()
    if d not in ("x", "y", "z"):
        why.append('%s 的 pattern 的 dir 要是 "x"、"y" 或 "z"（木板、条纹顺着哪个方向）' % label)
        return None
    out.update(size=float(size), long=float(long_), dir=d)
    return out


def image_name_ok(name) -> bool:
    """图的文件名：不带路径、不以点开头、只认 png / jpg / webp，最长 80 个字。"""
    if not isinstance(name, str) or not 1 <= len(name) <= 80 or name[0] in ". " or ".." in name:
        return False
    if any(c in '/\\:*?"<>|' or not c.isprintable() for c in name):
        return False
    return name.lower().endswith(IMAGE_EXT)


def read_image(raw, label: str, why: list):
    """image -> {src, tile | None} | None（没写）。"""
    if raw is None:
        return None
    if isinstance(raw, str):
        raw = {"src": raw}
    if not isinstance(raw, dict) or not image_name_ok(raw.get("src")):
        why.append("%s 的 %s" % (label, IMAGE_TEXT))
        return None
    tile = raw.get("tile")
    if tile is not None and (not _finite(tile) or not 0.01 <= tile <= 50):
        why.append("%s 的 image 的 tile 要在 0.01 到 50 米之间（不写 = 整张铺满这个面）" % label)
        return None
    return {"src": raw["src"], "tile": float(tile) if tile is not None else None}


def read_skin(raw: dict, base, label: str, why: list) -> dict | None:
    """一个形状（或它的一个面、room 的一面墙）的皮：{mat, color, pattern, image}；base 是上一层的皮（面从形状继承、形状自己从默认）。"""
    base = base or {"mat": "paint", "color": DEFAULT_COLOR, "pattern": None, "image": None}
    mat = str(raw.get("material", base["mat"])).lower()
    if mat not in MATERIALS:
        why.append("%s 的 material 要是这几种之一：%s" % (label, "、".join(MATERIALS)))
        return None
    c = color_value(raw.get("color")) if "color" in raw else base["color"]
    if c is None:
        why.append('%s 的颜色看不懂（写成 "#f2e2c4" 或 [242, 226, 196]）' % label)
        return None
    pat = read_pattern(raw.get("pattern"), c, label, why) if "pattern" in raw else (dict(base["pattern"], color=c) if base.get("pattern") else None)
    img = read_image(raw.get("image"), label, why) if "image" in raw else base.get("image")
    if ("pattern" in raw and raw["pattern"] is not None and pat is None) or ("image" in raw and raw["image"] is not None and img is None):
        return None
    if "pattern" in raw and raw["pattern"] is None:
        pat = None
    if "image" in raw and raw["image"] is None:
        img = None
    if pat is not None and img is not None:
        why.append("%s 同时写了 pattern 和 image：一个面只能用一样" % label)
        return None
    return {"mat": mat, "color": c, "pattern": pat, "image": img}


def read_faces(raw, base: dict, label: str, why: list) -> dict:
    """faces：{"top": {皮}, "sides": {皮}, …} -> {面: 皮}。"""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        why.append('%s 的 faces 要写成 {"top":{"color":"#…"},"front":{"image":"…"}}（面：%s）' % (label, "、".join(FACES)))
        return {}
    out = {}
    for name, v in raw.items():
        if name not in FACES:
            why.append("%s 的 faces 里的 %s 不认识：面写 %s" % (label, str(name)[:12], "、".join(FACES)))
            continue
        if not isinstance(v, dict):
            why.append('%s 的 faces.%s 要写成 {"color":…,"material":…,"pattern":…,"image":…}' % (label, name))
            continue
        s = read_skin(v, base, "%s 的 %s 面" % (label, name), why)
        if s is not None:
            out[name] = s
    return out


def skin_of(s: dict, slot: str) -> dict:
    """形状的这一面用哪张皮：faces 里写了这一面的 > sides（四个侧面 / 圆的侧面）> 形状自己的。"""
    f = s.get("faces") or {}
    if slot in f:
        return f[slot]
    if slot in SIDE_SLOTS and "sides" in f:
        return f["sides"]
    return s["skin"]


def shape_skins(s: dict) -> list:
    """这个形状用到的每一张皮（形状自己的 + faces 的）。"""
    return [s["skin"]] + list((s.get("faces") or {}).values())


# --- 摆放：pos / rot、use 套出来的外层、repeat --------------------------------------------------------------------------------------
I3 = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
A_ID = (I3, (0.0, 0.0, 0.0))


def _rot(axis, a):
    c, s = math.cos(a), math.sin(a)
    if axis == "x":
        return ((1, 0, 0), (0, c, -s), (0, s, c))
    if axis == "y":
        return ((c, 0, s), (0, 1, 0), (-s, 0, c))
    return ((c, -s, 0), (s, c, 0), (0, 0, 1))


def _mm(A, B):
    return tuple(tuple(sum(A[i][k] * B[k][j] for k in range(3)) for j in range(3)) for i in range(3))


def _mv(A, v):
    return (A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2], A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2], A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2])


def euler(rot) -> tuple:
    """rot [x, y, z]（度）-> 3×3：绕 y、再绕 x、再绕 z（岛的 kit：at(x, y, z, ry, rx, rz)）。"""
    rx, ry, rz = (math.radians(a) for a in rot)
    return _mm(_mm(_rot("y", ry), _rot("x", rx)), _rot("z", rz))


def a_mul(A, B):
    """仿射 (R, t) 相乘：先 B 后 A。"""
    if A is A_ID:
        return B
    if B is A_ID:
        return A
    return (_mm(A[0], B[0]), tuple(a + b for a, b in zip(_mv(A[0], B[1]), A[1])))


def a_apply(A, p):
    q = _mv(A[0], p)
    return (q[0] + A[1][0], q[1] + A[1][1], q[2] + A[1][2])


def _inv_t(R):
    """3×3 的逆的转置（法线跟着不等比的缩放走）。"""
    a, b, c = R[0]
    d, e, f = R[1]
    g, h, i = R[2]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-12:
        return R
    inv = ((e * i - f * h, c * h - b * i, b * f - c * e), (f * g - d * i, a * i - c * g, c * d - a * f), (d * h - e * g, b * g - a * h, a * e - b * d))
    return tuple(tuple(inv[j][k] / det for j in range(3)) for k in range(3))


def read_repeat(raw, label: str, why: list) -> list:
    """repeat {"n", "step": [dx, dy, dz], "turn": 度, "about": [x, z]} -> 每一份的外层仿射；没写 -> [不动]。"""
    if raw is None:
        return [A_ID]
    if not isinstance(raw, dict) or not _finite(raw.get("n")) or not 1 <= raw["n"] <= REPEAT_MAX:
        why.append('%s 的 repeat 要写成 {"n":份数 1–%d,"step":[x,y,z],"turn":度,"about":[x,z]}（step 每份挪多少米，turn 每份绕 about 转多少度）' % (label, REPEAT_MAX))
        return [A_ID]
    step, turn, about = raw.get("step", [0, 0, 0]), raw.get("turn", 0), raw.get("about", [0, 0])
    if not (isinstance(step, (list, tuple)) and len(step) == 3 and all(_finite(q) for q in step)) or not _finite(turn) or \
            not (isinstance(about, (list, tuple)) and len(about) == 2 and all(_finite(q) for q in about)):
        why.append("%s 的 repeat 的 step 要写 3 个数、turn 一个数、about 两个数 [x, z]" % label)
        return [A_ID]
    out = []
    for k in range(int(raw["n"])):
        R = _rot("y", math.radians(float(turn) * k))
        mv = (step[0] * k, step[1] * k, step[2] * k)
        c = (float(about[0]), 0.0, float(about[1]))
        t = _mv(R, (mv[0] - c[0], mv[1], mv[2] - c[2]))
        out.append((R, (t[0] + c[0], t[1], t[2] + c[2])))
    return out


def _use_affine(u: dict, label: str, why: list):
    """use 自己的 pos、rot、scale -> 仿射。"""
    pos = u.get("pos", [0, 0, 0])
    rot = u.get("rot", [0, 0, 0])
    sc = u.get("scale", 1)
    if not (isinstance(pos, (list, tuple)) and len(pos) == 3 and all(_finite(q) for q in pos)) or \
            not (isinstance(rot, (list, tuple)) and len(rot) == 3 and all(_finite(q) for q in rot)):
        why.append("%s 的 pos、rot 都要写成 3 个数" % label)
        return None
    if _finite(sc):
        sc = [sc, sc, sc]
    if not (isinstance(sc, (list, tuple)) and len(sc) == 3 and all(_finite(q) and 0.01 <= abs(q) <= 100 for q in sc)):
        why.append("%s 的 scale 要是一个数或 3 个数（0.01 到 100，负的是镜像）" % label)
        return None
    R = _mm(euler(rot), ((sc[0], 0, 0), (0, sc[1], 0), (0, 0, sc[2])))
    return (R, (float(pos[0]), float(pos[1]), float(pos[2])))


def expand(shapes, defs, limit: int, why: list) -> list:
    """shapes（里面可以有 {"use": 名字, …} 和 repeat）-> [(原样的形状, 怎么称呼, 外层仿射, 名字换色)]，按顺序；套 DEF_DEPTH 层以内。"""
    out = []

    def go(items, A, depth, path, colors):
        for k, sh in enumerate(items):
            if len(out) > limit or len(why) >= 5:
                return
            here = ("第 %d 个形状" % (k + 1)) if not path else "%s的第 %d 件" % (path, k + 1)
            if not isinstance(sh, dict):
                why.append("%s要写成 {\"type\":…} 或 {\"use\":…}" % here)
                continue
            reps = read_repeat(sh.get("repeat"), here, why)
            if "use" in sh:
                name = sh["use"]
                if not isinstance(name, str) or not isinstance(defs, dict) or not isinstance(defs.get(name), list):
                    why.append("%s 的 use 写的「%s」在 defs 里没有（defs 写成 {\"名字\": [形状, …]}）" % (here, str(name)[:20]))
                    continue
                if depth >= DEF_DEPTH:
                    why.append("%s：use 套 use 最多 %d 层（是不是自己套了自己）" % (here, DEF_DEPTH))
                    continue
                U = _use_affine(sh, here, why)
                if U is None:
                    continue
                cmap = dict(colors)
                for nm, cv in (sh.get("colors") or {}).items() if isinstance(sh.get("colors"), dict) else ():
                    c = color_value(cv)
                    if c is None:
                        why.append("%s 的 colors 里「%s」的颜色看不懂" % (here, str(nm)[:12]))
                    else:
                        cmap.setdefault(str(nm), c)
                for Rk in reps:
                    go(defs[name], a_mul(A, a_mul(Rk, U)), depth + 1, "%s（%s）" % (here, name[:12]), cmap)
                continue
            for Rk in reps:
                out.append((sh, here, a_mul(A, Rk), colors))
    go(shapes, A_ID, 0, "", {})
    return out


# --- 一个形状 ---------------------------------------------------------------------------------------------------------------------
def check_shape(sh, k: int, label: str | None = None) -> tuple:
    """一个形状 -> (问题列表, 读好的形状 | None)。读好的：{type, mat, color, skin, faces, pos, rot, seg, 尺寸…}。"""
    why = []
    lb = label or "第 %d 个形状" % (k + 1)
    if not isinstance(sh, dict) or sh.get("type") not in TYPES:
        return ["%s的 type 要是这几种之一：%s" % (lb, "、".join(TYPES))], None
    t = sh["type"]
    mat = str(sh.get("material", "paint")).lower()
    if mat not in MATERIALS:
        return ["%s的 material 要是这几种之一：%s" % (lb, "、".join(MATERIALS))], None
    c = color_value(sh.get("color"))
    if c is None:
        return ["%s的颜色看不懂（写成 \"#f2e2c4\" 或 [242, 226, 196]）" % lb], None
    skin = read_skin(dict(sh, material=mat), None, lb, why)
    if skin is None:
        return why[:5] or ["%s的皮看不懂" % lb], None
    out = {"type": t, "mat": mat, "color": c, "skin": skin, "pos": _nums(sh, "pos", 3, k, why, [0, 0, 0], lb), "rot": _nums(sh, "rot", 3, k, why, [0, 0, 0], lb)}
    out["faces"] = read_faces(sh.get("faces"), skin, lb, why)
    seg = sh.get("seg", {"lathe": 24, "sweep": 8, "soft": 3}.get(t, 18))
    lo, hi, dflt = {"lathe": (3, 64, 24), "sweep": (3, 32, 8), "soft": (1, 8, 3)}.get(t, (3, 48, 18))
    out["seg"] = int(max(lo, min(hi, seg))) if _finite(seg) else dflt
    if t in ("box", "wedge", "pyramid", "gable", "soft"):
        size = _nums(sh, "size", 3, k, why, label=lb)
        if size is not None and min(size) <= 0:
            why.append("%s（%s）的 size 三个数都要大于 0" % (lb, t))
        out["size"] = size
        if t == "soft":
            pl = sh.get("plump", 0.5)
            out["plump"] = float(max(0.0, min(1.0, pl))) if _finite(pl) else 0.5
    elif t in ("cylinder", "cone"):
        out["r"], out["h"] = _num(sh, "r", k, why, label=lb), _num(sh, "h", k, why, label=lb)
        r2 = sh.get("r2", out["r"]) if t == "cylinder" else 0.0
        if not _finite(r2) or r2 < 0:
            why.append("%s（cylinder）的 r2 要是一个不小于 0 的数" % lb)
            r2 = 0.0
        out["r2"] = float(r2)
    elif t in ("sphere", "dome"):
        if isinstance(sh.get("size"), (list, tuple)):
            size = _nums(sh, "size", 3, k, why, label=lb)
            if size is not None and min(size) <= 0:
                why.append("%s（%s）的 size 三个数都要大于 0" % (lb, t))
            out["radii"] = size
        else:
            r = _num(sh, "r", k, why, label=lb)
            out["radii"] = [r, r, r] if r is not None else None
    elif t == "prism":
        pts = sh.get("points")
        if not (isinstance(pts, list) and len(pts) >= 3 and all(isinstance(q, (list, tuple)) and len(q) == 2 and all(_finite(x) for x in q) for q in pts)):
            why.append("%s（prism）的 points 要是至少三个 [x, z]" % lb)
        else:
            out["points"] = [(float(a), float(b)) for a, b in pts[:64]]
        out["h"] = _num(sh, "h", k, why, label=lb)
    elif t == "lathe":
        pr = sh.get("profile")
        if not (isinstance(pr, list) and 2 <= len(pr) <= 64 and all(isinstance(q, (list, tuple)) and len(q) == 2 and all(_finite(x) for x in q) and q[0] >= 0 for q in pr)):
            why.append("%s（lathe）的 profile 要是 2 到 64 个 [半径, 高]（从下往上，半径不小于 0）" % lb)
        else:
            out["profile"] = [(float(a), float(b)) for a, b in pr]
        out["open"] = sh.get("open") is True
    elif t == "sweep":
        path = sh.get("path")
        if not (isinstance(path, list) and 2 <= len(path) <= 128 and all(isinstance(q, (list, tuple)) and len(q) == 3 and all(_finite(x) for x in q) for q in path)):
            why.append("%s（sweep）的 path 要是 2 到 128 个 [x, y, z]（截面沿着它走）" % lb)
        else:
            out["path"] = [(float(a), float(b), float(c)) for a, b, c in path]
            if any(math.dist(p, q) < 1e-4 for p, q in zip(out["path"], out["path"][1:])):
                why.append("%s（sweep）的 path 里有两个挨着的点重合了" % lb)
        sec = sh.get("section")
        if sec is None:
            out["r"] = _num(sh, "r", k, why, label=lb)
            out["section"] = None
        elif isinstance(sec, list) and 3 <= len(sec) <= 32 and all(isinstance(q, (list, tuple)) and len(q) == 2 and all(_finite(x) for x in q) for q in sec):
            out["section"] = [(float(a), float(b)) for a, b in sec]
        else:
            why.append("%s（sweep）写 r（圆管的半径），或 section：3 到 32 个 [横, 竖]（截面的轮廓，米）" % lb)
        out["closed"] = sh.get("closed") is True
    if t in ("box", "cylinder") and sh.get("bevel") is not None:
        bv, bs = sh.get("bevel"), sh.get("bevel_seg", 1)
        if not _finite(bv) or bv < 0 or not _finite(bs):
            why.append("%s（%s）的 bevel 要是一个不小于 0 的数（倒角半径，米），bevel_seg 1–3" % (lb, t))
        else:
            out["bevel"], out["bevel_seg"] = float(bv), int(max(1, min(3, bs)))
    elif sh.get("bevel") is not None:
        why.append("%s（%s）不能写 bevel：只有 box 和 cylinder 能倒角（圆的东西用 lathe，软的用 soft）" % (lb, t))
    if sh.get("name") is not None:
        out["name"] = _name_text(sh["name"], 16)
    return why, (None if why else out)


def _name_text(text, n: int) -> str:
    return "".join(c for c in str(text) if c.isprintable() and c not in "「」").strip()[:n]


def _read_list(shapes, defs, limits: dict) -> tuple:
    """形状清单（可带 use / repeat）-> (问题, 读好的形状)。每个读好的带 label（回执里怎么称呼它）和 T（use 套出来的外层）。"""
    why = []
    items = expand(shapes, defs, int(limits["shapes"]), why)
    if len(items) > limits["shapes"]:
        return ["配方展开以后（use、repeat 都算）超过 %d 个形状" % limits["shapes"]], []
    out = []
    for k, (sh, here, A, colors) in enumerate(items):
        if len(why) >= 5:
            break
        w, s = check_shape(sh, k, here)
        why += w
        if s is None:
            continue
        name = s.get("name")
        if name and name in colors:
            s["color"] = colors[name]
            s["skin"] = dict(s["skin"], color=colors[name], pattern=dict(s["skin"]["pattern"], color=colors[name]) if s["skin"]["pattern"] else None)
        if A is not A_ID:
            s["T"] = A
        s["label"] = "%s：%s%s" % (here.replace("个形状", "个"), s["type"], "「%s」" % name if name else "")
        out.append(s)
    return why[:5], out


def read_recipe(obj, limits: dict) -> tuple:
    """配方 -> (问题列表, 读好的形状列表)。只读数据，什么都不执行。defs + use 在这里展开（展开以后的个数算进上限）。"""
    raw = json.dumps(obj, ensure_ascii=False)
    if len(raw.encode("utf-8")) > limits["shapes_json_kb"] * 1024:
        return ["配方有 %d KB，最多 %d KB" % (len(raw.encode("utf-8")) // 1024, limits["shapes_json_kb"])], []
    shapes = recipe_shapes(obj)
    if shapes is None:
        return ['配方要写成 {"shapes": [形状, …]}'], []
    if not shapes:
        return ["配方里一个形状都没有"], []
    defs = recipe_defs(obj)
    if defs is None:
        return ['defs 要写成 {"名字": [形状, …]}（shapes 里用 {"use":"名字","pos":[x,y,z]} 放）'], []
    if len(shapes) > limits["shapes"]:
        return ["配方里有 %d 个形状，最多 %d 个" % (len(shapes), limits["shapes"])], []
    return _read_list(shapes, defs, limits)


# --- geometry in the island's frame: x right, y up, z towards the lot's front (the door); origin = the lot's middle on its bed ------
def _ring(rx, rz, y, seg):
    return [(math.cos(2 * math.pi * i / seg) * rx, y, math.sin(2 * math.pi * i / seg) * rz) for i in range(seg)]


def _norm(v):
    L = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return (v[0] / L, v[1] / L, v[2] / L) if L > 1e-12 else (0.0, 1.0, 0.0)


def _cross3(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _newell(V, f):
    n = [0.0, 0.0, 0.0]
    for i in range(len(f)):
        a, b = V[f[i]], V[f[(i + 1) % len(f)]]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    return _norm(n)


def _slot_by_normal(n, boxy: bool) -> str:
    if n[1] > 0.7:
        return "top"
    if n[1] < -0.7:
        return "bottom"
    if not boxy:
        return "side"
    return ("right" if n[0] > 0 else "left") if abs(n[0]) >= abs(n[2]) else ("front" if n[2] > 0 else "back")


def _slots_outward(V, F, boxy: bool) -> list:
    """每个面叫什么（top / bottom / front …）：按它朝外的方向（凸的形状：面心离形状中心的方向定朝外）。"""
    cx, cy, cz = (sum(p[i] for p in V) / len(V) for i in range(3))
    out = []
    for f in F:
        n = _newell(V, f)
        c = [sum(V[i][j] for i in f) / len(f) for j in range(3)]
        if _dot(n, (c[0] - cx, c[1] - cy, c[2] - cz)) < 0:
            n = (-n[0], -n[1], -n[2])
        out.append(_slot_by_normal(n, boxy))
    return out


AXIS_SLOTS = {(0, 1): "right", (0, -1): "left", (1, 1): "top", (1, -1): "bottom", (2, 1): "front", (2, -1): "back"}


def _axis_vals(h: float, r: float, k: int, m: int) -> list:
    """一根轴上的格线：-h…h；倒角那一圈按角度均分（每 45° k 段），中间平的一段分 m 格。"""
    if r <= 1e-9:
        return [-h + 2 * h * i / m for i in range(m + 1)]
    inner = max(0.0, h - r)
    band = [inner + r * math.tan(math.radians(45.0 * j / k)) for j in range(k + 1)]
    mid = [-inner + 2 * inner * i / m for i in range(m + 1)] if inner > 1e-9 else [0.0]
    return sorted({round(v, 9) for v in [-b for b in band] + mid + band})


def rounded_box(hx, hy, hz, rx, ry, rz, k: int = 1, m: int = 1) -> tuple:
    """圆角的盒子，中心在原点：半宽 h*，每根轴的圆角半径 r*（都 > 0，或都是 0 = 尖角），倒角每 45° k 段，平的一段 m 格。
    -> (verts, faces, slots, normals)；法线是真圆角的法线（导出时照它，不会糊成一团）。"""
    H, Rr = (hx, hy, hz), (rx, ry, rz)
    sharp = min(Rr) <= 1e-9
    grids = [_axis_vals(H[i], 0.0 if sharp else Rr[i], k, m) for i in range(3)]
    V, N, F, slots, at = [], [], [], [], {}

    def vert(p):
        if sharp:
            q, n = p, None
        else:
            c = [max(-(H[i] - Rr[i]), min(H[i] - Rr[i], p[i])) for i in range(3)]
            d = [(p[i] - c[i]) / Rr[i] for i in range(3)]
            L = math.sqrt(sum(x * x for x in d))
            if L < 1e-12:
                return None
            u = [x / L for x in d]
            q = tuple(c[i] + Rr[i] * u[i] for i in range(3))
            n = _norm((u[0] / Rr[0], u[1] / Rr[1], u[2] / Rr[2]))
        key = (round(q[0], 6), round(q[1], 6), round(q[2], 6))
        j = at.get(key)
        if j is None:
            j = at[key] = len(V)
            V.append(q)
            N.append(n)
        return j
    for a in range(3):
        b, c = (a + 1) % 3, (a + 2) % 3
        for sgn in (1, -1):
            gb, gc = grids[b], grids[c]
            ids = []
            for vb in gb:
                row = []
                for vc in gc:
                    p = [0.0, 0.0, 0.0]
                    p[a], p[b], p[c] = sgn * H[a], vb, vc
                    row.append(vert(p))
                ids.append(row)
            for i in range(len(gb) - 1):
                for j in range(len(gc) - 1):
                    q = (ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1])
                    if sgn < 0:
                        q = q[::-1]
                    q2 = []
                    for x in q:
                        if x is not None and x not in q2:
                            q2.append(x)
                    if len(q2) >= 3:
                        F.append(tuple(q2))
                        slots.append(AXIS_SLOTS[(a, sgn)])
    return V, F, slots, (None if sharp else N)


def _lathe(prof, seg: int, caps: bool) -> tuple:
    """旋转体：prof [(半径, 高)…] 从下往上转一圈 -> (verts, faces, smooth, sharp, slots)。轮廓拐得急（> 35°）的那一圈是硬边。"""
    V, F, S, slots, sharp, rings = [], [], [], [], set(), []
    for r, y in prof:
        if r > 1e-6:
            rings.append(list(range(len(V), len(V) + seg)))
            V += _ring(r, r, y, seg)
        else:
            rings.append([len(V)])
            V.append((0.0, y, 0.0))
    for i in range(len(prof) - 1):
        lo, hi = rings[i], rings[i + 1]
        (r0, y0), (r1, y1) = prof[i], prof[i + 1]
        dr, dy = r1 - r0, y1 - y0
        n = _norm((dy, -dr, 0.0))
        slot = "top" if n[1] > 0.9 else ("bottom" if n[1] < -0.9 else "side")      # (花瓶往外撇的那一圈也是 side：差不多平的才算顶、底)
        for a in range(seg):
            b = (a + 1) % seg
            if len(lo) == 1 and len(hi) == 1:
                break
            if len(lo) == 1:
                F.append((lo[0], hi[b], hi[a]))
            elif len(hi) == 1:
                F.append((lo[a], lo[b], hi[0]))
            else:
                F.append((lo[a], lo[b], hi[b], hi[a]))
            S.append(True)
            slots.append(slot)
    for i in range(1, len(prof) - 1):
        (r0, y0), (r1, y1), (r2, y2) = prof[i - 1], prof[i], prof[i + 1]
        u, w = _norm((r1 - r0, y1 - y0, 0)), _norm((r2 - r1, y2 - y1, 0))
        if _dot(u, w) < math.cos(math.radians(35)) and len(rings[i]) > 1:
            sharp |= {(rings[i][a], rings[i][(a + 1) % seg]) for a in range(seg)}
    if caps:
        for i, slot in ((0, "bottom"), (len(prof) - 1, "top")):
            if len(rings[i]) > 1:
                F.append(tuple(rings[i]) if slot == "top" else tuple(reversed(rings[i])))
                S.append(False)
                slots.append(slot)
                sharp |= {(rings[i][a], rings[i][(a + 1) % seg]) for a in range(seg)}
    return V, F, S, sharp, slots


def _rotate(v, axis, ang):
    """Rodrigues：v 绕单位轴 axis 转 ang 弧度。"""
    c, s = math.cos(ang), math.sin(ang)
    k = axis
    kv = _cross3(k, v)
    kd = _dot(k, v)
    return (v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c))


def _sweep(path, section, closed: bool, round_: bool) -> tuple:
    """截面沿路径走（平行移动的标架，拐角处斜接）-> (verts, faces, smooth, sharp, slots)。"""
    P = list(path)
    n = len(P)
    if closed and n >= 3 and math.dist(P[0], P[-1]) < 1e-4:
        P, n = P[:-1], n - 1
    closed = closed and n >= 3
    segs = n if closed else n - 1
    D = [_norm(tuple(P[(j + 1) % n][i] - P[j][i] for i in range(3))) for j in range(segs)]
    up = (0.0, 1.0, 0.0) if abs(D[0][1]) < 0.95 else (1.0, 0.0, 0.0)
    S0 = _norm(_cross3(D[0], up))
    frames = [(S0, _cross3(S0, D[0]))]
    for j in range(1, segs):
        ax = _cross3(D[j - 1], D[j])
        L = math.sqrt(_dot(ax, ax))
        Sx, Ux = frames[-1]
        if L > 1e-9:
            ang = math.atan2(L, _dot(D[j - 1], D[j]))
            ax = (ax[0] / L, ax[1] / L, ax[2] / L)
            Sx, Ux = _rotate(Sx, ax, ang), _rotate(Ux, ax, ang)
        frames.append((Sx, Ux))
    m = len(section)
    V, F, S, sharp, slots, rings = [], [], [], set(), [], []
    for i in range(n):
        if not closed and i == 0:
            jin, jout = 0, 0
        elif not closed and i == n - 1:
            jin, jout = segs - 1, segs - 1
        else:
            jin, jout = (i - 1) % segs, i % segs
        Sx, Ux = frames[jin]
        d_in, d_out = D[jin], D[jout]
        M = _norm(tuple(a + b for a, b in zip(d_in, d_out)))
        den = _dot(d_in, M)
        ring = []
        for a, b in section:
            o = tuple(a * Sx[q] + b * Ux[q] for q in range(3))
            t = 0.0 if jin == jout else -_dot(o, M) / max(0.2, den)
            ring.append(len(V))
            V.append(tuple(P[i][q] + o[q] + d_in[q] * t for q in range(3)))
        rings.append(ring)
        if jin != jout and _dot(d_in, d_out) < math.cos(math.radians(35)):
            sharp |= {(ring[a], ring[(a + 1) % m]) for a in range(m)}
    for j in range(segs):
        r0, r1 = rings[j], rings[(j + 1) % n]
        for a in range(m):
            b = (a + 1) % m
            F.append((r0[a], r0[b], r1[b], r1[a]))
            S.append(True)
            slots.append("side")
    if not round_:
        for a in range(m):
            p0, p1, p2 = section[a - 1], section[a], section[(a + 1) % m]
            u, w = _norm((p1[0] - p0[0], p1[1] - p0[1], 0)), _norm((p2[0] - p1[0], p2[1] - p1[1], 0))
            if _dot(u, w) < math.cos(math.radians(35)):
                for j in range(segs):
                    sharp.add((rings[j][a], rings[(j + 1) % n][a]))
    if not closed:
        for ring in (rings[0], rings[-1]):
            F.append(tuple(ring))
            S.append(False)
            slots.append("end")
            sharp |= {(ring[a], ring[(a + 1) % m]) for a in range(m)}
    return V, F, S, sharp, slots


def _soft(w, h, d, plump: float, m: int) -> tuple:
    """软垫：圆角很大的方块，中间鼓、四边薄（照官方 rb_core.pillow 的意思）。-> (verts, faces, slots)，底面在 y = 0。"""
    hx, hy, hz = w / 2, h / 2, d / 2
    V, F, slots, _N = rounded_box(hx, hy, hz, 0.35 * hx, 0.9 * hy, 0.35 * hz, 2, m + 1)
    out = []
    for x, y, z in V:
        e = max(abs(x) / hx, abs(z) / hz)
        k = 1.0 - plump * 0.55 * e ** 3
        s = 1.0 - 0.04 * plump * (abs(y) / hy) ** 2
        out.append((x * s, y * k, z * s))
    y0 = min(p[1] for p in out)
    return [(x, y - y0, z) for x, y, z in out], F, slots


def shape_mesh(s: dict) -> dict:
    """一个形状 -> {V, F, S（每个面平滑不平滑）, sharp（硬边）, slot（每个面叫什么）, N（每个点的法线 | None = Blender 自己算）}。
    老的九种和岛上的 build_bl.py 一样（pos 是形状底面的正中）；新的四种（倒角、lathe、sweep、soft）见各自的函数。"""
    t, V, F, S, sharp, N = s["type"], [], [], [], set(), None
    slots = None

    def add(face, smooth=False):
        F.append(tuple(face))
        S.append(smooth)
    if t == "box" and s.get("bevel", 0) > 1e-6:
        w, h, d = s["size"]
        r = min(s["bevel"], 0.45 * min(w, h, d))
        V, F, slots, N = rounded_box(w / 2, h / 2, d / 2, r, r, r, s.get("bevel_seg", 1), 1)
        V = [(x, y + h / 2, z) for x, y, z in V]
        S = [True] * len(F)                             # (真圆角的法线在 N 里：平的面法线也照它，不会糊)
    elif t == "box":
        w, h, d = s["size"]
        for y in (0.0, h):
            V += [(-w / 2, y, -d / 2), (w / 2, y, -d / 2), (w / 2, y, d / 2), (-w / 2, y, d / 2)]
        for f in ((0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
            add(f)
        slots = ["bottom", "top", "back", "right", "front", "left"]
    elif t == "cylinder" and s.get("bevel", 0) > 1e-6:
        r, r2, h, n = s["r"], s["r2"], s["h"], s["seg"]
        b = min(s["bevel"], 0.45 * min(r, h), 0.45 * r2 if r2 > 1e-6 else 1e9)
        k = 2 * s.get("bevel_seg", 1)
        prof = [(0.0, 0.0)] + [(r - b + b * math.sin(math.pi / 2 * i / k), b - b * math.cos(math.pi / 2 * i / k)) for i in range(k + 1)]
        if r2 > 1e-6:
            prof += [(r2 - b + b * math.cos(math.pi / 2 * i / k), h - b + b * math.sin(math.pi / 2 * i / k)) for i in range(k + 1)] + [(0.0, h)]
        else:
            prof += [(0.0, h)]
        V, F, S, sharp, slots = _lathe(prof, n, False)
    elif t in ("cylinder", "cone"):
        r, r2, h, n = s["r"], s["r2"], s["h"], s["seg"]
        V += _ring(r, r, 0.0, n)
        if r2 > 1e-6:
            V += _ring(r2, r2, h, n)
            for i in range(n):
                j = (i + 1) % n
                add((i, j, n + j, n + i), True)
            add(tuple(range(2 * n - 1, n - 1, -1)))
            sharp |= {(n + i, n + (i + 1) % n) for i in range(n)}
        else:
            V.append((0.0, h, 0.0))
            for i in range(n):
                add((i, (i + 1) % n, n), True)
        add(tuple(range(n)))
        sharp |= {(i, (i + 1) % n) for i in range(n)}
    elif t in ("sphere", "dome"):
        rx, ry, rz = s["radii"]
        n = s["seg"]
        rows = 5 if t == "dome" else 10
        a0 = 0.0 if t == "dome" else -math.pi / 2
        rings = []
        for i in range(rows + 1):
            a = a0 + (math.pi / 2 - a0) * i / rows
            y = (math.sin(a) * ry) + (0.0 if t == "dome" else ry)
            c = math.cos(a)
            if c < 1e-6:
                rings.append([len(V)])
                V.append((0.0, y, 0.0))
            else:
                rings.append(list(range(len(V), len(V) + n)))
                V += _ring(c * rx, c * rz, y, n)
        for lo, hi in zip(rings, rings[1:]):
            for i in range(n):
                j = (i + 1) % n
                if len(lo) == 1:
                    add((lo[0], hi[j], hi[i]), True)
                elif len(hi) == 1:
                    add((lo[i], lo[j], hi[0]), True)
                else:
                    add((lo[i], lo[j], hi[j], hi[i]), True)
        if t == "dome":
            add(tuple(rings[0]))
            sharp |= {(rings[0][i], rings[0][(i + 1) % n]) for i in range(n)}
    elif t == "wedge":                                   # a ramp: its high edge at the back (z < 0)
        w, h, d = s["size"]
        V += [(-w / 2, 0, d / 2), (w / 2, 0, d / 2), (w / 2, 0, -d / 2), (-w / 2, 0, -d / 2), (-w / 2, h, -d / 2), (w / 2, h, -d / 2)]
        for f in ((0, 1, 5, 4), (2, 3, 4, 5), (3, 2, 1, 0), (0, 4, 3), (1, 2, 5)):
            add(f)
    elif t == "pyramid":
        w, h, d = s["size"]
        V += [(-w / 2, 0, d / 2), (w / 2, 0, d / 2), (w / 2, 0, -d / 2), (-w / 2, 0, -d / 2), (0, h, 0)]
        for f in ((0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (3, 2, 1, 0)):
            add(f)
    elif t == "gable":                                   # a roof: the ridge runs along x
        w, h, d = s["size"]
        V += [(-w / 2, 0, d / 2), (w / 2, 0, d / 2), (w / 2, 0, -d / 2), (-w / 2, 0, -d / 2), (-w / 2, h, 0), (w / 2, h, 0)]
        for f in ((0, 1, 5, 4), (2, 3, 4, 5), (3, 0, 4), (1, 2, 5), (3, 2, 1, 0)):
            add(f)
    elif t == "prism":                                   # a flat outline [[x, z], …] raised by h
        pts, h = s["points"], s["h"]
        n = len(pts)
        V += [(x, 0.0, z) for x, z in pts] + [(x, h, z) for x, z in pts]
        for i in range(n):
            j = (i + 1) % n
            add((i, j, n + j, n + i))
        add(tuple(range(n)))
        add(tuple(range(2 * n - 1, n - 1, -1)))
    elif t == "lathe":
        V, F, S, sharp, slots = _lathe(s["profile"], s["seg"], not s.get("open"))
    elif t == "sweep":
        sec = s["section"] or [(math.cos(2 * math.pi * i / s["seg"]) * s["r"], math.sin(2 * math.pi * i / s["seg"]) * s["r"]) for i in range(s["seg"])]
        V, F, S, sharp, slots = _sweep(s["path"], sec, s.get("closed", False), s["section"] is None)
    elif t == "soft":
        w, h, d = s["size"]
        V, F, slots = _soft(w, h, d, s.get("plump", 0.5), s["seg"])
        S = [True] * len(F)
    if slots is None:
        slots = _slots_outward(V, F, t in ("wedge", "pyramid", "gable", "prism"))
    return {"V": V, "F": F, "S": S, "sharp": sharp, "slot": slots, "N": N}


def shape_geometry(s: dict) -> tuple:
    """-> (verts, faces, smooth: [bool per face], sharp: set of (i, j) edges)。和岛上的 build_bl.py 一样的形状：pos 是形状底面的正中。"""
    g = shape_mesh(s)
    return g["V"], g["F"], g["S"], g["sharp"]


def shape_affine(s: dict):
    """形状自己的 rot、pos，再套 use / repeat 的外层 T -> 仿射。"""
    A = (euler(s["rot"]), tuple(s["pos"]))
    return a_mul(s["T"], A) if s.get("T") else A


def placed(s: dict, V=None) -> list:
    """The shape's corners where they stand on the lot: turned about y, then x, then z (岛的 kit：at(x, y, z, ry, rx, rz)), then moved to pos;
    then the outer placement of a use / repeat."""
    V = shape_geometry(s)[0] if V is None else V
    A = shape_affine(s)
    return [a_apply(A, p) for p in V]


def placed_normals(s: dict, N) -> list:
    R = _inv_t(shape_affine(s)[0])
    return [_norm(_mv(R, n)) for n in N]


def tris_of(s: dict) -> int:
    _, F, _, _ = shape_geometry(s)
    return sum(len(f) - 2 for f in F)


# --- 图案画成能平铺的小图：一个周期多大、多少像素（纯数，量贴图用；画在 Blender 那边用 numpy） ---------------------------------------
def pattern_period(p: dict) -> tuple:
    """一个图案重复一次的大小（u 顺着 dir，v 横着），米。"""
    k, s, L = p["kind"], p["size"], p["long"]
    return {"planks": (L, 4 * s), "tiles": (s, s), "bricks": (s, 0.84 * s), "stripes": (2 * s, 2 * s), "checker": (2 * s, 2 * s),
            "grain": (4 * s, s), "mottle": (s, s), "dots": (s, s), "weave": (s, s)}[k]


def swatch_px(p: dict) -> tuple:
    """图案的小图多少像素（宽, 高）：每米 SWATCH_DENSITY，16 的倍数，每边 32 到 SWATCH_MAX。"""
    pu, pv = pattern_period(p)

    def side(m):
        return int(max(32, min(SWATCH_MAX, round(m * SWATCH_DENSITY / 16) * 16)))
    w, h = side(pu), side(pv)
    k = min(1.0, SWATCH_MAX / max(w, h))
    return max(32, int(w * k) // 16 * 16), max(32, int(h * k) // 16 * 16)


def pattern_key(p: dict) -> str:
    return "%s_%06x_%06x_%06x_%g_%g" % (p["kind"], p["color"], p["color2"], p["joint"], p["size"], p["long"])


def recipe_textures(shapes) -> dict:
    """配方用到的图：{"patterns": {key: (w, h, 图案)}, "images": {文件名, …}}（同样的图案只画一张）。"""
    pats, imgs = {}, set()
    for s in shapes:
        for sk in shape_skins(s):
            if sk.get("pattern"):
                pats.setdefault(pattern_key(sk["pattern"]), (swatch_px(sk["pattern"]) + (sk["pattern"],)))
            if sk.get("image"):
                imgs.add(sk["image"]["src"])
    return {"patterns": pats, "images": imgs}


def tex_budget(limits: dict) -> int:
    """贴图一共能用多少像素：tex_px_sum；老的上限（只有张数 tex_n × 最长边 tex_px）照张数 × 边长²换算。"""
    v = limits.get("tex_px_sum")
    if _finite(v) and v > 0:
        return int(v)
    return int(limits.get("tex_n", 4)) * int(limits.get("tex_px", 1024)) ** 2


def px_words(px: int) -> str:
    """像素数 -> 「419 万像素」。"""
    return "%s 万像素" % ("%g" % round(px / 10000.0)) if px >= 10000 else "%d 像素" % px


def budget_line(num: dict, limits: dict, what: str = "") -> str:
    """每一版回执里的一句：面、文件、贴图各用了多少、还剩多少（11-26）。"""
    t, T = int(num.get("tris") or 0), int(limits["tris"])
    kb, KB = int(num.get("kb") or 0), int(limits["kb"])
    px = sum(int(a) * int(b) for a, b in (num.get("textures") or []))
    PX = tex_budget(limits)
    return ("%s用了 %s 面（还剩 %s）、文件 %.1f MB（还剩 %.1f MB）、贴图 %s（还剩 %s）"
            % (what, "{:,}".format(t), "{:,}".format(max(0, T - t)), kb / 1024.0, max(0, KB - kb) / 1024.0, px_words(px), px_words(max(0, PX - px))))


# --- measuring and the lot ----------------------------------------------------------------------------------------------------------
def numbers_of(points, tris: int, foot: bool = False) -> dict:
    """All corners (island frame) -> the numbers the island measures: bbox [x0, z0, x1, z1], h, below, footprint (the outer box), volume;
    ``foot``: also the outline seen from above (outline of every point's x, z), which a lot drawn as a polygon is checked by."""
    xs, ys, zs = [p[0] for p in points], [p[1] for p in points], [p[2] for p in points]
    x0, x1, z0, z1, y0, y1 = min(xs), max(xs), min(zs), max(zs), min(ys), max(ys)
    num = {"bounds": {"min": [round(x0, 3), round(y0, 3), round(z0, 3)], "max": [round(x1, 3), round(y1, 3), round(z1, 3)]},
           "bbox": [round(x0, 2), round(z0, 2), round(x1, 2), round(z1, 2)], "h": round(max(0.0, y1), 2), "below": round(max(0.0, -y0), 2),
           "footprint_m2": round((x1 - x0) * (z1 - z0), 1), "tris": int(tris)}
    num["volume_m3"] = round(num["footprint_m2"] * num["h"], 1)
    if foot:
        num["foot"] = outline(zip(xs, zs))
    return num


def _side(p, q, r):
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])


def _cross(a, b, c, d):
    d1, d2, d3, d4 = _side(c, d, a), _side(c, d, b), _side(a, b, c), _side(a, b, d)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and d1 and d2 and d3 and d4:
        return True

    def on(p, q, r):
        return min(p[0], q[0]) - 1e-9 <= r[0] <= max(p[0], q[0]) + 1e-9 and min(p[1], q[1]) - 1e-9 <= r[1] <= max(p[1], q[1]) + 1e-9
    return (abs(d1) < 1e-12 and on(c, d, a)) or (abs(d2) < 1e-12 and on(c, d, b)) or (abs(d3) < 1e-12 and on(a, b, c)) or (abs(d4) < 1e-12 and on(a, b, d))


def _inside(p, P):
    x, z = p
    hit = False
    for k in range(len(P)):
        (xa, za), (xb, zb) = P[k], P[(k + 1) % len(P)]
        if (za > z) != (zb > z) and x < (xb - xa) * (z - za) / (zb - za) + xa:
            hit = not hit
    return hit


def rect_in(P, x0, z0, x1, z1) -> bool:
    """和岛上 poly.rect_in 一样：轴对齐的矩形整个在多边形里面。"""
    R = [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
    if not all(_inside(p, P) for p in R):
        return False
    E = [(P[k], P[(k + 1) % len(P)]) for k in range(len(P))]
    ER = [(R[k], R[(k + 1) % 4]) for k in range(4)]
    for a, b in E:
        for c, d in ER:
            if _cross(a, b, c, d) and not (min(abs(_side(c, d, a)), abs(_side(c, d, b))) < 1e-9):
                return False
    return not any(x0 + 1e-9 < p[0] < x1 - 1e-9 and z0 + 1e-9 < p[1] < z1 - 1e-9 for p in P)


# --- the outline seen from above (11-25: on a lot drawn as a slanted polygon a house may follow its slanted edges) -----------------------
# 和岛上 town_play/worlds/isle/poly.py 的 hull / outline / foot_in 一样的算法（这个文件不导入别的模块，所以抄一份）
def _hull(pts) -> list:
    P = sorted(set(pts))
    if len(P) < 3:
        return P

    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and _side(out[-2], out[-1], p) <= 0:
                out.pop()
            out.append(p)
        return out
    lo, up = half(P), half(reversed(P))
    return lo[:-1] + up[:-1]


def _meet(a, b, c, d):
    rx, rz, sx, sz = b[0] - a[0], b[1] - a[1], c[0] - d[0], c[1] - d[1]
    den = rx * sz - rz * sx
    if abs(den) < 1e-12:
        return None
    wx, wz = d[0] - a[0], d[1] - a[1]
    t, u = (wx * sz - wz * sx) / den, (wx * rz - wz * rx) / den
    return (a[0] + t * rx, a[1] + t * rz), t, u


def _fewer(H, n_max):
    """More corners than n_max: merge one edge at a time (its neighbours stretched until they meet; the least added area first): only ever a
    little larger, never smaller."""
    n = len(H)
    if n <= n_max:
        return H
    P = list(H)
    prv, nxt = [(k - 1) % n for k in range(n)], [(k + 1) % n for k in range(n)]
    alive, ver, heap = [True] * n, [0] * n, []

    def plan(k):
        b, c = k, nxt[k]
        a, d = prv[b], nxt[c]
        got = _meet(P[a], P[b], P[c], P[d]) if len({a, b, c, d}) == 4 else None
        if got is None or got[1] <= 1.0 or got[2] <= 1.0:
            return math.inf, None
        X = got[0]
        return abs(_side(P[b], X, P[c])) / 2, X

    for k in range(n):
        heapq.heappush(heap, (plan(k)[0], k, 0))
    left = n
    while left > n_max and heap:
        cost, k, v = heapq.heappop(heap)
        if not alive[k] or v != ver[k]:
            continue
        if cost == math.inf:
            break
        _c, X = plan(k)
        c = nxt[k]
        P[k], alive[c] = X, False
        nxt[k], prv[nxt[c]] = nxt[c], k
        left -= 1
        for e in (prv[prv[k]], prv[k], k, nxt[k]):
            ver[e] += 1
            heapq.heappush(heap, (plan(e)[0], e, ver[e]))
    k0 = next(k for k in range(n) if alive[k])
    out, k = [], k0
    while True:
        out.append(P[k])
        k = nxt[k]
        if k == k0:
            return out


def outline(pts, n_max: int = FOOT_MAX) -> list:
    """(x, z) pairs -> the outline seen from above: [[x, z], …] convex, anticlockwise, two decimals, at most n_max corners; [] when flat."""
    H = _hull(pts)
    if len(H) < 3:
        return []
    out = []
    for x, z in _fewer(H, n_max):
        q = [round(x, 2) + 0.0, round(z, 2) + 0.0]
        if not out or q != out[-1]:
            out.append(q)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out if len(out) >= 3 else []


def _dist_seg(p, a, b) -> float:
    dx, dz = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz or 1e-9)))
    return math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t)


def _apart(a, b, c, d, eps) -> bool:
    def off(p, q, r):
        return _side(p, q, r) / (math.hypot(q[0] - p[0], q[1] - p[1]) or 1e-9)
    d1, d2, d3, d4 = off(c, d, a), off(c, d, b), off(a, b, c), off(a, b, d)
    return ((d1 > eps and d2 < -eps) or (d1 < -eps and d2 > eps)) and ((d3 > eps and d4 < -eps) or (d3 < -eps and d4 > eps))


def foot_in(P, F, eps: float = EDGE_EPS) -> bool:
    """和岛上 poly.foot_in 一样：外轮廓 F 整个在地界 P 里面（贴着边 1 厘米以内也算；边不穿过；凹进去的角不戳进来）。"""
    P, F = [tuple(p) for p in P], [tuple(p) for p in F]
    EP = [(P[k], P[(k + 1) % len(P)]) for k in range(len(P))]
    EF = [(F[k], F[(k + 1) % len(F)]) for k in range(len(F))]

    def near(p, E):
        return any(_dist_seg(p, a, b) <= eps for a, b in E)
    if not all(_inside(p, P) or near(p, EP) for p in F):
        return False
    if any(_apart(a, b, c, d, eps) for a, b in EF for c, d in EP):
        return False
    return not any(_inside(p, F) and not near(p, EF) for p in P)


def _foot_ok(num) -> list | None:
    """量出来的数里能用的外轮廓（至少 3 个角）-> 角的列表；没有、看不懂 -> None（照外接框查），和岛上 buildings.foot_of 一样。"""
    f = num.get("foot")
    if not isinstance(f, list) or not 3 <= len(f) <= 256 or not all(isinstance(p, (list, tuple)) and len(p) == 2 and all(_finite(q) for q in p) for p in f):
        return None
    return [(float(p[0]), float(p[1])) for p in f]


def box_of(points) -> list:
    """一组角（岛的坐标）-> 占地的外接框 [x0, z0, x1, z1]，和 numbers_of 一样取两位小数。"""
    xs, zs = [p[0] for p in points], [p[2] for p in points]
    return [round(min(xs), 2), round(min(zs), 2), round(max(xs), 2), round(max(zs), 2)]


def _name_part(text, n: int) -> str:
    return "".join(c for c in str(text) if c.isprintable() and c not in "「」").strip()[:n]


def recipe_parts(raw, shapes, feet: bool = False) -> list:
    """配方的每个形状 -> (怎么称呼, 外接框)：「第 7 个：sphere」，形状里写了 name 的带上它「第 7 个：sphere「树冠」」；
    use 套出来的是「第 3 个（椅子）的第 2 件：box「椅腿」」（读配方时记在 label 里）。
    ``feet``：再带上它从上往下看的外轮廓 (怎么称呼, 外接框, 外轮廓)，多边形的地上说是哪几个伸出去了用。"""
    out = []
    for k, s in enumerate(shapes):
        if s.get("label"):
            label = s["label"]
        else:
            name = raw[k].get("name") if k < len(raw or []) and isinstance(raw[k], dict) else None
            name = _name_part(name, 16) if isinstance(name, str) else ""
            label = "第 %d 个：%s%s" % (k + 1, s["type"], "「%s」" % name if name else "")
        V = placed(s)
        out.append((label, box_of(V), outline((p[0], p[2]) for p in V)) if feet else (label, box_of(V)))
    return out


NUDGE_MAX = 0.3                     # 伸到墙外 / 地界外这么多以内：推回去贴着放，不判问题（协调 11-25：招牌伸出 0.05 米整版判交不了，太严）


def _top_of(s: dict, k: int) -> str:
    """读好的形状属于配方的第几个（use 套出来的、repeat 摆出来的都算那一个）：「第 3 个（椅子）的第 2 件：…」-> "3"。"""
    lb = str(s.get("label") or "")
    if lb.startswith("第 "):
        n = lb[2:].split(" ", 1)[0]
        if n.isdigit():
            return n
    return "#%d" % k


def _span(items) -> list:
    V = [p for s in items for p in placed(s)]
    return [min(p[0] for p in V), min(p[2] for p in V), max(p[0] for p in V), max(p[2] for p in V)]


def _push(lo: float, hi: float, a: float, b: float, cap: float):
    """[a, b] 推进 [lo, hi] 要挪多少：0 = 本来就在里面；None = 伸出超过 cap、或者比 [lo, hi] 还宽（推不进去）。"""
    if a >= lo - EDGE_EPS and b <= hi + EDGE_EPS:
        return 0.0
    if b - a > hi - lo + EDGE_EPS:
        return None
    d = lo - a if a < lo - EDGE_EPS else hi - b
    return d if abs(d) <= cap + 1e-9 else None


def _move(s: dict, dx: float, dz: float) -> None:
    """整个形状在岛上平移 (dx, 0, dz)：套了外层的挪外层，没套的挪 pos（转过的也一样，平移不改形状）。"""
    if s.get("T"):
        R, t = s["T"]
        s["T"] = (R, (t[0] + dx, t[1], t[2] + dz))
    else:
        s["pos"] = [s["pos"][0] + dx, s["pos"][1], s["pos"][2] + dz]


def _far(dx: float, dz: float) -> str:
    return ("%.2f" % max(abs(dx), abs(dz))).rstrip("0").rstrip(".")


def _call(items) -> str:
    """推了的那一件怎么称呼（给主人也看得懂，不带 type）：写了名字的「招牌」、use 套的「椅子」、都没有的「第 44 个形状」。"""
    head = str(items[0].get("label") or "").split("：", 1)
    first = head[0]
    if "（" in first:
        return "「%s」" % first.split("（", 1)[1].split("）", 1)[0]
    if len(items) == 1 and len(head) > 1 and "「" in head[1]:
        return "「%s」" % head[1].split("「", 1)[1].rstrip("」")
    return first + "形状" if first.endswith("个") else first


def nudge_in(shapes: list, box, cap: float = NUDGE_MAX, whole: bool = False, wall: str = "墙", edge=None) -> list:
    """伸出 box [x0, z0, x1, z1]（屋里、或者长方形的地）cap 米以内的，推回去贴着边放（原地改 shapes）-> 推了什么的几句（记进 notes）。
    一件一件推：配方的一个形状算一件（use 套出来的椅子、repeat 摆的一排整件一起挪，不拆开）。``whole``（楼）：整栋先一起挪，
    整栋挪得进去就只挪整栋（不走样）；挪不进去再一件一件推。伸出超过 cap 的、比屋子还宽的不动：照旧判问题。
    ``edge``（地界要留的边，米）：box 是扣掉留边以后能盖的范围，说法换成「离地界留够了边」。"""
    if not shapes:
        return []
    x0, z0, x1, z1 = box
    if whole:
        a = _span(shapes)
        dx, dz = _push(x0, x1, a[0], a[2], cap), _push(z0, z1, a[1], a[3], cap)
        if dx is not None and dz is not None:
            if not (dx or dz):
                return []
            for s in shapes:
                _move(s, dx, dz)
            if edge:
                return ["整栋往里挪了 %s 米，离地界留够了 %s" % (_far(dx, dz), _edge_w(edge))]
            return ["整栋伸出%s %s 米，整栋往里挪了贴着%s放" % (wall, _far(dx, dz), wall)]
    groups: dict = {}
    for k, s in enumerate(shapes):
        groups.setdefault(_top_of(s, k), []).append(s)
    said = []
    for items in groups.values():
        a = _span(items)
        dx, dz = _push(x0, x1, a[0], a[2], cap), _push(z0, z1, a[1], a[3], cap)
        if dx is None or dz is None or not (dx or dz):
            continue
        for s in items:
            _move(s, dx, dz)
        said.append(("%s差 %s 米" if edge else "%s伸出" + wall + " %s 米") % (_call(items), _far(dx, dz)))
    if not said:
        return []
    more = " 等 %d 件" % len(said) if len(said) > 3 else ""
    if edge:
        return ["、".join(said[:3]) + more + "：离地界不够 %s，推回来留够了边" % (("%s 米" % _m(edge)) if isinstance(edge, (int, float)) else "要留的边")]
    return ["、".join(said[:3]) + more + "：推回%s里贴着%s放了" % ("屋" if wall == "墙" else "地界", wall)]


DOOR_WORDS = ("入户门", "大门", "正门", "前门", "主门", "门扇", "door", "entrance")
NOT_DOOR = ("门头", "门灯", "门牌", "门廊", "踏步", "门框", "门槛", "门帘", "门把", "门前", "门楣", "雨棚", "门口", "门柱", "门洞", "门垫", "柜门", "车库")
STEP_WORDS = ("踏步", "台阶", "阶梯", "step", "stair")
DOOR_UP_MAX = 0.6                   # 楼的入户门底边比地面（或门前台阶顶）高出这么多以上：门在楼上，判问题（协调 11-25：庄欣第 15 版门底边离地 4.25 米）
DOOR_TALL = (1.6, 4.5)


def _shape_name(s: dict) -> str:
    """形状的 name；use 套出来的没写 name 就用部件名（label「第 3 个（大门）的第 1 件」）。"""
    if isinstance(s.get("name"), str) and s["name"].strip():
        return s["name"].strip()
    lb = str(s.get("label") or "").split("：", 1)[0]
    return lb.split("（", 1)[1].split("）", 1)[0] if "（" in lb else ""


def _is_door(name: str) -> bool:
    low = name.lower()
    if any(w in name for w in NOT_DOOR):
        return False
    return name == "门" or name.endswith("门") or any(w in low for w in DOOR_WORDS)


def door_high(shapes) -> dict | None:
    """配方里认得出的入户门（name 是「入户门 / 大门 / …门 / door」，高 1.6 到 4.5 米）-> {"low": 门底边离地, "up": 比地面或它下面最高的台阶顶高多少}；
    认不出门 -> None（不查）。照摆好以后的真位置量（转过的、use 套的都算），和 door_height.py（岛上照配方的 pos 读）一样的说法。"""
    doors, steps = [], []
    for s in shapes or []:
        nm = _shape_name(s)
        if not nm:
            continue
        V = placed(s)
        y0, y1 = min(p[1] for p in V), max(p[1] for p in V)
        if any(w in nm.lower() for w in STEP_WORDS):
            steps.append(y1)
        elif _is_door(nm) and DOOR_TALL[0] <= y1 - y0 <= DOOR_TALL[1]:
            doors.append(y0)
    if not doors:
        return None
    low = min(doors)
    ref = max([0.0] + [t for t in steps if t <= low + 0.01])
    return {"low": round(low, 2), "up": round(low - ref, 2)}


NO_DOOR_LINE = "没认出入户门：把门的部件名起成「门」或 door，岛上才能查门高"     # 主人自己传的模型里认不出门（协调 11-25）：不拦，回执原样说这一句


def door_high_parts(parts) -> dict | None:
    """主人自己传的 .blend / .glb（11-27）：照物体的名字认入户门（「入户门 / 大门 / …门 / door」，高 1.6 到 4.5 米）和台阶（「踏步 / 台阶 / step / stair」），
    和配方一样量 -> {"low", "up"}；认不出门 -> None（不查，回执说 NO_DOOR_LINE）。``parts``：eval_copies 出来的物体（名字后面带 " (part)"）。"""
    doors, steps = [], []
    for ob in parts or []:
        nm = str(ob.name)
        nm = nm[:-7] if nm.endswith(" (part)") else nm
        nm = nm.split(".")[0].strip() if "." in nm and nm.rsplit(".", 1)[-1].isdigit() else nm.strip()    # Blender 的「门.001」
        V = [_from_b(v.co) for v in ob.data.vertices]
        if not nm or not V:
            continue
        y0, y1 = min(p[1] for p in V), max(p[1] for p in V)
        if any(w in nm.lower() for w in STEP_WORDS):
            steps.append(y1)
        elif _owner_door(nm) and DOOR_TALL[0] <= y1 - y0 <= DOOR_TALL[1]:
            doors.append(y0)
    if not doors:
        return None
    low = min(doors)
    ref = max([0.0] + [t for t in steps if t <= low + 0.01])
    return {"low": round(low, 2), "up": round(low - ref, 2)}


def _owner_door(nm: str) -> bool:
    """主人起的名字认不认得出是入户门：整个名字，或者用空格 / 下划线 / 横线隔开的某一段（「013 门」「门_front」）。"""
    if any(w in nm for w in NOT_DOOR):
        return False
    return _is_door(nm) or any(_is_door(t) for t in nm.replace("_", " ").replace("-", " ").split())


def door_high_words(high) -> str | None:
    """{"low", "up"} -> 「门离地 4.25 米，挪到一楼」（门在楼上）| None。插件交楼时带上来，岛上照这一句退。"""
    if not isinstance(high, dict) or not _finite(high.get("up")) or not _finite(high.get("low")) or high["up"] <= DOOR_UP_MAX:
        return None
    return "门离地 %.2f 米，挪到一楼" % float(high["low"])


def _named(labels) -> str:
    """伸出去的那几个 -> 「（第 7 个：sphere、第 2 个：box）」，最多说 3 个；没有 -> ""。"""
    if not labels:
        return ""
    return "（%s%s）" % ("、".join(labels[:3]), " 等 %d 个" % len(labels) if len(labels) > 3 else "")


# --- 离地界留的边（主人 11-25「定0.5米」）：新交的楼左右和后面离地界各留 0.5 米，朝路那面不限 -------------------------------------
# 岛上照朝路的那一面算好写进 lot.json 的 "keep"（{"left": 0.5, "right": 0.5, "back": 0.5}，朝路那面不写），这里照它查、照它推；
# 没写 keep 的（老岛）照旧只查出没出地界。岛上 buildings.check_numbers 用的是同一个 keep_problems（话一字不差）。
EDGE_SIDES = ("left", "right", "back", "front")
EDGE_ZH = {"left": "左边", "right": "右边", "back": "后边", "front": "门口那边"}
EDGE_TO = {"left": "往右", "right": "往左", "back": "往门口那边", "front": "往后"}


def _m(v: float) -> str:
    return ("%.2f" % v).rstrip("0").rstrip(".")


def _up(v: float) -> float:
    """往上取到厘米（挪多少、收多少：取整以后一定够）。"""
    return math.ceil(round(v * 100, 6)) / 100


def read_keep(lot) -> dict:
    """lot.json 的 "keep" -> {面: 至少留几米}（0、没写的面不留）。看不懂、没写 -> {}：不查留边。"""
    k = lot.get("keep") if isinstance(lot, dict) else None
    if not isinstance(k, dict):
        return {}
    return {s: float(k[s]) for s in EDGE_SIDES if _finite(k.get(s)) and 0 < float(k[s]) <= 5}


def read_keep_was(lot) -> dict:
    """lot.json 的 "keep_was"（重盖已经有的楼，协调 11-25：原来有多少留多少，不许比原来更挤）-> {面: 原来的楼留了几米}：
    这几面要留的边照原来的楼算（比 0.5 米少），话里说「原来的楼留了 X 米」。只认 keep 里也有的面。"""
    k, keep = (lot.get("keep_was") if isinstance(lot, dict) else None), read_keep(lot)
    if not isinstance(k, dict):
        return {}
    return {s: float(k[s]) for s in EDGE_SIDES if s in keep and _finite(k.get(s)) and 0 <= float(k[s]) <= 5}


def keep_edge(lot):
    """推回来的话里说留了多少：几面一样 -> 那个数；不一样（重盖：有的面照原来的楼）-> "要留"；没留边 -> None。"""
    vals = sorted(set(read_keep(lot).values()))
    return None if not vals else vals[0] if len(vals) == 1 else "要留"


def _edge_w(edge) -> str:
    return "%s 米的边" % _m(edge) if isinstance(edge, (int, float)) else "%s的边" % edge


def keep_box(lot):
    """长方形的地扣掉要留的边以后能盖的范围 (x0, z0, x1, z1)；多边形的地、没留边 -> None。"""
    keep = read_keep(lot)
    if not keep or lot.get("poly_uv"):
        return None
    hw, hd = float(lot["w"]) / 2, float(lot["d"]) / 2
    return (-hw + keep.get("left", 0.0), -hd + keep.get("back", 0.0), hw - keep.get("right", 0.0), hd - keep.get("front", 0.0))


def _edge_gaps(bbox, w: float, d: float) -> dict:
    x0, z0, x1, z1 = bbox
    return {"left": x0 + w / 2, "right": w / 2 - x1, "back": z0 + d / 2, "front": d / 2 - z1}


def _poly_gaps(P, F) -> list:
    """多边形的地 P、楼的外轮廓 F（地块自己的坐标）-> [(那条地界线朝哪面, 楼离它多远)]：每条地界线照它往外的方向算是哪一面。"""
    n = len(P)
    area2 = sum(P[k][0] * P[(k + 1) % n][1] - P[(k + 1) % n][0] * P[k][1] for k in range(n))
    EF = [(F[k], F[(k + 1) % len(F)]) for k in range(len(F))]
    out = []
    for k in range(n):
        a, b = P[k], P[(k + 1) % n]
        du, dv = b[0] - a[0], b[1] - a[1]
        nu, nv = (dv, -du) if area2 > 0 else (-dv, du)
        side = ("right" if nu > 0 else "left") if abs(nu) >= abs(nv) else ("front" if nv > 0 else "back")
        g = min([_dist_seg(p, a, b) for p in F] + [_dist_seg(q, c, e) for q in (a, b) for c, e in EF])
        out.append((side, g))
    return out


def keep_problems(num: dict, lot, parts=None, head: str = "") -> list:
    """离地界不够要留的边 -> 「左边离地界只有 0.06 米，至少留 0.5 米：宽改到 6.8 米以内」（出了地界的：「左边伸出地界 0.2 米，至少留 0.5 米：…」）；
    宽 / 深在能盖的范围以内、只是偏了 -> 「…：往右挪 0.44 米」。多边形的地照外轮廓（没有就外接框）离每条要留边的地界线多远：「…：往里收 0.3 米」。
    ``parts`` 同 problems_of（后面说是哪几个形状）；``head`` 加在每句前面（「放的位置」）。没写 keep -> []。"""
    keep = read_keep(lot)
    if not keep:
        return []
    P = []
    if lot.get("poly_uv"):
        foot = _foot_ok(num)
        if foot is None:
            x0, z0, x1, z1 = num["bbox"]
            foot = [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
        worst = {}
        for side, g in _poly_gaps([tuple(p) for p in lot["poly_uv"]], foot):
            k = keep.get(side, 0.0)
            if k and g < k - EDGE_EPS and (side not in worst or g < worst[side]):
                worst[side] = g
        was = read_keep_was(lot)
        for side in EDGE_SIDES:
            if side in worst:
                g = worst[side]
                P.append("%s%s离地界只有 %s 米%s，至少留 %s 米：往里收 %s 米" % (head, EDGE_ZH[side], _m(max(g, 0.0)), _was_words(was, side), _m(keep[side]),
                                                                 _m(_up(keep[side] - g))))
        return P
    w, d = float(lot["w"]), float(lot["d"])
    bbox = num["bbox"]
    gaps = _edge_gaps(bbox, w, d)
    said = set()
    was = read_keep_was(lot)
    for side in EDGE_SIDES:
        k, g = keep.get(side, 0.0), gaps[side]
        if not k or g >= k - EDGE_EPS:
            continue
        if side in ("left", "right"):
            span, room, word, axis = bbox[2] - bbox[0], w - keep.get("left", 0.0) - keep.get("right", 0.0), "宽", "x"
        else:
            span, room, word, axis = bbox[3] - bbox[1], d - keep.get("back", 0.0) - keep.get("front", 0.0), "深", "z"
        start = "%s伸出地界 %.1f 米" % (EDGE_ZH[side], -g) if g < -EDGE_EPS else "%s离地界只有 %s 米" % (EDGE_ZH[side], _m(max(g, 0.0)))
        if span > room + EDGE_EPS:
            tail = "" if axis in said else "：%s改到 %s 米以内" % (word, _m(room))
            said.add(axis)
        else:
            tail = "：%s挪 %s 米" % (EDGE_TO[side], _m(_up(k - g)))
        names = ""
        if parts:
            bad = sorted(((_edge_gaps(pt[1], w, d)[side], j, pt[0]) for j, pt in enumerate(parts)), key=lambda x: (x[0], x[1]))
            names = _named([nm for gg, _j, nm in bad if gg < k - EDGE_EPS])
        P.append(head + start + _was_words(was, side) + "，至少留 %s 米" % _m(k) + tail + names)
    return P


def _was_words(was: dict, side: str) -> str:
    """重盖：「，原来的楼留了 0.1 米」（这一面要留的边照原来的楼算）；不是 -> ""。"""
    return "，原来的楼留了 %s 米" % _m(was[side]) if side in was else ""


def keep_words(lot) -> str:
    """「能盖的范围：左右 6.8 米、前后 14.5 米（已扣掉 0.5 米的边）」；多边形的地「能盖的范围：地界往里留 0.5 米的边（朝路那面不用）」；没留边 -> ""。"""
    keep = read_keep(lot)
    if not keep:
        return ""
    vals = sorted(set(keep.values()))
    one = len(vals) == 1 and not read_keep_was(lot)
    each = "、".join("%s %s 米" % (EDGE_ZH[s], _m(keep[s])) for s in EDGE_SIDES if s in keep)   # 重盖（keep_was）：各面照原来的楼
    if lot.get("poly_uv"):
        return ("能盖的范围：地界往里留 %s 米的边（朝路那面不用）" % _m(vals[0]) if one
                else "能盖的范围：地界往里留边（%s；朝路那面不用，重盖不比原来的楼更挤）" % each)
    x0, z0, x1, z1 = keep_box(lot)
    return "能盖的范围：左右 %s 米、前后 %s 米（%s）" % (_m(x1 - x0), _m(z1 - z0), "已扣掉 %s 米的边" % _m(vals[0]) if one
                                                    else "已扣掉要留的边：%s；重盖不比原来的楼更挤" % each)


def tex_problems(tex, limits: dict, per: str = "") -> list:
    """贴图（11-26 起按总像素）：几张加起来的像素、一张的最长边、张数（防坏文件的技术线）。"""
    P = []
    px, cap = sum(int(a) * int(b) for a, b in tex), tex_budget(limits)
    if px > cap:
        P.append("贴图加起来 %s，%s最多 %s（大小几张随便拆，加起来算）" % (px_words(px), per, px_words(cap)))
    if len(tex) > limits["tex_n"]:
        P.append("贴图有 %d 张，%s最多 %d 张" % (len(tex), per, limits["tex_n"]))
    return P


def problems_of(num: dict, lot, limits: dict, parts=None) -> list:
    """和岛上 buildings.check_numbers 一样的话：出地界、面数、文件大小、高度、贴图。``lot`` None = 不查地界。
    ``parts``（[(怎么称呼, 外接框[, 外轮廓])]，配方的形状或 .blend 里的物体）：出地界的话后面再说是哪几个伸出去了；收不收和不写一样。
    多边形的地（11-25）：量出来的数里有外轮廓（foot）就照它查（墙可以顺着斜边走），没有照外接框。"""
    P = []
    x0, z0, x1, z1 = num["bbox"]
    if lot and lot.get("poly_uv"):
        poly = [tuple(p) for p in lot["poly_uv"]]
        foot = _foot_ok(num)
        if foot is not None:
            if not foot_in(poly, foot):
                out = [pt[0] for pt in parts or [] if not (foot_in(poly, pt[2]) if len(pt) > 2 and pt[2] else rect_in(poly, *pt[1]))]
                P.append(FOOT_OUT + _named(out))
        elif not rect_in(poly, x0, z0, x1, z1):
            out = [pt[0] for pt in parts or [] if not rect_in(poly, *pt[1])]
            P.append("楼的占地（%.1f × %.1f 米）伸出地界：要整个落在这块地的边界里面%s" % (x1 - x0, z1 - z0, _named(out)))
        if not P:                                            # 落在地界里了，再看要留的边（主人 11-25 定 0.5 米）
            P += keep_problems(num, lot, parts)
    elif lot:
        hw, hd = float(lot["w"]) / 2, float(lot["d"]) / 2
        keep = read_keep(lot)
        for side, key, over_of in (("左边", "left", lambda b: -hw - b[0]), ("右边", "right", lambda b: b[2] - hw), ("后边", "back", lambda b: -hd - b[1]),
                                   ("门口那边", "front", lambda b: b[3] - hd)):
            if keep.get(key):
                continue                                     # 要留边的那几面：下面 keep_problems 一起说（出了地界也在那一句里）
            over = over_of(num["bbox"])
            if over > EDGE_EPS:
                out = sorted(((over_of(pt[1]), k, pt[0]) for k, pt in enumerate(parts or [])), key=lambda x: (-x[0], x[1]))
                P.append("%s伸出地界 %.1f 米%s" % (side, over, _named([name for o, _k, name in out if o > EDGE_EPS])))
        P += keep_problems(num, lot, parts)
    if num["tris"] > limits["tris"]:
        P.append("%d 个面，最多 %d（页面跑不动的线，不卖）" % (num["tris"], limits["tris"]))
    if num.get("kb", 0) > limits["kb"]:
        P.append("文件 %d KB，最多 %d KB" % (num["kb"], limits["kb"]))
    if num["h"] > limits["h"]:
        P.append("高 %.0f 米，最高 %d 米" % (num["h"], limits["h"]))
    return P + tex_problems(num.get("textures") or [], limits)


def merge_limits(limits: dict, got) -> dict:
    """lot.json / room.json 里的 limits 盖过默认的。老的岛只给贴图张数（tex_n）和最长边（tex_px）、没有 tex_px_sum：
    照「张数 × 最长边²」换成总像素，张数放回默认的技术线（11-26 起按总像素查，新插件配老岛也照老岛的量给）。"""
    dflt_n = limits["tex_n"]
    got = got if isinstance(got, dict) else {}
    for k, v in got.items():
        if k in limits and _finite(v):
            limits[k] = v
    if "tex_px_sum" not in got and ("tex_n" in got or "tex_px" in got):
        limits["tex_px_sum"] = int(limits["tex_n"]) * int(limits["tex_px"]) ** 2
        limits["tex_n"] = max(int(limits["tex_n"]), dflt_n)
    return limits


def read_lot(path):
    """lot.json：{"w", "d", "poly_uv"?: [[x, z], …], "limits"?: {…}} -> (lot | None, limits)。"""
    limits = dict(LIMITS)
    if not path:
        return None, limits
    with open(path, encoding="utf-8") as fh:
        lot = json.load(fh)
    if not isinstance(lot, dict) or not _finite(lot.get("w")) or not _finite(lot.get("d")):
        raise ValueError('lot.json 要写成 {"w": 宽, "d": 深, "poly_uv"?: [[x, z], …], "limits"?: {…}}')
    merge_limits(limits, lot.get("limits"))
    poly = lot.get("poly_uv")
    if poly is not None and not (isinstance(poly, list) and len(poly) >= 3 and all(isinstance(p, (list, tuple)) and len(p) == 2 and all(_finite(q) for q in p) for p in poly)):
        raise ValueError("lot.json 的 poly_uv 要是至少三个 [x, z]")
    out = {"w": float(lot["w"]), "d": float(lot["d"]), "poly_uv": [[float(a), float(b)] for a, b in poly] if poly else None}
    keep = read_keep(lot)                                    # 离地界要留的边（11-26 的岛才写）
    if keep:
        out["keep"] = keep
    return out, limits


# --- the front door (11-23): which side of the house, how far from that side's middle ------------------------------------------------
SIDES = ("front", "back", "left", "right")
SIDE_WORDS = {"front": "门口那面", "back": "后面", "left": "左面", "right": "右面"}
DOOR_W, DOOR_H = 1.2, 2.2
DOOR_TEXT = 'door 要写成 {"side":"front","at":0}（side：front 门口那面 / back 后面 / left 左面 / right 右面；at：离那一面正中几米，可不写）'


def read_door(raw, bbox=None) -> tuple:
    """配方的 "door" -> (问题, {"side", "at"} | None)。不写 -> ([], None)：岛上照朝着最近的路的那一面开。
    at：前后两面往右（x 正）为正，左右两面往前（z 正）为正。``bbox`` 给了就查门在不在那面墙上。"""
    if raw is None:
        return [], None
    if isinstance(raw, str):
        raw = {"side": raw}
    if not isinstance(raw, dict) or raw.get("side", "front") not in SIDES or not _finite(raw.get("at", 0)):
        return [DOOR_TEXT], None
    d = {"side": raw.get("side", "front"), "at": round(float(raw.get("at", 0)), 2)}
    if bbox:
        x0, z0, x1, z1 = bbox
        half = ((x1 - x0) if d["side"] in ("front", "back") else (z1 - z0)) / 2 - DOOR_W / 2
        if abs(d["at"]) > max(0.0, half) + 0.01:
            return ["门开到墙外了：%s宽 %.1f 米，门宽 %.1f 米，at 最多 ±%.1f" % (SIDE_WORDS[d["side"]], 2 * (half + DOOR_W / 2), DOOR_W, max(0.0, half))], d
    return [], d


def recipe_door(obj):
    """配方里的 "door"（{"door":…,"shapes":[…]}、包在建模回合的 {"kind":"recipe","shapes":{…}} 里的都认）。"""
    if isinstance(obj, dict) and isinstance(obj.get("world"), dict):
        obj = obj["world"]
    if not isinstance(obj, dict):
        return None
    if obj.get("door") is not None:
        return obj["door"]
    s = obj.get("shapes")
    return s.get("door") if isinstance(s, dict) else None


def door_point(foot, door) -> tuple:
    """占地 [x0, z0, x1, z1] 上门的那一点 -> (x, z, 朝外的 nx, nz)。"""
    x0, z0, x1, z1 = foot
    cx, cz, at = (x0 + x1) / 2, (z0 + z1) / 2, float(door.get("at") or 0)
    return {"front": (cx + at, z1, 0.0, 1.0), "back": (cx + at, z0, 0.0, -1.0), "left": (x0, cz + at, -1.0, 0.0), "right": (x1, cz + at, 1.0, 0.0)}[door["side"]]


# --- one floor of an inside (--room) ----------------------------------------------------------------------------------------------------
# 一层的贴图（11-26）：老的 8 张 × 2048² 的量，按总像素给；一张最长边还是 2048
INSIDE_LIMITS = {"tris": 300000, "kb": 16384, "tex_n": 64, "tex_px": 2048, "tex_px_sum": 32 * TEX_UNIT, "shapes": 4000, "shapes_json_kb": 1024,
                 "lights": 16, "seats": 12}
WALL_T = 0.12                       # 墙厚（在占地里面）
SLAB_T = 0.1
IN_FROM_DOOR = 0.6                  # door 空点在正门往里这么远（岛的 build.py：正门往里 0.6 米那一点的 1.5 米以内）
SKIRT_D = 0.015                     # 踢脚线贴着墙伸出来这么厚
INSIDE_TEXT = ('室内配方要写成 {"room":{"floor":{…},"walls":{…},"ceiling":{…}},"shapes":[家具, …],"defs":{…},"lights":[{"at":[x,y,z]}],'
               '"points":{"stairs_up":[x,z],"table":[x,y,z],"seats":[[x,y,z],…]}}（每样都可不写）')


def read_room(path) -> tuple:
    """room.json -> (room, limits)。room：{foot, h, floor, floors, door | None, w, d}。"""
    limits = dict(INSIDE_LIMITS)
    with open(path, encoding="utf-8") as fh:
        r = json.load(fh)
    f = r.get("foot") if isinstance(r, dict) else None
    if not (isinstance(f, list) and len(f) == 4 and all(_finite(q) for q in f) and f[2] - f[0] > 1 and f[3] - f[1] > 1):
        raise ValueError('room.json 要写成 {"foot": [x0, z0, x1, z1], "h": 层高, "floor": 第几层, "door"?: {"side", "at"}}')
    merge_limits(limits, r.get("limits"))
    h = r.get("h") if _finite(r.get("h")) else 3.0
    floor = int(r["floor"]) if _finite(r.get("floor")) else 1
    floors = int(r["floors"]) if _finite(r.get("floors")) else 1
    door = read_door(r.get("door"))[1] if r.get("door") is not None else None
    room = {"foot": [float(q) for q in f], "h": max(2.2, min(8.0, float(h))), "floor": max(1, floor), "floors": max(1, floors),
            "door": door if floor <= 1 else None}
    room["w"], room["d"] = room["foot"][2] - room["foot"][0], room["foot"][3] - room["foot"][1]
    return room, limits


def _surface(raw, default_mat: str, k: str, why: list):
    """room 里的 floor / walls / ceiling 的皮：{"material", "color", "pattern"?, "image"?}；ceiling 写 false 就不做。
    walls 里还可以单独写某一面墙（"back":{…}、"front"、"left"、"right"）和踢脚线（"skirting":{"h":0.1,"material","color"}）。"""
    if raw is False and k == "ceiling":
        return None
    raw = raw if isinstance(raw, dict) else {}
    lb = "room 的 %s" % k
    base = {"mat": default_mat, "color": DEFAULT_COLOR, "pattern": None, "image": None}
    sk = read_skin(raw, base, lb, why) or base
    if k != "walls":
        return sk
    out = {"all": sk, "sides": {}, "skirting": None}
    for side in ("back", "front", "left", "right"):
        if isinstance(raw.get(side), dict):
            s2 = read_skin(raw[side], sk, "%s 的 %s 那面" % (lb, side), why)
            if s2 is not None:
                out["sides"][side] = s2
    sk2 = raw.get("skirting")
    if sk2 is not None:
        if not isinstance(sk2, dict) or not _finite(sk2.get("h", 0.1)) or not 0.03 <= sk2.get("h", 0.1) <= 0.4:
            why.append('%s 的 skirting（踢脚线）要写成 {"h":0.03 到 0.4 米,"material":…,"color":…}' % lb)
        else:
            s3 = read_skin(sk2, {"mat": "wood", "color": _shade(sk["color"], 0.7), "pattern": None, "image": None}, "%s 的踢脚线" % lb, why)
            if s3 is not None:
                out["skirting"] = dict(s3, h=float(sk2.get("h", 0.1)))
    return out


def _point(v):
    """[x, z] 或 [x, y, z] -> (x, y, z) | None。"""
    if isinstance(v, (list, tuple)) and len(v) in (2, 3) and all(_finite(q) for q in v):
        return (float(v[0]), 0.0, float(v[1])) if len(v) == 2 else (float(v[0]), float(v[1]), float(v[2]))
    return None


def _point_name(nm: str) -> bool:
    if nm in ("stairs_up", "stairs_down", "table"):
        return True
    head, _, n = nm.rpartition("_")
    return head in ("stairs_up", "stairs_down") and n.isdigit()


def read_inside(obj, room: dict, limits: dict) -> tuple:
    """室内配方 -> (问题, {surfaces, shapes, raw_shapes, lights, points})。家具可以一个都没有（只有地板、墙、天花板）；defs + use 照样展开。"""
    if isinstance(obj, dict) and isinstance(obj.get("world"), dict):
        obj = obj["world"]
    if isinstance(obj, dict) and isinstance(obj.get("shapes"), dict):
        obj = obj["shapes"]                                  # 建模回合交的 {"kind":"recipe","shapes":{"room":…,"shapes":[…]}}
    if not isinstance(obj, dict):
        return [INSIDE_TEXT], None
    raw = json.dumps(obj, ensure_ascii=False)
    if len(raw.encode("utf-8")) > limits["shapes_json_kb"] * 1024:
        return ["配方有 %d KB，最多 %d KB" % (len(raw.encode("utf-8")) // 1024, limits["shapes_json_kb"])], None
    why = []
    rm = obj.get("room") if isinstance(obj.get("room"), dict) else {}
    surf = {"floor": _surface(rm.get("floor"), "wood", "floor", why), "walls": _surface(rm.get("walls"), "plaster", "walls", why),
            "ceiling": _surface(rm.get("ceiling", {}), "plaster", "ceiling", why)}
    shapes_raw = obj.get("shapes") if obj.get("shapes") is not None else []
    if not isinstance(shapes_raw, list):
        return [INSIDE_TEXT], None
    if len(shapes_raw) > limits["shapes"]:
        return ["配方里有 %d 个形状，最多 %d 个" % (len(shapes_raw), limits["shapes"])], None
    defs = obj.get("defs", {})
    if not isinstance(defs, dict):
        return ['defs 要写成 {"名字": [形状, …]}（shapes 里用 {"use":"名字","pos":[x,y,z]} 放）'], None
    w2, shapes = _read_list(shapes_raw, defs, limits) if shapes_raw else ([], [])
    why += w2
    lights = []
    L = obj.get("lights")
    if L is not None and not isinstance(L, list):
        why.append('lights 要写成 [{"at":[x, y, z],"power":150}, …]')
        L = []
    if len(L or []) > limits["lights"]:
        why.append("灯有 %d 盏，最多 %d 盏" % (len(L), limits["lights"]))
    for k, lt in enumerate((L or [])[:int(limits["lights"])]):
        p = _point(lt.get("at")) if isinstance(lt, dict) else None
        pw = lt.get("power", 150) if isinstance(lt, dict) else None
        c = color_value(lt.get("color", "#ffffff")) if isinstance(lt, dict) else None
        if p is None or not _finite(pw) or not 1 <= pw <= 2000 or c is None:
            why.append('第 %d 盏灯要写成 {"at":[x, y, z],"power":1 到 2000（瓦）,"color":"#ffffff"}' % (k + 1))
            continue
        lights.append({"at": p, "power": float(pw), "color": c})
    if not lights:                                           # 一盏也没写：天花板正中挂一盏
        x0, z0, x1, z1 = room["foot"]
        lights = [{"at": ((x0 + x1) / 2, room["h"] - 0.3, (z0 + z1) / 2), "power": 150.0, "color": 0xFFFFFF, "auto": True}]
    pts = {}
    P = obj.get("points") if isinstance(obj.get("points"), dict) else {}
    for name, v in P.items():
        nm = str(name).lower()
        if nm in ("seats", "door"):
            continue
        if not _point_name(nm):
            why.append("points 里的 %s 不认识：写 stairs_up、stairs_down、stairs_up_3（通到第 3 层）、table、seats" % str(name)[:20])
            continue
        p = _point(v)
        if p is None:
            why.append("points 的 %s 要写成 [x, z]（table 写 [x, 桌面高, z]）" % nm)
            continue
        pts[nm] = p
    seats = P.get("seats") or []
    if not isinstance(seats, list) or len(seats) > limits["seats"] or any(_point(q) is None for q in seats):
        why.append("seats 要写成 [[x, y, z], …]，最多 %d 个" % limits["seats"])
        seats = []
    for k, q in enumerate(seats):
        pts["seat_%d" % (k + 1)] = _point(q)
    return why[:5], {"surfaces": surf, "shapes": shapes, "raw_shapes": shapes_raw, "lights": lights, "points": pts}


def _box(x0, y0, z0, x1, y1, z1, skin: dict, role: str) -> dict:
    sk = {"mat": skin["mat"], "color": skin["color"], "pattern": skin.get("pattern"), "image": skin.get("image")}
    return {"type": "box", "mat": sk["mat"], "color": sk["color"], "skin": sk, "faces": {}, "pos": [(x0 + x1) / 2, y0, (z0 + z1) / 2], "rot": [0.0, 0.0, 0.0],
            "seg": 18, "size": [x1 - x0, y1 - y0, z1 - z0], "role": role}


def _wall_skin(surf, side):
    w = surf["walls"]
    if "all" not in w:                                       # (老的写法：一张皮)
        return w
    return w["sides"].get(side, w["all"])


def room_shapes(room: dict, surf: dict) -> list:
    """地板（顶面 y = 0）、四面墙（在占地里面，厚 WALL_T；一层开正门的洞：宽 DOOR_W、高 DOOR_H）、天花板（层高处）、踢脚线（写了才有）：都是 box。
    每面墙可以有自己的皮（walls.back / front / left / right）。"""
    x0, z0, x1, z1 = room["foot"]
    h, t = room["h"], WALL_T
    out = [_box(x0, -SLAB_T, z0, x1, 0.0, z1, surf["floor"], "floor")]
    walls = (("back", (x0, z0, x1, z0 + t)), ("front", (x0, z1 - t, x1, z1)), ("left", (x0, z0 + t, x0 + t, z1 - t)), ("right", (x1 - t, z0 + t, x1, z1 - t)))
    door = room.get("door")
    gap = None
    for side, (a0, b0, a1, b1) in walls:
        sk = _wall_skin(surf, side)
        if not (door and door["side"] == side):
            out.append(_box(a0, 0.0, b0, a1, h, b1, sk, "wall"))
            continue
        dx, dz, nx, _nz = door_point(room["foot"], door)
        half = DOOR_W / 2
        if nx == 0:                                          # 前后两面：沿 x 断开
            segs, over = [(a0, b0, dx - half, b1), (dx + half, b0, a1, b1)], (dx - half, b0, dx + half, b1)
        else:
            segs, over = [(a0, b0, a1, dz - half), (a0, dz + half, a1, b1)], (a0, dz - half, a1, dz + half)
        gap = (side, over)
        for s0, r0, s1, r1 in segs:
            if s1 - s0 > 0.02 and r1 - r0 > 0.02:
                out.append(_box(s0, 0.0, r0, s1, h, r1, sk, "wall"))
        if h - DOOR_H > 0.02:
            out.append(_box(over[0], DOOR_H, over[1], over[2], h, over[3], sk, "wall"))
    sk = surf["walls"].get("skirting") if isinstance(surf.get("walls"), dict) and "all" in surf["walls"] else None
    if sk:
        e, sh = SKIRT_D, sk["h"]
        ix0, iz0, ix1, iz1 = x0 + t, z0 + t, x1 - t, z1 - t
        runs = (("back", (ix0, iz0, ix1, iz0 + e)), ("front", (ix0, iz1 - e, ix1, iz1)), ("left", (ix0, iz0 + e, ix0 + e, iz1 - e)),
                ("right", (ix1 - e, iz0 + e, ix1, iz1 - e)))
        for side, (a0, b0, a1, b1) in runs:
            pieces = [(a0, b0, a1, b1)]
            if gap and gap[0] == side:                       # 门洞那一段不贴
                g = gap[1]
                pieces = [(a0, b0, g[0], b1), (g[2], b0, a1, b1)] if side in ("back", "front") else [(a0, b0, a1, g[1]), (a0, g[3], a1, b1)]
            for s0, r0, s1, r1 in pieces:
                if max(s1 - s0, r1 - r0) > 0.02 and min(s1 - s0, r1 - r0) > 0.005:
                    out.append(_box(s0, 0.0, r0, s1, sh, r1, sk, "skirting"))
    if surf.get("ceiling"):
        out.append(_box(x0, h, z0, x1, h + SLAB_T, z1, surf["ceiling"], "ceiling"))
    return out


def inside_door(room: dict):
    """一层的 door 空点：正门往里 IN_FROM_DOOR 米，地面上。别的层 -> None。"""
    if not room.get("door"):
        return None
    dx, dz, nx, nz = door_point(room["foot"], room["door"])
    return (round(dx - nx * IN_FROM_DOOR, 3), 0.0, round(dz - nz * IN_FROM_DOOR, 3))


def inside_problems(num: dict, room: dict, limits: dict, parts=None, points=None) -> list:
    """家具（parts：[(怎么称呼, 外接框)]）出了墙、顶到天花板；点出了屋子；面数、文件、贴图（一层的上限）。"""
    P = []
    x0, z0, x1, z1 = room["foot"]
    ix0, iz0, ix1, iz1 = x0 + WALL_T, z0 + WALL_T, x1 - WALL_T, z1 - WALL_T
    out = [pt[0] for pt in parts or [] if pt[1][0] < ix0 - EDGE_EPS or pt[1][1] < iz0 - EDGE_EPS or pt[1][2] > ix1 + EDGE_EPS or pt[1][3] > iz1 + EDGE_EPS]
    if out:
        P.append("有家具伸到墙外面了：屋里是 x %.2f 到 %.2f、z %.2f 到 %.2f%s" % (ix0, ix1, iz0, iz1, _named(out)))
    if num.get("furniture_top") is not None and num["furniture_top"] > room["h"] + EDGE_EPS:
        P.append("家具最高到 %.1f 米，顶到天花板了（层高 %.1f 米）" % (num["furniture_top"], room["h"]))
    for name, p in (points or {}).items():
        if not (ix0 - EDGE_EPS <= p[0] <= ix1 + EDGE_EPS and iz0 - EDGE_EPS <= p[2] <= iz1 + EDGE_EPS):
            P.append("点 %s 在屋子外面（%.1f, %.1f）" % (name, p[0], p[2]))
    if num["tris"] > limits["tris"]:
        P.append("%d 个面，一层最多 %d" % (num["tris"], limits["tris"]))
    if num.get("kb", 0) > limits["kb"]:
        P.append("文件 %d KB，一层最多 %d KB" % (num["kb"], limits["kb"]))
    return P + tex_problems(num.get("textures") or [], limits, "一层")


PREVIEW_ENGINES = ("auto", "eevee", "cycles", "workbench")


def parse_args(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="recipe_to_blend.py", description="配方 -> .blend + .glb + 三张预览图 + 尺寸")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--recipe", help="配方 JSON（形状清单）")
    src.add_argument("--from-blend", dest="from_blend", help="主人自己改过的 .blend")
    src.add_argument("--from-glb", dest="from_glb", help="一个现成的 .glb（主人传上来的）")
    ap.add_argument("--out-blend", dest="out_blend", default="")
    ap.add_argument("--out-glb", dest="out_glb", default="")
    ap.add_argument("--previews", default="", help="三张预览图放哪个目录（front.png、three_quarter.png、top.png）")
    ap.add_argument("--lot", default="", help="lot.json：地的大小、地界、上限")
    ap.add_argument("--room", default="", help="room.json：做一层室内（楼的占地、层高、第几层、正门）")
    ap.add_argument("--images", default="", help="配方里 image 用的图放在哪个目录（按文件名找，不进子目录）")
    ap.add_argument("--preview-engine", dest="preview_engine", default=os.environ.get("COBUILD_PREVIEW_ENGINE") or "auto", choices=PREVIEW_ENGINES,
                    help="预览图用什么画：auto（有显卡用 EEVEE，没有用 Cycles）、eevee、cycles、workbench")
    ap.add_argument("--json-out", dest="json_out", default="", help="结果另存一份到这个文件")
    ap.add_argument("--px", type=int, default=PREVIEW_PX)
    a = ap.parse_args(argv)
    if a.recipe and not (a.out_blend and a.out_glb):
        ap.error("--recipe 要同时写 --out-blend 和 --out-glb")
    if (a.from_blend or a.from_glb) and not a.out_glb:
        ap.error("--from-blend / --from-glb 要写 --out-glb")
    a.px = max(128, min(2048, a.px))
    return a


def emit(result: dict, json_out: str = "", line: bool = True) -> None:
    """结果：一行 JSON 打到 stdout（line=False 只写 --json-out：预览图画之前先存一份，Blender 画图时崩了也有结果）。"""
    result = dict({"cobuild": VERSION}, **result)
    text = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    if json_out:
        try:
            with open(json_out, "w", encoding="utf-8") as fh:
                fh.write(text)
        except OSError:
            pass
    if line:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------------------------------------------------------------------------
# Blender 里的部分
# ---------------------------------------------------------------------------------------------------------------------------------
class Fail(Exception):
    def __init__(self, *why):
        super().__init__("; ".join(why))
        self.why = list(why)


def _lin(hexcol):
    def f(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (f((hexcol >> 16) & 255), f((hexcol >> 8) & 255), f(hexcol & 255))


def _to_b(p):
    """island (x, y up, z front) -> Blender (x, y = -z, z up)."""
    return (p[0], -p[2], p[1])


def _from_b(v):
    return (v[0], v[2], -v[1])


def _safe_prefs(bpy):
    """Never run a script from a file (Blender's default; set again here)."""
    try:
        bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    except Exception:  # noqa: BLE001 - background builds without preferences
        pass


TOWN_KEY = "cobuild_town"           # 我们做的 14 种材料记着节点的指纹：没被改过的照岛上的材料号导出（页面自己画质感），改过的当成主人自己的材料
ROUGH = {"glass": 0.05, "metal": 0.35, "water": 0.1, "tile": 0.6, "glow": 0.5}
# 导出前要烘成图的节点（glTF 带不走的「程序化」节点：凭空算出颜色的那些）
PROC_NODES = {"ShaderNodeTexNoise", "ShaderNodeTexBrick", "ShaderNodeTexVoronoi", "ShaderNodeTexWave", "ShaderNodeTexChecker", "ShaderNodeTexGradient",
              "ShaderNodeTexMagic", "ShaderNodeTexWhiteNoise", "ShaderNodeTexMusgrave", "ShaderNodeTexGabor", "ShaderNodeTexSky",
              "ShaderNodeTexPointDensity", "ShaderNodeAmbientOcclusion", "ShaderNodeBevel", "ShaderNodeWireframe"}
# 我们的 14 种材料在 Blender 里的样子（只给预览和主人看；导出照旧是纯色 + 材料号，页面自己画）：(砖缝那种: 宽, 高, 缝, 错开, 砖色二, 缝色) | (斑驳: 缩放 x, y, 深浅)
TOWN_LOOK = {"brick": ("brick", 0.24, 0.075, 0.008, 0.5, 0.88, 0.72), "tile": ("brick", 0.3, 0.18, 0.012, 0.5, 0.9, 0.62),
             "slate": ("brick", 0.32, 0.16, 0.01, 0.5, 0.86, 0.55), "pave": ("brick", 0.42, 0.42, 0.012, 0.5, 0.92, 0.75),
             "plaster": ("noise", 4.0, 4.0, 0.05), "stone": ("noise", 2.5, 2.5, 0.12), "wood": ("noise", 1.2, 26.0, 0.1),
             "cloth": ("noise", 60.0, 60.0, 0.05), "bark": ("noise", 26.0, 1.2, 0.15)}


def _node_sig(m) -> str:
    """材料节点的指纹：每个节点的种类、名字、输入的默认值、用的图，加上连线。主人换了节点、调了数、接了别的，指纹就变了。"""
    nt = m.node_tree if m is not None else None
    if nt is None:
        return ""
    parts = []
    for n in sorted(nt.nodes, key=lambda x: x.name):
        vals = []
        for i in n.inputs:
            v = getattr(i, "default_value", None)
            try:
                v = tuple(round(float(x), 4) for x in v)
            except TypeError:
                v = round(float(v), 4) if isinstance(v, (int, float)) else None
            vals.append(v)
        extra = ""
        if getattr(n, "image", None) is not None:
            extra = n.image.name
        if n.bl_idname == "ShaderNodeValToRGB":
            extra = str([(round(e.position, 4), tuple(round(c, 4) for c in e.color)) for e in n.color_ramp.elements])
        if n.bl_idname == "ShaderNodeTexBrick":
            extra = "%g" % n.offset
        parts.append("%s|%s|%s|%s" % (n.bl_idname, n.name, vals, extra))
    for ln in nt.links:
        parts.append("%s.%s>%s.%s" % (ln.from_node.name, ln.from_socket.identifier, ln.to_node.name, ln.to_socket.identifier))
    h = 7
    for ch in "\n".join(parts):
        h = (h * 131 + ord(ch)) % 2305843009213693951
    return "%x" % h


def _nodes(m):
    if m.node_tree is None:                               # (5.x makes the node tree by itself; use_nodes goes away in 6.0)
        m.use_nodes = True
    return m.node_tree


def _town_detail(nt, name):
    """预览里的质感（照页面着色器的意思：砖缝、瓦、木纹、灰泥的斑驳），按 UVMap（每个面平铺的米）-> 一个 0.7–1.15 的系数，乘在顶点色上。"""
    look = TOWN_LOOK.get(name)
    if look is None:
        return None
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"
    if look[0] == "brick":
        _k, w, h, mortar, off, c2, cm = look
        br = nt.nodes.new("ShaderNodeTexBrick")
        br.offset = off
        br.inputs["Scale"].default_value = 1.0
        br.inputs["Brick Width"].default_value = w
        br.inputs["Row Height"].default_value = h
        br.inputs["Mortar Size"].default_value = mortar
        br.inputs["Color1"].default_value = (1.0, 1.0, 1.0, 1.0)
        br.inputs["Color2"].default_value = (c2, c2, c2, 1.0)
        br.inputs["Mortar"].default_value = (cm, cm, cm, 1.0)
        nt.links.new(uv.outputs["UV"], br.inputs["Vector"])
        bw = nt.nodes.new("ShaderNodeRGBToBW")
        nt.links.new(br.outputs["Color"], bw.inputs["Color"])
        return bw.outputs["Val"]
    _k, sx, sy, depth = look
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (sx, sy, 1.0)
    nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 1.0
    nz.inputs["Detail"].default_value = 4.0
    nt.links.new(mp.outputs["Vector"], nz.inputs["Vector"])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = 0.3, 0.7
    mr.inputs["To Min"].default_value, mr.inputs["To Max"].default_value = 1.0 - depth, 1.0 + depth
    nt.links.new(nz.outputs["Fac"], mr.inputs["Value"])
    return mr.outputs["Result"]


def _bsdf_for(m, name: str):
    nt = _nodes(m)
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        return nt, None
    bsdf.inputs["Roughness"].default_value = ROUGH.get(name, 0.85)
    if name == "metal":
        bsdf.inputs["Metallic"].default_value = 0.8
    if name in ("glass", "water") and "Transmission Weight" in bsdf.inputs:
        bsdf.inputs["Transmission Weight"].default_value = 0.6
    return nt, bsdf


def _material(bpy, name: str):
    """岛上的 14 种材料之一：顶点色（Col）当颜色；预览里再乘上这种材料的质感（导出前换回纯色，_flat_town）。"""
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    nt, bsdf = _bsdf_for(m, name)
    if bsdf is not None:
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Col"
        col = attr.outputs["Color"]
        f = _town_detail(nt, name)
        if f is not None:
            vm = nt.nodes.new("ShaderNodeVectorMath")
            vm.operation = "SCALE"
            nt.links.new(col, vm.inputs[0])
            nt.links.new(f, vm.inputs["Scale"])
            col = vm.outputs["Vector"]
        nt.links.new(col, bsdf.inputs["Base Color"])
        if name == "glow" and "Emission Strength" in bsdf.inputs:
            nt.links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 1.5
    m.diffuse_color = (0.8, 0.8, 0.8, 1.0)
    m[TOWN_KEY] = _node_sig(m)
    return m


def _flat_copy(bpy, m):
    """导出用的那份：顶点色直接当颜色（和以前一样，页面读 COLOR_0 + 材料号自己画质感）；名字还是 plaster、wood……（和以前导出的一样）。"""
    name = m.name
    m.name = name + " look"
    c = m.copy()
    c.name = name
    nt = c.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    attr = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeVertexColor"), None)
    if bsdf is not None and attr is not None:
        for ln in list(bsdf.inputs["Base Color"].links):
            nt.links.remove(ln)
        nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    return c


def _mat_kind(m) -> str:
    """'town'（我们的 14 种，没被改过）、'proc'（有程序化的节点：导出前烘成图）、'own'（别的：纯色、自己的图）。"""
    if m is None or m.node_tree is None:
        return "own"
    sig = m.get(TOWN_KEY)
    if sig and sig == _node_sig(m):
        return "town"
    for n in m.node_tree.nodes:
        if n.bl_idname in PROC_NODES and any(o.is_linked for o in n.outputs):
            return "proc"
    return "own"


def _uv_of(p, n):
    ax = max(range(3), key=lambda i: abs(n[i]))
    return (p[2], p[1]) if ax == 0 else ((p[0], p[2]) if ax == 1 else (p[0], p[1]))


# --- 图案画成能平铺的小图（numpy，不用 Cycles） --------------------------------------------------------------------------------------
def _rgb(c):
    return (((c >> 16) & 255) / 255.0, ((c >> 8) & 255) / 255.0, (c & 255) / 255.0)


def _seed(key: str) -> int:
    h = 7
    for ch in key:
        h = (h * 131 + ord(ch)) % 2147483647
    return h


def pattern_pixels(p: dict):
    """图案 -> (高, 宽, 3) 的 sRGB 0–1（第 0 行在最下面，Blender 的顺序），正好一个周期，上下左右接得上。"""
    import numpy as np
    W, H = swatch_px(p)
    pu, pv = pattern_period(p)
    rng = np.random.default_rng(_seed(pattern_key(p)))
    U, V = np.meshgrid((np.arange(W) + 0.5) / W * pu, (np.arange(H) + 0.5) / H * pv)
    px = pu / W
    c1, c2, cj = (np.array(_rgb(p[k])) for k in ("color", "color2", "joint"))
    kind, s = p["kind"], p["size"]

    def noise(cu, cv, octaves=3):
        out, amp, tot = np.zeros_like(U), 1.0, 0.0
        for o in range(octaves):
            nu, nv = max(1, int(cu * 2 ** o)), max(1, int(cv * 2 ** o))
            G = rng.random((nv, nu))
            x, y = U / pu * nu, V / pv * nv
            x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
            fx, fy = x - x0, y - y0
            fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
            x0, y0 = x0 % nu, y0 % nv
            x1, y1 = (x0 + 1) % nu, (y0 + 1) % nv
            val = (G[y0, x0] * (1 - fx) + G[y0, x1] * fx) * (1 - fy) + (G[y1, x0] * (1 - fx) + G[y1, x1] * fx) * fy
            out += amp * val
            tot += amp
            amp *= 0.5
        return out / tot

    def line(d, w):                                       # 缝：离线 d 米、半宽 w 米（边上抗锯齿）
        return np.clip((w - d) / px + 0.5, 0.0, 1.0)

    def mix(a, b, t):
        return a * (1 - t)[..., None] + b * t[..., None]
    if kind == "planks":
        L = p["long"]
        row = np.floor(V / s).astype(int) % 4
        uu = (U + np.array([0.0, 0.5, 0.25, 0.75])[row] * L) % L
        tone = rng.random(4)[row]
        grain = noise(max(1, round(pu / 0.6)), max(4, min(400, round(pv / 0.012))), 3)
        base = mix(c1, c2, np.clip(0.15 + 0.6 * tone + (grain - 0.5) * 0.6, 0, 1))
        jw = max(0.0012, 0.8 * px)
        m = np.maximum(line(np.abs(((V + s / 2) % s) - s / 2), jw), line(np.minimum(uu, L - uu), jw))
        img = mix(base, cj, m * 0.85)
    elif kind in ("tiles", "bricks"):
        sx, sy, off = (s, s, 0.0) if kind == "tiles" else (s, 0.42 * s, 0.5)
        row = np.floor(V / sy)
        uu, vv = (U + (row % 2) * off * sx) % sx, V % sy
        g = max(0.0025 if kind == "tiles" else 0.005, 0.75 * px)
        m = np.maximum(line(np.minimum(uu, sx - uu), g), line(np.minimum(vv, sy - vv), g))
        base = c1 * (0.95 + 0.1 * noise(3, 3, 2))[..., None]
        img = mix(base, c2, m)
    elif kind == "stripes":
        d = np.abs(((V + s / 2) % s) - s / 2)
        t = (np.floor(V / s) % 2).astype(float)
        img = mix(c1, c2, np.where(d < px, 0.5, t))
    elif kind == "checker":
        t = ((np.floor(U / s) + np.floor(V / s)) % 2).astype(float)
        img = mix(c1, c2, t)
    elif kind == "grain":
        n1 = noise(2, max(4, min(400, round(pv / 0.01))), 4)
        n2 = noise(3, 2, 2)
        rings = 0.5 + 0.5 * np.sin(2 * np.pi * (V / pv * 6 + n2 * 2))
        img = mix(c1, c2, np.clip((n1 - 0.5) * 1.4 + 0.5, 0, 1) * 0.7 + rings * 0.3)
    elif kind == "mottle":
        img = mix(c1, c2, np.clip((noise(3, 3, 4) - 0.5) * 2.2 + 0.5, 0, 1))
    elif kind == "dots":
        du, dv = (U % s) - s / 2, (V % s) - s / 2
        img = mix(c1, c2, np.clip((0.28 * s - np.sqrt(du * du + dv * dv)) / px + 0.5, 0, 1))
    else:                                                 # weave：四根经线、四根纬线一上一下
        tu, tv = U / s * 4, V / s * 4
        over = ((np.floor(tu) + np.floor(tv)) % 2).astype(bool)
        su = 0.82 + 0.18 * np.sin(np.pi * (tv % 1.0))
        sv = 0.82 + 0.18 * np.sin(np.pi * (tu % 1.0))
        img = np.where(over[..., None], c1 * su[..., None], c2 * sv[..., None])
    return np.clip(img, 0.0, 1.0)


def pattern_image(bpy, p: dict):
    import numpy as np
    pix = pattern_pixels(p)
    H, W = pix.shape[:2]
    img = bpy.data.images.new("pat " + pattern_key(p), W, H, alpha=False)
    buf = np.ones((H, W, 4), np.float32)
    buf[..., :3] = pix
    img.pixels.foreach_set(buf.ravel())
    img.pack()
    return img


class Ctx:
    """做一栋楼（一层）时用到的图：自己的图从 --images 目录读一次，同样的图案只画一张。"""

    def __init__(self, images_dir: str, limits: dict, notes: list):
        self.dir, self.limits, self.notes = os.path.abspath(images_dir) if images_dir else "", limits, notes    # (Blender 读相对路径不照 cwd)
        self.imgs, self.pats = {}, {}

    def image(self, bpy, skin):
        p, im = skin.get("pattern"), skin.get("image")
        if p:
            key = pattern_key(p)
            if key not in self.pats:
                self.pats[key] = pattern_image(bpy, p)
            return self.pats[key]
        src = im["src"]
        if src not in self.imgs:
            if not self.dir:
                raise Fail("配方用了自己的图（%s），但这次没有给图的目录（--images）：插件做的是草稿里的 images 文件夹；岛上托管的鱼写建模回合里列的相册图名" % src)
            path = os.path.join(self.dir, src)
            if not image_name_ok(src) or not os.path.isfile(path) or os.path.dirname(os.path.realpath(path)) != os.path.realpath(self.dir):
                raise Fail("图 %s 在图的目录里没有（文件名要一模一样，只认 png / jpg / webp）" % src)
            try:
                img = bpy.data.images.load(path, check_existing=False)
                w, h = img.size
            except Exception as e:  # noqa: BLE001 - a picture Blender cannot read
                raise Fail("图 %s 读不了：%s" % (src, str(e)[:80]))
            if not w or not h:
                raise Fail("图 %s 读不出大小（坏了，或者不是图）" % src)
            img.name = "img " + src
            img.pack()
            self.imgs[src] = img
        return self.imgs[src]


def _tex_material(bpy, ctx, skin: dict):
    """带图案或自己的图的皮 -> 一种材料（图接在颜色上；粗糙、金属、发光照 material 那 14 种的意思）。"""
    p, im = skin.get("pattern"), skin.get("image")
    name = ("pat %s %s" % (pattern_key(p), skin["mat"])) if p else ("img %s %s %s" % (im["src"], "tile" if im["tile"] else "fit", skin["mat"]))
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    nt, bsdf = _bsdf_for(m, skin["mat"])
    tx = nt.nodes.new("ShaderNodeTexImage")
    tx.image = ctx.image(bpy, skin)
    tx.interpolation = "Linear"
    tx.extension = "REPEAT" if (p or im["tile"]) else "EXTEND"
    if bsdf is not None:
        nt.links.new(tx.outputs["Color"], bsdf.inputs["Base Color"])
        if skin["mat"] == "glow" and "Emission Strength" in bsdf.inputs:
            nt.links.new(tx.outputs["Color"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 1.5
    m.diffuse_color = tuple(_lin(skin["color"])) + (1.0,)
    return m


# 自己的图按面铺：(u 用哪根轴, v 用哪根轴, u 的正负, v 的正负)，从外面看是正的
SLOT_PROJ = {"front": (0, 1, 1, 1), "back": (0, 1, -1, 1), "right": (2, 1, -1, 1), "left": (2, 1, 1, 1), "top": (0, 2, 1, -1), "bottom": (0, 2, 1, 1)}


def _proj_for(slot: str, normals) -> tuple:
    if slot in SLOT_PROJ:
        return SLOT_PROJ[slot]
    n = [sum(v[i] for v in normals) for i in range(3)]       # side / sides / end：按这一面朝外的平均方向
    ax = max(range(3), key=lambda i: abs(n[i]))
    if abs(n[ax]) < 1e-6:
        return SLOT_PROJ["front"]
    return SLOT_PROJ[AXIS_SLOTS[(ax, 1 if n[ax] > 0 else -1)]]


def build_shape_object(bpy, s: dict, k: int, coll, ctx=None) -> list:
    """One shape -> its Blender objects (corners already where they stand, the object's own matrix = identity): the faces with a plain skin
    (vertex colour + the island's material id, as before) and, when some face has a pattern or a picture of hers, those faces as a second
    object (no material id: the page draws them with the file's own material)."""
    G = shape_mesh(s)
    P = placed(s, G["V"])
    NW = placed_normals(s, G["N"]) if G["N"] else None
    skins = [skin_of(s, sl) for sl in G["slot"]]
    plain = [i for i, sk in enumerate(skins) if not (sk.get("pattern") or sk.get("image"))]
    tex = [i for i, sk in enumerate(skins) if sk.get("pattern") or sk.get("image")]
    out = []
    for group, idx in (("plain", plain), ("tex", tex)):
        if idx:
            out.append(_shape_part(bpy, s, k, group, idx, G, P, NW, skins, coll, ctx))
    return out


def _shape_part(bpy, s, k, group, idx, G, P, NW, skins, coll, ctx):
    import bmesh
    F, V0 = G["F"], G["V"]
    used = sorted({v for i in idx for v in F[i]})
    remap = {v: j for j, v in enumerate(used)}
    me = bpy.data.meshes.new("%03d %s %s%s" % (k + 1, s["type"], s["mat"], " tex" if group == "tex" else ""))
    me.from_pydata([_to_b(P[v]) for v in used], [], [[remap[v] for v in F[i]] for i in idx])
    me.validate(clean_customdata=False)
    me.update()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)       # every face looks outwards, whatever order the corners came in
    bm.to_mesh(me)
    bm.free()
    back = {v: u for u, v in remap.items()}
    by_set = {}
    for i in idx:
        by_set.setdefault(tuple(sorted(F[i])), i)
    fidx = [by_set.get(tuple(sorted(back[v] for v in poly.vertices)), idx[0]) for poly in me.polygons]   # each polygon -> its face in G
    smooth = [True if NW else bool(G["S"][i]) for i in fidx]
    me.polygons.foreach_set("use_smooth", smooth)
    sharp = G["sharp"]
    if sharp:
        attr = me.attributes.get("sharp_edge") or me.attributes.new("sharp_edge", "BOOLEAN", "EDGE")
        flags = [((back[e.vertices[0]], back[e.vertices[1]]) in sharp or (back[e.vertices[1]], back[e.vertices[0]]) in sharp) for e in me.edges]
        attr.data.foreach_set("value", flags)
    mats, slot_of = [], {}
    for i in fidx:
        sk = skins[i]
        key = (sk["mat"],) if group == "plain" else (sk["mat"], pattern_key(sk["pattern"]) if sk.get("pattern") else None,
                                                    (sk["image"]["src"], sk["image"]["tile"]) if sk.get("image") else None)
        if key not in slot_of:
            slot_of[key] = len(mats)
            mats.append(_material(bpy, sk["mat"]) if group == "plain" else _tex_material(bpy, ctx, sk))
    for m in mats:
        me.materials.append(m)
    keys = []
    for i in fidx:
        sk = skins[i]
        keys.append(slot_of[(sk["mat"],) if group == "plain" else (sk["mat"], pattern_key(sk["pattern"]) if sk.get("pattern") else None,
                                                                  (sk["image"]["src"], sk["image"]["tile"]) if sk.get("image") else None)])
    me.polygons.foreach_set("material_index", keys)
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    cols = []
    for poly, i in zip(me.polygons, fidx):
        c = _lin(skins[i]["color"]) if group == "plain" else (1.0, 1.0, 1.0)
        cols += [c[0], c[1], c[2], 1.0] * poly.loop_total
    ca.data.foreach_set("color", cols)
    if group == "tex":                                       # 带图的面另记一份底色（Base，不导出）：Workbench 画预览时用它（它画不出图）
        base = me.color_attributes.new("Base", "FLOAT_COLOR", "CORNER")
        bc = []
        for poly, i in zip(me.polygons, fidx):
            c = _lin(skins[i]["color"])
            bc += [c[0], c[1], c[2], 1.0] * poly.loop_total
        base.data.foreach_set("color", bc)
    me.color_attributes.active_color = ca
    uv = me.uv_layers.new(name="UVMap")
    flat = [0.0] * (2 * len(me.loops))
    if group == "plain":
        for poly in me.polygons:
            n = _from_b(poly.normal)
            for li in poly.loop_indices:
                a, b = _uv_of(_from_b(me.vertices[me.loops[li].vertex_index].co), n)
                flat[2 * li], flat[2 * li + 1] = a, b
    else:
        Rt = shape_affine(s)[0]
        Rt = tuple(tuple(Rt[j][i] for j in range(3)) for i in range(3))            # local normal ≈ Rᵀ · world normal
        local_n = [_norm(_mv(Rt, _from_b(poly.normal))) for poly in me.polygons]
        ext = {}
        for pi, (poly, i) in enumerate(zip(me.polygons, fidx)):
            im = skins[i].get("image")
            if im and not im["tile"]:
                e = ext.setdefault(G["slot"][i], {"n": [], "pts": []})
                e["n"].append(local_n[pi])
                e["pts"] += [V0[back[v]] for v in poly.vertices]
        for e_slot, e in ext.items():
            au, av, su, sv = _proj_for(e_slot, e["n"])
            us, vs = [su * q[au] for q in e["pts"]], [sv * q[av] for q in e["pts"]]
            e["box"] = (au, av, su, sv, min(us), max(us) - min(us) or 1.0, min(vs), max(vs) - min(vs) or 1.0)
        for pi, (poly, i) in enumerate(zip(me.polygons, fidx)):
            sk = skins[i]
            p, im = sk.get("pattern"), sk.get("image")
            for li in poly.loop_indices:
                q = V0[back[me.loops[li].vertex_index]]
                if p:
                    ln = local_n[pi]
                    ax = max(range(3), key=lambda j: abs(ln[j]))
                    i0, i1 = {0: (2, 1), 1: (0, 2), 2: (0, 1)}[ax]
                    d = "xyz".index(p["dir"])
                    if d in (i0, i1) and d != i0:
                        i0, i1 = i1, i0
                    pu, pv = pattern_period(p)
                    a, b = q[i0] / pu, q[i1] / pv
                elif im["tile"]:
                    au, av, su, sv = _proj_for(G["slot"][i], [local_n[pi]])
                    a, b = su * q[au] / im["tile"], sv * q[av] / im["tile"]
                else:
                    au, av, su, sv, u0, du, v0, dv = ext[G["slot"][i]]["box"]
                    a, b = (su * q[au] - u0) / du, (sv * q[av] - v0) / dv
                flat[2 * li], flat[2 * li + 1] = a, b
    uv.data.foreach_set("uv", flat)
    if group == "plain":
        um = me.uv_layers.new(name="Mat")                    # the island's own shader reads the material id here (kit.to_object)
        ids = []
        for poly, i in zip(me.polygons, fidx):
            mat = skins[i]["mat"]
            param = (0.3 + 0.1 * (k % 5)) if mat == "glass" else 0.0
            ids += [(MATERIALS[mat] + 0.5) / 16.0, param] * poly.loop_total
        um.data.foreach_set("uv", ids)
    me.uv_layers.active = uv
    if NW:                                                   # 倒角的真法线（导出也照它）
        me.normals_split_custom_set([_to_b(NW[back[me.loops[li].vertex_index]]) for li in range(len(me.loops))])
    me.update()
    ob = bpy.data.objects.new(me.name, me)
    coll.objects.link(ob)
    return ob


def add_lot(bpy, lot, scene):
    """The lot as a flat ground (a separate collection the export leaves out): the owner sees its edge while he edits."""
    coll = bpy.data.collections.get(LOT_COLLECTION) or bpy.data.collections.new(LOT_COLLECTION)
    if coll.name not in scene.collection.children:
        scene.collection.children.link(coll)
    if lot.get("poly_uv"):
        pts = [(u, -0.02, v) for u, v in lot["poly_uv"]]
    else:
        w, d = lot["w"] / 2, lot["d"] / 2
        pts = [(-w, -0.02, -d), (w, -0.02, -d), (w, -0.02, d), (-w, -0.02, d)]
    me = bpy.data.meshes.new("lot")
    me.from_pydata([_to_b(p) for p in pts], [], [list(range(len(pts)))])
    me.update()
    m = bpy.data.materials.new("lot ground")
    m.diffuse_color = (0.55, 0.62, 0.5, 1.0)
    nt = _nodes(m)
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.26, 0.34, 0.2, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.95
    me.materials.append(m)
    ob = bpy.data.objects.new("lot (not exported)", me)
    ob.hide_select = True
    coll.objects.link(ob)
    return ob


def _clear_scene(bpy):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _safe_prefs(bpy)


def _strip_outside_files(bpy, notes: list) -> None:
    """Nothing is read from outside the file: libraries refused; unpacked pictures, fonts, sounds, clips and caches dropped."""
    if len(bpy.data.libraries):
        raise Fail("这个 .blend 链接了别的 .blend 文件（库链接）：在 Blender 里先 File > External Data > Pack Resources，或者把链接的东西做成本地的（Make Local），再交")
    gone = 0
    for im in list(bpy.data.images):
        if im.source in ("FILE", "SEQUENCE", "MOVIE", "TILED") and im.packed_file is None and im.filepath:
            bpy.data.images.remove(im)
            gone += 1
    if gone:
        notes.append("有 %d 张贴图没打包进文件，没用（那几处是纯色）：Blender 里 File > External Data > Pack Resources 再存" % gone)
    for coll_name in ("sounds", "movieclips", "cache_files", "volumes"):
        coll = getattr(bpy.data, coll_name, None)
        if coll is None:
            continue
        for x in list(coll):
            try:
                coll.remove(x)
            except Exception:  # noqa: BLE001
                pass
    for f in list(bpy.data.fonts):
        if f.packed_file is None and f.filepath and f.filepath != "<builtin>":
            try:
                bpy.data.fonts.remove(f)
            except Exception:  # noqa: BLE001
                pass


def _build_objects(bpy):
    """The meshes that make up the house: visible, not the lot."""
    lot = bpy.data.collections.get(LOT_COLLECTION)
    skip = set(lot.all_objects) if lot is not None else set()
    out = []
    for ob in bpy.context.scene.objects:
        if ob in skip or ob.type != "MESH" or ob.hide_render or ob.hide_get():
            continue
        out.append(ob)
    return out


def eval_copies(bpy, obs, boxes=None) -> list:
    """Every mesh with its modifiers applied, in world space: what is measured and exported (the scene's own objects stay as they are).
    ``boxes`` (a list): gets (「物体「名字」」, the object's own outer box, its outline seen from above) per object, for naming what sticks out
    of the lot."""
    dg = bpy.context.evaluated_depsgraph_get()
    parts = []
    for ob in obs:
        ev = ob.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
        me.transform(ob.matrix_world)
        if boxes is not None and len(me.vertices):
            V = [_from_b(v.co) for v in me.vertices]
            boxes.append(("物体「%s」" % _name_part(ob.name, 24), box_of(V), outline((p[0], p[2]) for p in V)))
        if not me.materials and ob.material_slots:
            for sl in ob.material_slots:
                me.materials.append(sl.material)
        part = bpy.data.objects.new(ob.name + " (part)", me)
        bpy.context.scene.collection.objects.link(part)
        parts.append(part)
    if not parts:
        raise Fail("里面没有任何模型（网格）")
    return parts


def measure_parts(parts, foot: bool = False) -> tuple:
    pts, tris = [], 0
    for ob in parts:
        me = ob.data
        me.calc_loop_triangles()
        pts += [_from_b(v.co) for v in me.vertices]
        tris += len(me.loop_triangles)
    if not pts or not tris:
        raise Fail("里面没有任何面")
    return numbers_of(pts, tris, foot), pts


def _join(bpy, parts, name: str):
    if len(parts) > 1:
        with bpy.context.temp_override(active_object=parts[0], object=parts[0], selected_objects=parts, selected_editable_objects=parts):
            bpy.ops.object.join()
    one = parts[0]
    one.name = name
    return one


def _split(bpy, part, keep: set, name: str):
    """``part`` 里材料号在 keep 里的那些面，另做一个物体（一个物体里混着几种材料时用）。"""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(part.data)
    gone = [f for f in bm.faces if f.material_index not in keep]
    if len(gone) == len(bm.faces):
        bm.free()
        return None
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in part.data.materials:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def _one_uv(me, notes: list) -> None:
    """带图的那一块只留一套 UV（叫 UVMap）：页面把第二套 UV 当成岛上的材料号读。"""
    keep = me.uv_layers.active_render if hasattr(me.uv_layers, "active_render") else None
    keep = keep or (me.uv_layers[0] if len(me.uv_layers) else None)
    if keep is None:
        return
    for uv in list(me.uv_layers):
        if uv.name != keep.name:
            me.uv_layers.remove(uv)
            notes.append("有的物体带着第二套 UV，导出时去掉了（贴图都照第一套）")
    me.uv_layers[0].name = "UVMap"


def _town_layers(me) -> None:
    """主人自己的网格用了我们的材料：补上材料号（Mat）、平铺的 UV、顶点色，和配方做的一样。"""
    names = [(_base_name(m.name) if m else "paint") for m in me.materials] or ["paint"]
    if "UVMap" not in me.uv_layers:
        uv = me.uv_layers.new(name="UVMap")
        flat = []
        for poly in me.polygons:
            n = _from_b(poly.normal)
            for li in poly.loop_indices:
                flat += list(_uv_of(_from_b(me.vertices[me.loops[li].vertex_index].co), n))
        uv.data.foreach_set("uv", flat)
    if "Mat" not in me.uv_layers:
        um = me.uv_layers.new(name="Mat")
        ids = []
        for poly in me.polygons:
            nm = names[min(poly.material_index, len(names) - 1)]
            ids += [(MATERIALS.get(nm, 0) + 0.5) / 16.0, 0.0] * poly.loop_total
        um.data.foreach_set("uv", ids)
    if "Col" not in me.color_attributes:
        ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        ca.data.foreach_set("color", [1.0] * (4 * len(me.loops)))
        me.color_attributes.active_color = ca


BAKE_PX_PER_M = 256


def bake_procedural(bpy, ob, limits: dict, px_left: int, notes: list) -> bool:
    """主人在 Blender 里接的程序化材料（噪波、砖、Voronoi……glTF 带不走）：新展一套 UV，Cycles 把颜色烘到一张图上，材料换成这张图。
    -> 烘成了没有；没成就照原样导出（那几处是纯色），说一句。"""
    me = ob.data
    area = sum(p.area for p in me.polygons)
    side = 256
    while side < 2048 and side * side < area * BAKE_PX_PER_M ** 2 / 0.6:
        side *= 2
    side = min(side, int(limits["tex_px"]))
    while side > 128 and side * side > px_left:
        side //= 2
    sc = bpy.context.scene
    prev = sc.render.engine
    try:
        for o in bpy.context.scene.objects:
            o.select_set(False)
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bu = me.uv_layers.new(name="BakeUV")
        me.uv_layers.active = bu
        bu.active_render = True
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004)
        bpy.ops.object.mode_set(mode="OBJECT")
        img = bpy.data.images.new("baked " + ob.name, side, side, alpha=False)
        sc.render.engine = "CYCLES"
        sc.cycles.samples = 1
        try:
            sc.cycles.device = "CPU"
        except Exception:  # noqa: BLE001
            pass
        bk = sc.render.bake
        bk.use_pass_direct, bk.use_pass_indirect, bk.use_pass_color, bk.margin = False, False, True, 8
        nodes = []
        for m in me.materials:
            if m is None:
                continue
            nt = _nodes(m)
            n = nt.nodes.new("ShaderNodeTexImage")
            n.name = "cobuild bake"
            n.image = img
            nt.nodes.active = n
            nodes.append((m, n))
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, margin=8, use_clear=True)
        img.pack()
        for k, m in enumerate(me.materials):
            if m is None:
                continue
            c = m.copy()
            nt = c.node_tree
            n = nt.nodes.get("cobuild bake")
            bsdf = next((x for x in nt.nodes if x.type == "BSDF_PRINCIPLED"), None)
            if n is not None and bsdf is not None:
                for ln in list(bsdf.inputs["Base Color"].links):
                    nt.links.remove(ln)
                nt.links.new(n.outputs["Color"], bsdf.inputs["Base Color"])
            me.materials[k] = c
        for m, n in nodes:                                   # (the scene's own materials as they were)
            m.node_tree.nodes.remove(n)
        for uv in list(me.uv_layers):
            if uv.name != "BakeUV":
                me.uv_layers.remove(uv)
        me.uv_layers["BakeUV"].name = "UVMap"
        notes.append("主人接的程序化材料烘成了一张 %d × %d 的图再导出" % (side, side))
        return True
    except Exception as e:  # noqa: BLE001 - the house goes out flat rather than not at all
        try:
            if bpy.context.object and bpy.context.object.mode != "OBJECT":
                bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:  # noqa: BLE001
            pass
        notes.append("主人接的程序化材料没烘成（%s），那几处导出的是纯色" % str(e)[:80])
        return False
    finally:
        sc.render.engine = prev


def _images_of(obs) -> list:
    seen, out = set(), []
    for ob in obs:
        for m in ob.data.materials:
            if m is None or m.node_tree is None:
                continue
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image is not None and n.image.name not in seen and any(o.is_linked for o in n.outputs):
                    seen.add(n.image.name)
                    out.append(n.image)
    return out


def fit_textures(imgs, limits: dict, notes: list) -> list:
    """每张最长边不超过 tex_px；几张加起来不超过 tex_px_sum（超了按比例一起缩小）。-> 每张的 [宽, 高]，大的在前。"""
    shrunk = 0
    for im in imgs:
        w, h = im.size
        if w and h and max(w, h) > limits["tex_px"]:
            k = limits["tex_px"] / max(w, h)
            im.scale(max(1, int(w * k)), max(1, int(h * k)))
            shrunk += 1
    if shrunk:
        notes.append("%d 张贴图大于 %d 像素，缩小了" % (shrunk, limits["tex_px"]))
    total, cap = sum(im.size[0] * im.size[1] for im in imgs), tex_budget(limits)
    if total > cap:
        k = math.sqrt(cap / total) * 0.995
        for im in imgs:
            w, h = im.size
            im.scale(max(8, int(w * k)), max(8, int(h * k)))
        notes.append("贴图加起来 %s，超了上限 %s：都按比例缩小了" % (px_words(total), px_words(cap)))
    for im in imgs:
        if im.is_dirty:
            try:
                im.pack()
            except Exception:  # noqa: BLE001
                pass
    return sorted(([im.size[0], im.size[1]] for im in imgs), reverse=True)


def export_house(bpy, parts, path: str, vertex_mode: str, limits: dict, notes: list, extra=(), lights: bool = False) -> list:
    """量好的那几份（eval_copies）-> glb。我们的 14 种材料的面合成 house（顶点色 + 材料号，和以前一样）；带图的面、主人自己的材料合成
    house_tex（只一套 UV、不带材料号）；主人接的程序化材料先烘成图，也进 house_tex。-> 导出的贴图 [宽, 高]。"""
    groups = {"town": [], "own": [], "proc": []}
    for p in parts:
        kinds = [_mat_kind(m) for m in p.data.materials] or ["own"]
        if len(set(kinds)) == 1:
            groups[kinds[0]].append(p)
            continue
        for kind in set(kinds):
            sub = _split(bpy, p, {i for i, kd in enumerate(kinds) if kd == kind}, "%s %s" % (p.name, kind))
            if sub is not None:
                groups[kind].append(sub)
        bpy.data.objects.remove(p)
    outs, own = [], list(groups["own"])
    for p in own:
        _one_uv(p.data, notes)
    if groups["proc"]:
        baked = _join(bpy, groups["proc"], "house_baked")
        used = sum(im.size[0] * im.size[1] for im in _images_of([o for o in groups["town"] + own]))
        bake_procedural(bpy, baked, limits, max(128 * 128, tex_budget(limits) - used), notes)
        _one_uv(baked.data, notes)
        own.append(baked)
    if groups["town"]:
        for p in groups["town"]:
            _town_layers(p.data)
        house = _join(bpy, groups["town"], "house")
        flats = {}
        for k, m in enumerate(house.data.materials):
            if m is not None:
                if m.name not in flats:
                    flats[m.name] = _flat_copy(bpy, m)
                house.data.materials[k] = flats[m.name]
        outs.append(house)
    if own:
        outs.append(_join(bpy, own, "house_tex"))
    tex = fit_textures(_images_of(outs), limits, notes)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in list(outs) + list(extra):
        o.select_set(True)
    bpy.context.view_layer.objects.active = outs[0]
    keys = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_apply=False, export_normals=True, export_texcoords=True,
              export_animations=False, export_cameras=False, export_lights=lights, export_extras=False, export_draco_mesh_compression_enable=False,
              export_materials="EXPORT", export_image_format="AUTO", export_vertex_color=vertex_mode, export_all_vertex_colors=False,
              export_active_vertex_color_when_no_material=True)
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in keys or k == "filepath"})
    for o in outs:                                           # (the scene keeps only her own objects: the pictures are taken of those)
        bpy.data.objects.remove(o)
    return tex


# --- 预览图：EEVEE（看得见质感、图案、自己的图），起不来退 Cycles，再不行退 Workbench ---------------------------------------------
def preview_engines(want: str) -> list:
    if want == "auto":
        gpu = os.name == "nt" or sys.platform == "darwin" or bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")) or \
            os.path.exists("/dev/dri/renderD128")
        want = "eevee" if gpu else "cycles"
    return {"eevee": ["eevee", "cycles", "workbench"], "cycles": ["cycles", "workbench"]}.get(want, ["workbench"])


CYCLES_SAMPLES = 12


def _use_engine(sc, eng: str, color_type: str) -> None:
    if eng == "eevee":
        for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            try:
                sc.render.engine = name
                break
            except TypeError:
                continue
        else:
            raise RuntimeError("这个 Blender 没有 EEVEE")
        try:
            sc.eevee.taa_render_samples = 32
        except Exception:  # noqa: BLE001
            pass
    elif eng == "cycles":                                  # (没显卡的机器上也是它：样本少、反弹少、降噪，三张图十几秒)
        sc.render.engine = "CYCLES"
        sc.cycles.samples = CYCLES_SAMPLES
        for k, v in (("device", "CPU"), ("use_denoising", True), ("max_bounces", 3), ("diffuse_bounces", 2), ("glossy_bounces", 1),
                     ("transmission_bounces", 2), ("use_adaptive_sampling", True), ("time_limit", 20.0)):
            try:
                setattr(sc.cycles, k, v)
            except Exception:  # noqa: BLE001
                pass
    else:
        sc.render.engine = "BLENDER_WORKBENCH"
        sh = sc.display.shading
        sh.light, sh.color_type, sh.show_shadows, sh.show_cavity = "STUDIO", color_type, True, True
        if color_type == "VERTEX":                           # 带图的面用它的底色（Workbench 画不出图案和图）
            for ob in sc.objects:
                ca = ob.data.color_attributes if ob.type == "MESH" else None
                if ca is not None and "Base" in ca:
                    ca.active_color = ca["Base"]
                    try:
                        ca.render_color_index = ca.active_color_index
                    except Exception:  # noqa: BLE001
                        pass
    try:                                                     # Cycles 有屋里的反光，亮处容易冲白：用 AgX 压一压；别的照原色
        sc.view_settings.view_transform = "AgX" if eng == "cycles" else "Standard"
        sc.view_settings.look = "None"
    except Exception:  # noqa: BLE001
        pass


def _light_scene(bpy, sc, inside: bool) -> list:
    """天光（外面亮、屋里暗一点）+ 外面一个太阳。-> 加进去的物体（画完删）。"""
    if sc.world is None:
        sc.world = bpy.data.worlds.new("sky")
    w = sc.world
    sky = (0.2, 0.2, 0.22) if inside else (0.62, 0.78, 0.9)
    w.color = sky
    try:
        if w.node_tree is None:
            w.use_nodes = True
        bg = next((n for n in w.node_tree.nodes if n.type == "BACKGROUND"), None)
        if bg is not None:
            bg.inputs["Color"].default_value = (0.55, 0.62, 0.7, 1.0) if inside else (0.5, 0.65, 0.85, 1.0)
            bg.inputs["Strength"].default_value = 0.35 if inside else 0.8
    except Exception:  # noqa: BLE001
        pass
    if inside:
        return []
    ld = bpy.data.lights.new("preview sun", "SUN")
    ld.energy, ld.angle = 3.2, math.radians(4)
    ob = bpy.data.objects.new("preview sun", ld)
    ob.rotation_euler = (math.radians(48), 0.0, math.radians(-35))
    sc.collection.objects.link(ob)
    return [ob]


def _shoot(bpy, sc, engines, color_type: str, shots, out_dir: str, px: int, notes: list) -> list:
    """shots：[(名字, 摆相机的函数)]。照 engines 的次序试，一种画不出来换下一种。"""
    out_dir = os.path.abspath(out_dir)                    # (a relative render path is read against the drive's root, not the cwd)
    os.makedirs(out_dir, exist_ok=True)
    sc.render.film_transparent = False
    sc.render.resolution_x = sc.render.resolution_y = px
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    why = []
    for eng in engines:
        try:
            _use_engine(sc, eng, color_type)
            files = []
            for name, aim in shots:
                aim(name)
                path = os.path.join(out_dir, name + ".png")
                sc.render.filepath = path
                bpy.ops.render.render(write_still=True)
                if os.path.isfile(path):
                    files.append(path)
            if files:
                if why:
                    notes.append("预览图用 %s 画的（%s）" % (eng, "；".join(why)[:120]))
                return files
        except Exception as e:  # noqa: BLE001 - try the next way of drawing
            why.append("%s 没画成：%s" % (eng, str(e)[:60]))
    raise RuntimeError("；".join(why)[:160] or "画不出来")


def render_previews(bpy, num: dict, lot, out_dir: str, px: int, engines, color_type: str, notes: list) -> list:
    """Three small pictures: front (from the door side), three-quarter, top."""
    from mathutils import Vector
    sc = bpy.context.scene
    added = _light_scene(bpy, sc, False)
    x0, z0, x1, z1 = num["bbox"]
    h = max(num["h"], 1.0)
    size = max(x1 - x0, z1 - z0, h, 2.0)
    if lot:
        size = max(size, lot["w"], lot["d"])
    ctr = Vector(_to_b(((x0 + x1) / 2, h * 0.45, (z0 + z1) / 2)))
    cam = bpy.data.objects.new("preview cam", bpy.data.cameras.new("preview cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.clip_end = size * 20 + 100
    views = {"front": Vector(_to_b((0.0, 0.32, 1.0))).normalized(), "three_quarter": Vector(_to_b((0.62, 0.55, 0.78))).normalized()}

    def aim(name):
        if name == "top":
            cam.data.type = "ORTHO"
            cam.data.ortho_scale = size * 1.15
            cam.location = Vector((ctr.x, ctr.y, h + size * 2 + 5))
            cam.rotation_euler = (0.0, 0.0, 0.0)
        else:
            cam.data.type = "PERSP"
            cam.data.lens = 50
            cam.location = ctr + views[name] * size * 2.3
            cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
    try:
        return _shoot(bpy, sc, engines, color_type, [(n, aim) for n in PREVIEWS], out_dir, px, notes)
    finally:
        bpy.data.objects.remove(cam)
        for o in added:
            bpy.data.objects.remove(o)


def _color_type(bpy, obs) -> str:
    """Workbench 照什么上色：配方做的（带图的面另记着底色 Base）照顶点色；她自己的文件有图照图，有顶点色照顶点色，不然照材料色。"""
    if any(ob.type == "MESH" and "Base" in ob.data.color_attributes for ob in obs):
        return "VERTEX"
    has_tex = any(n.type == "TEX_IMAGE" and n.image for ob in obs for sl in ob.material_slots if sl.material and sl.material.node_tree
                  for n in sl.material.node_tree.nodes)
    if has_tex:
        return "TEXTURE"
    return "VERTEX" if any(len(ob.data.color_attributes) for ob in obs) else "MATERIAL"


def _empty(bpy, name: str, p, coll):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type, e.empty_display_size = "PLAIN_AXES", 0.3
    e.location = _to_b(p)
    coll.objects.link(e)
    return e


def _lamp(bpy, k: int, lt: dict, coll):
    ld = bpy.data.lights.new("light %d" % (k + 1), "POINT")
    ld.energy, ld.color, ld.shadow_soft_size = lt["power"], _lin(lt["color"]), 0.25
    ob = bpy.data.objects.new("light %d" % (k + 1), ld)
    ob.location = _to_b(lt["at"])
    coll.objects.link(ob)
    return ob


def _base_name(name: str) -> str:
    n = str(name).lower()
    head, dot, tail = n.rpartition(".")
    return head if dot and tail.isdigit() else n                # Blender's own .001


def render_inside_previews(bpy, room: dict, hide_top: list, out_dir: str, px: int, engines, color_type: str, notes: list) -> list:
    """三张：front 站在门里（一层；别的层在一面墙边）往里看，three_quarter 从一个角斜着看，top 从上往下（天花板拿掉）。"""
    from mathutils import Vector
    sc = bpy.context.scene
    _light_scene(bpy, sc, True)
    x0, z0, x1, z1 = room["foot"]
    h, cx, cz = room["h"], (x0 + x1) / 2, (z0 + z1) / 2
    cam = bpy.data.objects.new("preview cam", bpy.data.cameras.new("preview cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.clip_start, cam.data.clip_end = 0.05, 500
    fill = bpy.data.objects.new("preview fill", bpy.data.lights.new("preview fill", "POINT"))
    fill.data.energy, fill.data.shadow_soft_size = 40.0, 1.0
    sc.collection.objects.link(fill)
    d = inside_door(room)
    eye = (d[0], 1.5, d[2]) if d else (cx, 1.5, z1 - WALL_T - 0.4)

    def aim(name):
        for o in hide_top:
            o.hide_render = name == "top"
        if name == "top":
            cam.data.type, cam.data.ortho_scale = "ORTHO", max(x1 - x0, z1 - z0) * 1.1
            cam.location, cam.rotation_euler = Vector(_to_b((cx, h + 20, cz))), (0.0, 0.0, 0.0)
            fill.location = Vector(_to_b((cx, h - 0.4, cz)))
        else:
            cam.data.type, cam.data.lens = "PERSP", 16
            at = eye if name == "front" else (x1 - WALL_T - 0.3, max(1.6, h - 0.3), z1 - WALL_T - 0.3)
            look = (cx, 1.0, cz) if name == "front" else (cx - (x1 - x0) * 0.15, 0.4, cz - (z1 - z0) * 0.15)
            cam.location = Vector(_to_b(at))
            cam.rotation_euler = (Vector(_to_b(look)) - cam.location).to_track_quat("-Z", "Y").to_euler()
            fill.location = cam.location
    try:
        return _shoot(bpy, sc, engines, color_type, [(n, aim) for n in PREVIEWS], out_dir, px, notes)
    finally:
        for o in hide_top:
            o.hide_render = False
        bpy.data.objects.remove(cam)
        bpy.data.objects.remove(fill)


def _read_json(path: str):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as e:
        raise Fail("配方不是能读的 JSON：%s" % str(e)[:120])


def run_inside(a) -> dict:
    """--room：一层室内。配方 -> 地板、墙、天花板（照占地和层高）+ 家具 + 灯 + 空点；或者主人改过的 .blend / 一个 .glb（照原样，空点和灯按名字认）。"""
    import bpy
    t0 = time.time()
    notes = []
    try:
        room, limits = read_room(a.room)
    except (OSError, ValueError) as e:
        raise Fail("room.json 读不了：%s" % str(e)[:160])
    _clear_scene(bpy)
    sc = bpy.context.scene
    ctx = Ctx(a.images, limits, notes)
    keep, ceiling, parts_named, top, pts, ins = [], [], None, None, {}, None
    if a.recipe:
        mode = "recipe"
        obj = _read_json(a.recipe)
        why, ins = read_inside(obj, room, limits)
        if why:
            raise Fail(*why)
        est = sum(tris_of(s) for s in ins["shapes"])
        if est > limits["tris"] * 4:
            raise Fail("太重了：大约 %d 个面，一层最多 %d" % (est, limits["tris"]))
        fx0, fz0, fx1, fz1 = room["foot"]
        notes += nudge_in(ins["shapes"], (fx0 + WALL_T, fz0 + WALL_T, fx1 - WALL_T, fz1 - WALL_T))
        rc, fc, pc = (bpy.data.collections.new(n) for n in ("room", "furniture", "points"))
        for c in (rc, fc, pc):
            sc.collection.children.link(c)
        for k, s in enumerate(room_shapes(room, ins["surfaces"])):
            for j, ob in enumerate(build_shape_object(bpy, s, 900 + k, rc, ctx)):
                ob.name = "room %s %d%s" % (s["role"], k + 1, " tex" if j else "")
                if s["role"] == "ceiling":
                    ceiling.append(ob)
        for k, s in enumerate(ins["shapes"]):
            build_shape_object(bpy, s, k, fc, ctx)
        if ins["shapes"]:
            parts_named = recipe_parts(ins["raw_shapes"], ins["shapes"])
            top = round(max(p[1] for s in ins["shapes"] for p in placed(s)), 2)
        pts = dict(ins["points"])
        d = inside_door(room)
        if d:
            pts["door"] = d
        for name, p in pts.items():
            keep.append(_empty(bpy, name, p, pc))
        for k, lt in enumerate(ins["lights"]):
            keep.append(_lamp(bpy, k, lt, pc))
        if any(lt.get("auto") for lt in ins["lights"]):
            notes.append("没写灯：天花板正中挂了一盏 150 瓦的")
    else:
        mode = "blend" if a.from_blend else "glb"
        try:
            if a.from_blend:
                _safe_prefs(bpy)
                bpy.ops.wm.open_mainfile(filepath=os.path.abspath(a.from_blend), load_ui=False, use_scripts=False)
                _safe_prefs(bpy)
                sc = bpy.context.scene
            else:
                bpy.ops.import_scene.gltf(filepath=os.path.abspath(a.from_glb))
        except Exception as e:  # noqa: BLE001
            raise Fail("这个文件打不开：%s" % str(e)[:160])
        _strip_outside_files(bpy, notes)
        for ob in sc.objects:
            nm = _base_name(ob.name)
            if ob.type == "LIGHT" and len([o for o in keep if o.type == "LIGHT"]) < limits["lights"]:
                keep.append(ob)
            elif ob.type == "EMPTY" and (nm == "door" or _point_name(nm) or (nm.startswith("seat_") and nm[5:].isdigit())):
                keep.append(ob)
                pts[nm] = _from_b(ob.matrix_world.translation)
            elif ob.type == "MESH" and ("ceiling" in nm or "天花" in nm):
                ceiling.append(ob)
        if room.get("door") and "door" not in pts:
            notes.append("文件里没有叫 door 的空点：岛上用离正门最近的地面点")
    obs = _build_objects(bpy)
    fit_textures(_images_of(obs), limits, notes)
    if a.out_blend:
        os.makedirs(os.path.dirname(os.path.abspath(a.out_blend)), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.out_blend), compress=True, copy=True)
    files = {"glb": os.path.abspath(a.out_glb), "blend": os.path.abspath(a.out_blend) if a.out_blend else None, "previews": []}
    parts = eval_copies(bpy, obs)
    num, _ = measure_parts(parts)
    num["objects"] = len(obs)
    if mode == "recipe":
        num["shapes"] = len(ins["shapes"])
        num["furniture_top"] = top
    num["textures"] = export_house(bpy, parts, a.out_glb, "ACTIVE" if mode == "recipe" else "MATERIAL", limits, notes, extra=keep, lights=True)
    num["kb"] = max(1, int(math.ceil(os.path.getsize(a.out_glb) / 1024)))
    if a.out_blend and os.path.isfile(a.out_blend):
        num["blend_kb"] = max(1, int(math.ceil(os.path.getsize(a.out_blend) / 1024)))
    num.update(floor=room["floor"], room=[round(q, 2) for q in room["foot"]], room_h=room["h"], lights=len([o for o in keep if o.type == "LIGHT"]),
               points={k: [round(q, 2) for q in v] for k, v in sorted(pts.items())})
    P = inside_problems(num, room, limits, parts_named, {k: v for k, v in pts.items() if k != "door"})
    notes.insert(0, budget_line(num, limits, "这一层"))
    out = {"ok": True, "mode": mode, "inside": True, "numbers": num, "problems": P, "notes": notes, "files": files, "secs": round(time.time() - t0, 1)}
    if a.previews:
        emit(out, a.json_out, line=False)                    # (画预览图之前先存一份：Blender 画图时崩了，草稿也有结果)
        try:
            files["previews"] = render_inside_previews(bpy, room, ceiling, a.previews, a.px, preview_engines(a.preview_engine),
                                                       _color_type(bpy, obs), notes)
        except Exception as e:  # noqa: BLE001 - the numbers stand without the pictures
            notes.append("预览图没出来：%s" % str(e)[:120])
    out["secs"] = round(time.time() - t0, 1)
    return out


def run(a) -> dict:
    if a.room:
        return run_inside(a)
    import bpy
    t0 = time.time()
    notes = []
    lot, limits = read_lot(a.lot)
    _clear_scene(bpy)
    sc = bpy.context.scene
    ctx = Ctx(a.images, limits, notes)
    parts_named, shapes = None, None
    if a.recipe:
        mode = "recipe"
        obj = _read_json(a.recipe)
        why, shapes = read_recipe(obj, limits)
        if why:
            raise Fail(*why)
        est = sum(tris_of(s) for s in shapes)
        if est > limits["tris"] * 4:
            raise Fail("太重了：大约 %d 个面，最多 %d" % (est, limits["tris"]))
        if lot and not lot.get("poly_uv"):                   # (多边形的地照旧：斜边上推哪边说不清)
            hw, hd = lot["w"] / 2, lot["d"] / 2
            kb = keep_box(lot)                               # 要留边的：推进能盖的范围（主人 11-25 定 0.5 米），推完还不够的照样判问题
            notes += nudge_in(shapes, kb or (-hw, -hd, hw, hd), whole=True, wall="地界", edge=keep_edge(lot) if kb else None)
        coll = bpy.data.collections.new("house")
        sc.collection.children.link(coll)
        for k, s in enumerate(shapes):
            build_shape_object(bpy, s, k, coll, ctx)
        parts_named = recipe_parts(recipe_shapes(obj), shapes, feet=True)
        door_raw = recipe_door(obj)
    elif a.from_blend:
        mode = "blend"
        _safe_prefs(bpy)
        try:
            bpy.ops.wm.open_mainfile(filepath=os.path.abspath(a.from_blend), load_ui=False, use_scripts=False)
        except Exception as e:  # noqa: BLE001
            raise Fail("这个 .blend 打不开：%s" % str(e)[:160])
        _safe_prefs(bpy)
        sc = bpy.context.scene
        _strip_outside_files(bpy, notes)
    else:
        mode = "glb"
        try:
            bpy.ops.import_scene.gltf(filepath=os.path.abspath(a.from_glb))
        except Exception as e:  # noqa: BLE001
            raise Fail("这个 .glb 读不进来：%s" % str(e)[:160])
        _strip_outside_files(bpy, notes)
    if lot and not bpy.data.collections.get(LOT_COLLECTION):
        add_lot(bpy, lot, sc)
    obs = _build_objects(bpy)
    other = [o.type for o in sc.objects if o.type in ("CURVE", "FONT", "SURFACE", "META", "CURVES", "POINTCLOUD", "VOLUME", "GPENCIL", "GREASEPENCIL")]
    if other:
        notes.append("有 %d 个不是网格的东西（曲线、文字……）没导出：Blender 里先 Object > Convert > Mesh" % len(other))
    fit_textures(_images_of(obs), limits, notes)
    if a.out_blend:                                       # the .blend he may edit: the shapes as separate objects, the lot beside them
        os.makedirs(os.path.dirname(os.path.abspath(a.out_blend)), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.out_blend), compress=True, copy=True)
    boxes = None if mode == "recipe" else []              # (a recipe names its shapes by number; a .blend / .glb by its objects' names)
    parts = eval_copies(bpy, obs, boxes=boxes)
    if boxes is not None:
        parts_named = boxes if len(boxes) > 1 else None   # (one object is the whole house: naming it says nothing)
    num, _ = measure_parts(parts, foot=True)              # foot：多边形的地照楼从上往下看的外轮廓查出界（11-25）
    owner_high = door_high_parts(parts) if mode != "recipe" else None    # (before the export: it joins the parts into one)
    num["objects"] = len(obs)
    if mode == "recipe":
        num["shapes"] = len(shapes)
    num["textures"] = export_house(bpy, parts, a.out_glb, "ACTIVE" if mode == "recipe" else "MATERIAL", limits, notes)
    num["kb"] = max(1, int(math.ceil(os.path.getsize(a.out_glb) / 1024)))
    if a.out_blend and os.path.isfile(a.out_blend):
        num["blend_kb"] = max(1, int(math.ceil(os.path.getsize(a.out_blend) / 1024)))
    files = {"glb": os.path.abspath(a.out_glb), "blend": os.path.abspath(a.out_blend) if a.out_blend else None, "previews": []}
    P = problems_of(num, lot, limits, parts_named)
    if mode in ("recipe", "blend", "glb"):                   # 门在楼上（11-26）：判问题；量出来的数带回去，插件交楼时岛上照它退
        high = door_high(shapes) if mode == "recipe" else owner_high                    # 主人自己传的（11-27）：照物体的名字认门
        if high is None and mode != "recipe":
            notes.append(NO_DOOR_LINE)                       # 认不出门：不拦，说一句怎么让岛上查得了
        if high is not None:
            num["door_high"] = high
            if door_high_words(high):
                P.append(door_high_words(high))
    if mode == "recipe" and door_raw is not None:            # 门（11-23）：写了就带回去，岛上照它开门；不写岛上照朝着最近的路的那一面开
        why, door = read_door(door_raw, num["bbox"])
        P += why
        if door is not None:
            num["door"] = door
    notes.insert(0, budget_line(num, limits))
    out = {"ok": True, "mode": mode, "numbers": num, "problems": P, "notes": notes, "files": files, "secs": round(time.time() - t0, 1)}
    if a.previews:
        emit(out, a.json_out, line=False)                    # (画预览图之前先存一份：Blender 画图时崩了，草稿也有结果)
        try:
            files["previews"] = render_previews(bpy, num, lot, a.previews, a.px, preview_engines(a.preview_engine), _color_type(bpy, obs), notes)
        except Exception as e:  # noqa: BLE001 - the numbers stand without the pictures
            notes.append("预览图没出来：%s" % str(e)[:120])
    out["secs"] = round(time.time() - t0, 1)
    return out


def main(argv=None):
    argv = sys.argv[sys.argv.index("--") + 1:] if argv is None and "--" in sys.argv else (argv or [])
    a = parse_args(argv)
    try:
        out = run(a)
    except Fail as e:
        emit({"ok": False, "why": e.why[:5]}, a.json_out)
        sys.exit(2)
    except Exception as e:  # noqa: BLE001 - one line for whoever reads it, never a traceback only
        emit({"ok": False, "why": ["做模型的脚本出错了：%s: %s" % (type(e).__name__, str(e)[:200])]}, a.json_out)
        sys.exit(2)
    emit(out, a.json_out)


if __name__ == "__main__":
    main()
