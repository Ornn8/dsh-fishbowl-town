"""主人和鱼一起盖楼：把配方（形状清单，纯数据）做成 Blender 场景，存 .blend 和 .glb，出三张预览图，量尺寸。

插件（DSH 鱼缸小镇、AstrBot）原样带上这一个文件，在用户自己的电脑上跑；岛上的建造工人给托管的鱼用同一个文件。

    blender -b --factory-startup -P recipe_to_blend.py -- --recipe r.json --out-blend b.blend --out-glb b.glb --previews DIR [--lot lot.json]
    blender -b --factory-startup -P recipe_to_blend.py -- --from-blend b.blend --out-glb b.glb --previews DIR [--out-blend b2.blend] [--lot lot.json]
    blender -b --factory-startup -P recipe_to_blend.py -- --from-glb m.glb --out-blend b.blend --out-glb b.glb --previews DIR [--lot lot.json]
    （都可以再加 --json-out result.json：同一份结果另存一个文件）

楼的配方可以带 "door": {"side": "front|back|left|right", "at": 米}：门开在哪一面、离那一面正中几米（量出来的数里带回 door）。

室内（11-23 主人「内部装修是必须的」）：加 --room room.json，配方就是一层的室内：地板、墙、天花板照楼的占地和层高自动做，家具用同样的
形状，灯、楼梯点、桌子座位另写；做出来的 glb 就是岛上 tools/build.py interior 收的一层（带 door / stairs_* / table / seat_n 空点和灯）。

    blender -b --factory-startup -P recipe_to_blend.py -- --room room.json --recipe in.json --out-blend f1.blend --out-glb floor1.glb --previews DIR
    room.json：{"foot": [x0, z0, x1, z1]（楼的占地，地块自己的坐标）, "h": 层高, "floor": 第几层, "floors": 一共几层,
                "door": {"side", "at"}（楼的正门，只一层用）, "limits"?: {…}}

最后打印一行 JSON（以 {"cobuild": 开头）：{"cobuild": 1, "ok", "mode", "numbers", "problems", "notes", "files", "secs"}；
做不出来是 {"cobuild": 1, "ok": false, "why": [...]}，退出码 2。格式和上限见同目录的 README.md。

安全：配方只是数据，这里从不执行配方里的任何东西（没有 eval / exec，不导入别的模块）。打开 .blend 时关掉自动运行脚本
（Blender 的默认，这里再明确关一次），连着别的 .blend 文件的（库链接）不收，没打包进文件的外部贴图去掉不读。"""
import json
import math
import os
import sys
import time

VERSION = 1
TYPES = ("box", "cylinder", "cone", "sphere", "dome", "wedge", "pyramid", "gable", "prism")
# 和岛上一样的 14 种材料（town_play/worlds/isle/buildings.py MATERIALS，岛的 tools/build_bl.py MATS）；后面的数是岛上着色器认的材料号
MATERIALS = {"paint": 0, "plaster": 1, "brick": 2, "stone": 3, "wood": 4, "tile": 5, "slate": 6, "glass": 7, "metal": 8, "cloth": 9,
             "glow": 11, "water": 12, "pave": 14, "bark": 15}
# 页面带得动的线（岛的价目表 building.limits）；lot.json 里的 limits 会盖过这些
LIMITS = {"tris": 150000, "kb": 6144, "tex_n": 4, "tex_px": 1024, "h": 300, "shapes": 4000, "shapes_json_kb": 1024}
DEFAULT_COLOR = 0xE9E2D4
LOT_COLLECTION = "LOT (not exported)"
PREVIEWS = ("front", "three_quarter", "top")
PREVIEW_PX = 512
EDGE_EPS = 0.01                     # 和岛上量楼一样：伸出地界 1 厘米以内不算


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


def _nums(sh, key, n, k, why, default=None):
    v = sh.get(key, default)
    if not (isinstance(v, (list, tuple)) and len(v) >= n and all(_finite(q) for q in v[:n])):
        why.append("第 %d 个形状（%s）的 %s 要写成 %d 个数" % (k + 1, sh.get("type"), key, n))
        return None
    return [float(q) for q in v[:n]]


def _num(sh, key, k, why, default=None, positive=True):
    v = sh.get(key, default)
    if not _finite(v) or (positive and v <= 0):
        why.append("第 %d 个形状（%s）缺 %s，或它不是一个大于 0 的数" % (k + 1, sh.get("type"), key))
        return None
    return float(v)


def check_shape(sh, k: int) -> tuple:
    """一个形状 -> (问题列表, 读好的形状 | None)。读好的：{type, mat, color, pos, rot, seg, 尺寸…}。"""
    why = []
    if not isinstance(sh, dict) or sh.get("type") not in TYPES:
        return ["第 %d 个形状的 type 要是这几种之一：%s" % (k + 1, "、".join(TYPES))], None
    t = sh["type"]
    mat = str(sh.get("material", "paint")).lower()
    if mat not in MATERIALS:
        return ["第 %d 个形状的 material 要是这几种之一：%s" % (k + 1, "、".join(MATERIALS))], None
    c = color_value(sh.get("color"))
    if c is None:
        return ["第 %d 个形状的颜色看不懂（写成 \"#f2e2c4\" 或 [242, 226, 196]）" % (k + 1)], None
    out = {"type": t, "mat": mat, "color": c, "pos": _nums(sh, "pos", 3, k, why, [0, 0, 0]), "rot": _nums(sh, "rot", 3, k, why, [0, 0, 0])}
    seg = sh.get("seg", 18)
    out["seg"] = int(max(3, min(48, seg))) if _finite(seg) else 18
    if t in ("box", "wedge", "pyramid", "gable"):
        size = _nums(sh, "size", 3, k, why)
        if size is not None and min(size) <= 0:
            why.append("第 %d 个形状（%s）的 size 三个数都要大于 0" % (k + 1, t))
        out["size"] = size
    elif t in ("cylinder", "cone"):
        out["r"], out["h"] = _num(sh, "r", k, why), _num(sh, "h", k, why)
        r2 = sh.get("r2", out["r"]) if t == "cylinder" else 0.0
        if not _finite(r2) or r2 < 0:
            why.append("第 %d 个形状（cylinder）的 r2 要是一个不小于 0 的数" % (k + 1))
            r2 = 0.0
        out["r2"] = float(r2)
    elif t in ("sphere", "dome"):
        if isinstance(sh.get("size"), (list, tuple)):
            size = _nums(sh, "size", 3, k, why)
            if size is not None and min(size) <= 0:
                why.append("第 %d 个形状（%s）的 size 三个数都要大于 0" % (k + 1, t))
            out["radii"] = size
        else:
            r = _num(sh, "r", k, why)
            out["radii"] = [r, r, r] if r is not None else None
    elif t == "prism":
        pts = sh.get("points")
        if not (isinstance(pts, list) and len(pts) >= 3 and all(isinstance(q, (list, tuple)) and len(q) == 2 and all(_finite(x) for x in q) for q in pts)):
            why.append("第 %d 个形状（prism）的 points 要是至少三个 [x, z]" % (k + 1))
        else:
            out["points"] = [(float(a), float(b)) for a, b in pts[:64]]
        out["h"] = _num(sh, "h", k, why)
    return why, (None if why else out)


def read_recipe(obj, limits: dict) -> tuple:
    """配方 -> (问题列表, 读好的形状列表)。只读数据，什么都不执行。"""
    raw = json.dumps(obj, ensure_ascii=False)
    if len(raw.encode("utf-8")) > limits["shapes_json_kb"] * 1024:
        return ["配方有 %d KB，最多 %d KB" % (len(raw.encode("utf-8")) // 1024, limits["shapes_json_kb"])], []
    shapes = recipe_shapes(obj)
    if shapes is None:
        return ['配方要写成 {"shapes": [形状, …]}'], []
    if not shapes:
        return ["配方里一个形状都没有"], []
    if len(shapes) > limits["shapes"]:
        return ["配方里有 %d 个形状，最多 %d 个" % (len(shapes), limits["shapes"])], []
    why, out = [], []
    for k, sh in enumerate(shapes):
        w, s = check_shape(sh, k)
        why += w
        if s is not None:
            out.append(s)
        if len(why) >= 5:
            break
    return why[:5], out


# --- geometry in the island's frame: x right, y up, z towards the lot's front (the door); origin = the lot's middle on its bed ------
def _ring(rx, rz, y, seg):
    return [(math.cos(2 * math.pi * i / seg) * rx, y, math.sin(2 * math.pi * i / seg) * rz) for i in range(seg)]


def shape_geometry(s: dict) -> tuple:
    """-> (verts, faces, smooth: [bool per face], sharp: set of (i, j) edges)。和岛上的 build_bl.py 一样的形状：pos 是形状底面的正中。"""
    t, V, F, S, sharp = s["type"], [], [], [], set()

    def add(face, smooth=False):
        F.append(tuple(face))
        S.append(smooth)
    if t == "box":
        w, h, d = s["size"]
        for y in (0.0, h):
            V += [(-w / 2, y, -d / 2), (w / 2, y, -d / 2), (w / 2, y, d / 2), (-w / 2, y, d / 2)]
        for f in ((0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
            add(f)
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
    return V, F, S, sharp


def _rot(axis, a):
    c, s = math.cos(a), math.sin(a)
    if axis == "x":
        return ((1, 0, 0), (0, c, -s), (0, s, c))
    if axis == "y":
        return ((c, 0, s), (0, 1, 0), (-s, 0, c))
    return ((c, -s, 0), (s, c, 0), (0, 0, 1))


def _mm(A, B):
    return tuple(tuple(sum(A[i][k] * B[k][j] for k in range(3)) for j in range(3)) for i in range(3))


def placed(s: dict) -> list:
    """The shape's corners where they stand on the lot: turned about y, then x, then z (岛的 kit：at(x, y, z, ry, rx, rz)), then moved to pos."""
    V = shape_geometry(s)[0]
    rx, ry, rz = (math.radians(a) for a in s["rot"])
    R = _mm(_mm(_rot("y", ry), _rot("x", rx)), _rot("z", rz))
    px, py, pz = s["pos"]
    return [(R[0][0] * x + R[0][1] * y + R[0][2] * z + px, R[1][0] * x + R[1][1] * y + R[1][2] * z + py,
             R[2][0] * x + R[2][1] * y + R[2][2] * z + pz) for x, y, z in V]


def tris_of(s: dict) -> int:
    _, F, _, _ = shape_geometry(s)
    return sum(len(f) - 2 for f in F)


# --- measuring and the lot ----------------------------------------------------------------------------------------------------------
def numbers_of(points, tris: int) -> dict:
    """All corners (island frame) -> the numbers the island measures: bbox [x0, z0, x1, z1], h, below, footprint (the outer box), volume."""
    xs, ys, zs = [p[0] for p in points], [p[1] for p in points], [p[2] for p in points]
    x0, x1, z0, z1, y0, y1 = min(xs), max(xs), min(zs), max(zs), min(ys), max(ys)
    num = {"bounds": {"min": [round(x0, 3), round(y0, 3), round(z0, 3)], "max": [round(x1, 3), round(y1, 3), round(z1, 3)]},
           "bbox": [round(x0, 2), round(z0, 2), round(x1, 2), round(z1, 2)], "h": round(max(0.0, y1), 2), "below": round(max(0.0, -y0), 2),
           "footprint_m2": round((x1 - x0) * (z1 - z0), 1), "tris": int(tris)}
    num["volume_m3"] = round(num["footprint_m2"] * num["h"], 1)
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


def box_of(points) -> list:
    """一组角（岛的坐标）-> 占地的外接框 [x0, z0, x1, z1]，和 numbers_of 一样取两位小数。"""
    xs, zs = [p[0] for p in points], [p[2] for p in points]
    return [round(min(xs), 2), round(min(zs), 2), round(max(xs), 2), round(max(zs), 2)]


def _name_part(text, n: int) -> str:
    return "".join(c for c in str(text) if c.isprintable() and c not in "「」").strip()[:n]


def recipe_parts(raw, shapes) -> list:
    """配方的每个形状 -> (怎么称呼, 外接框)：「第 7 个：sphere」，形状里写了 name 的带上它「第 7 个：sphere「树冠」」。"""
    out = []
    for k, s in enumerate(shapes):
        name = raw[k].get("name") if k < len(raw or []) and isinstance(raw[k], dict) else None
        name = _name_part(name, 16) if isinstance(name, str) else ""
        out.append(("第 %d 个：%s%s" % (k + 1, s["type"], "「%s」" % name if name else ""), box_of(placed(s))))
    return out


def _named(labels) -> str:
    """伸出去的那几个 -> 「（第 7 个：sphere、第 2 个：box）」，最多说 3 个；没有 -> ""。"""
    if not labels:
        return ""
    return "（%s%s）" % ("、".join(labels[:3]), " 等 %d 个" % len(labels) if len(labels) > 3 else "")


def problems_of(num: dict, lot, limits: dict, parts=None) -> list:
    """和岛上 buildings.check_numbers 一样的话：出地界、面数、文件大小、高度、贴图。``lot`` None = 不查地界。
    ``parts``（[(怎么称呼, 外接框)]，配方的形状或 .blend 里的物体）：出地界的话后面再说是哪几个伸出去了；收不收和不写一样。"""
    P = []
    x0, z0, x1, z1 = num["bbox"]
    if lot and lot.get("poly_uv"):
        poly = [tuple(p) for p in lot["poly_uv"]]
        if not rect_in(poly, x0, z0, x1, z1):
            out = [name for name, b in parts or [] if not rect_in(poly, *b)]
            P.append("楼的占地（%.1f × %.1f 米）伸出地界：要整个落在这块地的边界里面%s" % (x1 - x0, z1 - z0, _named(out)))
    elif lot:
        hw, hd = float(lot["w"]) / 2, float(lot["d"]) / 2
        for side, over_of in (("左边", lambda b: -hw - b[0]), ("右边", lambda b: b[2] - hw), ("后边", lambda b: -hd - b[1]),
                              ("门口那边", lambda b: b[3] - hd)):
            over = over_of(num["bbox"])
            if over > EDGE_EPS:
                out = sorted(((over_of(b), k, name) for k, (name, b) in enumerate(parts or [])), key=lambda x: (-x[0], x[1]))
                P.append("%s伸出地界 %.1f 米%s" % (side, over, _named([name for o, _k, name in out if o > EDGE_EPS])))
    if num["tris"] > limits["tris"]:
        P.append("%d 个面，最多 %d（页面跑不动的线，不卖）" % (num["tris"], limits["tris"]))
    if num.get("kb", 0) > limits["kb"]:
        P.append("文件 %d KB，最多 %d KB" % (num["kb"], limits["kb"]))
    if num["h"] > limits["h"]:
        P.append("高 %.0f 米，最高 %d 米" % (num["h"], limits["h"]))
    tex = num.get("textures") or []
    if len(tex) > limits["tex_n"]:
        P.append("贴图有 %d 张，最多 %d 张" % (len(tex), limits["tex_n"]))
    return P


def read_lot(path):
    """lot.json：{"w", "d", "poly_uv"?: [[x, z], …], "limits"?: {…}} -> (lot | None, limits)。"""
    limits = dict(LIMITS)
    if not path:
        return None, limits
    with open(path, encoding="utf-8") as fh:
        lot = json.load(fh)
    if not isinstance(lot, dict) or not _finite(lot.get("w")) or not _finite(lot.get("d")):
        raise ValueError('lot.json 要写成 {"w": 宽, "d": 深, "poly_uv"?: [[x, z], …], "limits"?: {…}}')
    for k, v in (lot.get("limits") or {}).items():
        if k in limits and _finite(v):
            limits[k] = v
    poly = lot.get("poly_uv")
    if poly is not None and not (isinstance(poly, list) and len(poly) >= 3 and all(isinstance(p, (list, tuple)) and len(p) == 2 and all(_finite(q) for q in p) for p in poly)):
        raise ValueError("lot.json 的 poly_uv 要是至少三个 [x, z]")
    return {"w": float(lot["w"]), "d": float(lot["d"]), "poly_uv": [[float(a), float(b)] for a, b in poly] if poly else None}, limits


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
INSIDE_LIMITS = {"tris": 300000, "kb": 16384, "tex_n": 8, "tex_px": 2048, "shapes": 4000, "shapes_json_kb": 1024, "lights": 16, "seats": 12}
WALL_T = 0.12                       # 墙厚（在占地里面）
SLAB_T = 0.1
IN_FROM_DOOR = 0.6                  # door 空点在正门往里这么远（岛的 build.py：正门往里 0.6 米那一点的 1.5 米以内）
INSIDE_TEXT = ('室内配方要写成 {"room":{"floor":{…},"walls":{…},"ceiling":{…}},"shapes":[家具, …],"lights":[{"at":[x,y,z]}],'
               '"points":{"stairs_up":[x,z],"table":[x,y,z],"seats":[[x,y,z],…]}}（每样都可不写）')


def read_room(path) -> tuple:
    """room.json -> (room, limits)。room：{foot, h, floor, floors, door | None, w, d}。"""
    limits = dict(INSIDE_LIMITS)
    with open(path, encoding="utf-8") as fh:
        r = json.load(fh)
    f = r.get("foot") if isinstance(r, dict) else None
    if not (isinstance(f, list) and len(f) == 4 and all(_finite(q) for q in f) and f[2] - f[0] > 1 and f[3] - f[1] > 1):
        raise ValueError('room.json 要写成 {"foot": [x0, z0, x1, z1], "h": 层高, "floor": 第几层, "door"?: {"side", "at"}}')
    for k, v in (r.get("limits") or {}).items():
        if k in limits and _finite(v):
            limits[k] = v
    h = r.get("h") if _finite(r.get("h")) else 3.0
    floor = int(r["floor"]) if _finite(r.get("floor")) else 1
    floors = int(r["floors"]) if _finite(r.get("floors")) else 1
    door = read_door(r.get("door"))[1] if r.get("door") is not None else None
    room = {"foot": [float(q) for q in f], "h": max(2.2, min(8.0, float(h))), "floor": max(1, floor), "floors": max(1, floors),
            "door": door if floor <= 1 else None}
    room["w"], room["d"] = room["foot"][2] - room["foot"][0], room["foot"][3] - room["foot"][1]
    return room, limits


def _surface(raw, default_mat: str, k: str, why: list):
    """room 里的 floor / walls / ceiling：{"material", "color"}；ceiling 写 false 就不做。"""
    if raw is False and k == "ceiling":
        return None
    raw = raw if isinstance(raw, dict) else {}
    mat = str(raw.get("material", default_mat)).lower()
    if mat not in MATERIALS:
        why.append("room 的 %s 的 material 要是这几种之一：%s" % (k, "、".join(MATERIALS)))
        mat = default_mat
    c = color_value(raw.get("color"))
    if c is None:
        why.append('room 的 %s 的颜色看不懂（写成 "#f2e2c4" 或 [242, 226, 196]）' % k)
        c = DEFAULT_COLOR
    return {"mat": mat, "color": c}


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
    """室内配方 -> (问题, {surfaces, shapes, raw_shapes, lights, points})。家具可以一个都没有（只有地板、墙、天花板）。"""
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
    shapes = []
    for k, sh in enumerate(shapes_raw):
        w, s = check_shape(sh, k)
        why += w
        if s is not None:
            shapes.append(s)
        if len(why) >= 5:
            break
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


def _box(x0, y0, z0, x1, y1, z1, surf: dict, role: str) -> dict:
    return {"type": "box", "mat": surf["mat"], "color": surf["color"], "pos": [(x0 + x1) / 2, y0, (z0 + z1) / 2], "rot": [0.0, 0.0, 0.0], "seg": 18,
            "size": [x1 - x0, y1 - y0, z1 - z0], "role": role}


def room_shapes(room: dict, surf: dict) -> list:
    """地板（顶面 y = 0）、四面墙（在占地里面，厚 WALL_T；一层开正门的洞：宽 DOOR_W、高 DOOR_H）、天花板（层高处）：都是 box。"""
    x0, z0, x1, z1 = room["foot"]
    h, t = room["h"], WALL_T
    out = [_box(x0, -SLAB_T, z0, x1, 0.0, z1, surf["floor"], "floor")]
    walls = (("back", (x0, z0, x1, z0 + t)), ("front", (x0, z1 - t, x1, z1)), ("left", (x0, z0 + t, x0 + t, z1 - t)), ("right", (x1 - t, z0 + t, x1, z1 - t)))
    door = room.get("door")
    for side, (a0, b0, a1, b1) in walls:
        if not (door and door["side"] == side):
            out.append(_box(a0, 0.0, b0, a1, h, b1, surf["walls"], "wall"))
            continue
        dx, dz, nx, _nz = door_point(room["foot"], door)
        half = DOOR_W / 2
        if nx == 0:                                          # 前后两面：沿 x 断开
            segs, over = [(a0, b0, dx - half, b1), (dx + half, b0, a1, b1)], (dx - half, b0, dx + half, b1)
        else:
            segs, over = [(a0, b0, a1, dz - half), (a0, dz + half, a1, b1)], (a0, dz - half, a1, dz + half)
        for s0, r0, s1, r1 in segs:
            if s1 - s0 > 0.02 and r1 - r0 > 0.02:
                out.append(_box(s0, 0.0, r0, s1, h, r1, surf["walls"], "wall"))
        if h - DOOR_H > 0.02:
            out.append(_box(over[0], DOOR_H, over[1], over[2], h, over[3], surf["walls"], "wall"))
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
    out = [name for name, b in parts or [] if b[0] < ix0 - EDGE_EPS or b[1] < iz0 - EDGE_EPS or b[2] > ix1 + EDGE_EPS or b[3] > iz1 + EDGE_EPS]
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
    tex = num.get("textures") or []
    if len(tex) > limits["tex_n"]:
        P.append("贴图有 %d 张，一层最多 %d 张" % (len(tex), limits["tex_n"]))
    return P


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
    ap.add_argument("--json-out", dest="json_out", default="", help="结果另存一份到这个文件")
    ap.add_argument("--px", type=int, default=PREVIEW_PX)
    a = ap.parse_args(argv)
    if a.recipe and not (a.out_blend and a.out_glb):
        ap.error("--recipe 要同时写 --out-blend 和 --out-glb")
    if (a.from_blend or a.from_glb) and not a.out_glb:
        ap.error("--from-blend / --from-glb 要写 --out-glb")
    a.px = max(128, min(2048, a.px))
    return a


def emit(result: dict, json_out: str = "") -> None:
    result = dict({"cobuild": VERSION}, **result)
    line = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    if json_out:
        try:
            with open(json_out, "w", encoding="utf-8") as fh:
                fh.write(line)
        except OSError:
            pass
    sys.stdout.write(line + "\n")
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


def _material(bpy, name: str):
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    if m.node_tree is None:                               # (5.x makes the node tree by itself; use_nodes goes away in 6.0)
        m.use_nodes = True
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Col"
        nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
        rough = {"glass": 0.05, "metal": 0.35, "water": 0.1, "tile": 0.6, "glow": 0.5}.get(name, 0.85)
        bsdf.inputs["Roughness"].default_value = rough
        if name == "metal":
            bsdf.inputs["Metallic"].default_value = 0.8
        if name in ("glass", "water") and "Transmission Weight" in bsdf.inputs:
            bsdf.inputs["Transmission Weight"].default_value = 0.6
        if name == "glow" and "Emission Strength" in bsdf.inputs:
            nt.links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 1.5
    m.diffuse_color = (0.8, 0.8, 0.8, 1.0)
    return m


def _uv_of(p, n):
    ax = max(range(3), key=lambda i: abs(n[i]))
    return (p[2], p[1]) if ax == 0 else ((p[0], p[2]) if ax == 1 else (p[0], p[1]))


def build_shape_object(bpy, s: dict, k: int, coll):
    """One shape -> one Blender object (its corners already where they stand, the object's own matrix = identity)."""
    V0, F, S, sharp = shape_geometry(s)
    P = placed(s)
    me = bpy.data.meshes.new("%03d %s %s" % (k + 1, s["type"], s["mat"]))
    me.from_pydata([_to_b(p) for p in P], [], [list(f) for f in F])
    me.validate(clean_customdata=False)
    me.update()
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)       # every face looks outwards, whatever order the corners came in
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set("use_smooth", [bool(x) for x in S[:len(me.polygons)]] + [False] * max(0, len(me.polygons) - len(S)))
    if sharp:
        attr = me.attributes.get("sharp_edge") or me.attributes.new("sharp_edge", "BOOLEAN", "EDGE")
        flags = [((e.vertices[0], e.vertices[1]) in sharp or (e.vertices[1], e.vertices[0]) in sharp) for e in me.edges]
        attr.data.foreach_set("value", flags)
    me.materials.append(_material(bpy, s["mat"]))
    col = _lin(s["color"])
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    ca.data.foreach_set("color", [q for _ in range(len(me.loops)) for q in (col[0], col[1], col[2], 1.0)])
    me.color_attributes.active_color = ca
    uv = me.uv_layers.new(name="UVMap")
    flat = []
    for poly in me.polygons:
        n = _from_b(poly.normal)
        for li in poly.loop_indices:
            flat += list(_uv_of(_from_b(me.vertices[me.loops[li].vertex_index].co), n))
    uv.data.foreach_set("uv", flat)
    um = me.uv_layers.new(name="Mat")                    # the island's own shader reads the material id here (kit.to_object)
    param = (0.3 + 0.1 * (k % 5)) if s["mat"] == "glass" else 0.0
    um.data.foreach_set("uv", [q for _ in range(len(me.loops)) for q in ((MATERIALS[s["mat"]] + 0.5) / 16.0, param)])
    me.uv_layers.active = uv
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


def joined(bpy, obs, name="house", boxes=None):
    """One mesh of everything (modifiers applied, in world space): what is exported and measured.
    ``boxes`` (a list): gets (「物体「名字」」, the object's own outer box) per object, for naming what sticks out of the lot."""
    dg = bpy.context.evaluated_depsgraph_get()
    parts = []
    for ob in obs:
        ev = ob.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
        me.transform(ob.matrix_world)
        if boxes is not None and len(me.vertices):
            boxes.append(("物体「%s」" % _name_part(ob.name, 24), box_of([_from_b(v.co) for v in me.vertices])))
        if not ob.data.materials and ob.material_slots:
            for sl in ob.material_slots:
                me.materials.append(sl.material)
        part = bpy.data.objects.new(name + "_part", me)
        bpy.context.scene.collection.objects.link(part)
        parts.append(part)
    if not parts:
        raise Fail("里面没有任何模型（网格）")
    if len(parts) > 1:
        with bpy.context.temp_override(active_object=parts[0], object=parts[0], selected_objects=parts, selected_editable_objects=parts):
            bpy.ops.object.join()
    one = parts[0]
    one.name = name
    return one


def measure(bpy, ob) -> tuple:
    me = ob.data
    me.calc_loop_triangles()
    pts = [_from_b(v.co) for v in me.vertices]
    if not pts or not len(me.loop_triangles):
        raise Fail("里面没有任何面")
    return numbers_of(pts, len(me.loop_triangles)), pts


def textures(bpy, ob, limits: dict, notes: list) -> list:
    imgs = {n.image for sl in ob.material_slots if sl.material and sl.material.node_tree for n in sl.material.node_tree.nodes
            if n.type == "TEX_IMAGE" and n.image}
    out, shrunk = [], 0
    for im in imgs:
        w, h = im.size
        if w and h and max(w, h) > limits["tex_px"]:
            k = limits["tex_px"] / max(w, h)
            im.scale(max(1, int(w * k)), max(1, int(h * k)))
            shrunk += 1
        out.append([im.size[0], im.size[1]])
    if shrunk:
        notes.append("%d 张贴图大于 %d 像素，缩小了" % (shrunk, limits["tex_px"]))
    return sorted(out, reverse=True)


def export_glb(bpy, ob, path: str, vertex_mode: str, extra=(), lights: bool = False) -> None:
    """``extra``：一起导出的空点和灯（室内的 door / stairs_* / table / seat_n，点光源）。"""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    ob.select_set(True)
    for o in extra:
        o.select_set(True)
    bpy.context.view_layer.objects.active = ob
    keys = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_apply=False, export_normals=True, export_texcoords=True,
              export_animations=False, export_cameras=False, export_lights=lights, export_extras=False, export_draco_mesh_compression_enable=False,
              export_materials="EXPORT", export_image_format="AUTO", export_vertex_color=vertex_mode, export_all_vertex_colors=False,
              export_active_vertex_color_when_no_material=True)
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in keys or k == "filepath"})


def render_previews(bpy, ob, num: dict, lot, out_dir: str, px: int, color_type: str) -> list:
    """Three small pictures: front (from the door side), three-quarter, top. Workbench: a second or two each."""
    from mathutils import Vector
    out_dir = os.path.abspath(out_dir)                    # (a relative render path is read against the drive's root, not the cwd)
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sh = sc.display.shading
    sh.light, sh.color_type, sh.show_shadows, sh.show_cavity = "STUDIO", color_type, True, True
    if sc.world is None:
        sc.world = bpy.data.worlds.new("sky")
    sc.world.color = (0.62, 0.78, 0.9)
    sc.render.film_transparent = False
    sc.render.resolution_x = sc.render.resolution_y = px
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
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
    files = []
    views = {"front": Vector(_to_b((0.0, 0.32, 1.0))).normalized(), "three_quarter": Vector(_to_b((0.62, 0.55, 0.78))).normalized(),
             "top": Vector((0.0, 0.0, 1.0))}
    for name in PREVIEWS:
        d = views[name]
        if name == "top":
            cam.data.type = "ORTHO"
            cam.data.ortho_scale = size * 1.15
            cam.location = Vector((ctr.x, ctr.y, h + size * 2 + 5))
            cam.rotation_euler = (0.0, 0.0, 0.0)
        else:
            cam.data.type = "PERSP"
            cam.data.lens = 50
            cam.location = ctr + d * size * 2.3
            cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(out_dir, name + ".png")
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        if os.path.isfile(path):
            files.append(path)
    bpy.data.objects.remove(cam)
    return files


def _color_type(bpy, ob) -> str:
    has_tex = any(n.type == "TEX_IMAGE" and n.image for sl in ob.material_slots if sl.material and sl.material.node_tree for n in sl.material.node_tree.nodes)
    if has_tex:
        return "TEXTURE"
    return "VERTEX" if len(ob.data.color_attributes) else "MATERIAL"


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


def render_inside_previews(bpy, room: dict, hide_top: list, out_dir: str, px: int, color_type: str) -> list:
    """三张：front 站在门里（一层；别的层在一面墙边）往里看，three_quarter 从一个角斜着看，top 从上往下（天花板拿掉）。"""
    from mathutils import Vector
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sh = sc.display.shading
    sh.light, sh.color_type, sh.show_shadows, sh.show_cavity = "STUDIO", color_type, True, True
    if sc.world is None:
        sc.world = bpy.data.worlds.new("sky")
    sc.world.color = (0.2, 0.2, 0.22)
    sc.render.film_transparent = False
    sc.render.resolution_x = sc.render.resolution_y = px
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    x0, z0, x1, z1 = room["foot"]
    h, cx, cz = room["h"], (x0 + x1) / 2, (z0 + z1) / 2
    cam = bpy.data.objects.new("preview cam", bpy.data.cameras.new("preview cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.clip_start, cam.data.clip_end = 0.05, 500
    d = inside_door(room)
    eye = (d[0], 1.5, d[2]) if d else (cx, 1.5, z1 - WALL_T - 0.4)
    files = []
    for name in PREVIEWS:
        for o in hide_top:
            o.hide_render = name == "top"
        if name == "top":
            cam.data.type, cam.data.ortho_scale = "ORTHO", max(x1 - x0, z1 - z0) * 1.1
            cam.location, cam.rotation_euler = Vector(_to_b((cx, h + 20, cz))), (0.0, 0.0, 0.0)
        else:
            cam.data.type, cam.data.lens = "PERSP", 16
            at = eye if name == "front" else (x1 - WALL_T - 0.3, max(1.6, h - 0.3), z1 - WALL_T - 0.3)
            look = (cx, 1.0, cz) if name == "front" else (cx - (x1 - x0) * 0.15, 0.4, cz - (z1 - z0) * 0.15)
            cam.location = Vector(_to_b(at))
            cam.rotation_euler = (Vector(_to_b(look)) - cam.location).to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(out_dir, name + ".png")
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        if os.path.isfile(path):
            files.append(path)
    for o in hide_top:
        o.hide_render = False
    bpy.data.objects.remove(cam)
    return files


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
    keep, ceiling, parts, top, pts = [], [], None, None, {}
    if a.recipe:
        mode = "recipe"
        try:
            with open(a.recipe, encoding="utf-8") as fh:
                obj = json.load(fh)
        except (OSError, ValueError) as e:
            raise Fail("配方不是能读的 JSON：%s" % str(e)[:120])
        why, ins = read_inside(obj, room, limits)
        if why:
            raise Fail(*why)
        est = sum(tris_of(s) for s in ins["shapes"])
        if est > limits["tris"] * 4:
            raise Fail("太重了：大约 %d 个面，一层最多 %d" % (est, limits["tris"]))
        rc, fc, pc = (bpy.data.collections.new(n) for n in ("room", "furniture", "points"))
        for c in (rc, fc, pc):
            sc.collection.children.link(c)
        for k, s in enumerate(room_shapes(room, ins["surfaces"])):
            ob = build_shape_object(bpy, s, 900 + k, rc)
            ob.name = "room %s %d" % (s["role"], k + 1)
            if s["role"] == "ceiling":
                ceiling.append(ob)
        for k, s in enumerate(ins["shapes"]):
            build_shape_object(bpy, s, k, fc)
        if ins["shapes"]:
            parts = recipe_parts(ins["raw_shapes"], ins["shapes"])
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
    if a.out_blend:
        os.makedirs(os.path.dirname(os.path.abspath(a.out_blend)), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.out_blend), compress=True, copy=True)
    obs = _build_objects(bpy)
    files = {"glb": os.path.abspath(a.out_glb), "blend": os.path.abspath(a.out_blend) if a.out_blend else None, "previews": []}
    if a.previews:
        try:
            ct = "VERTEX" if mode == "recipe" else "MATERIAL"
            files["previews"] = render_inside_previews(bpy, room, ceiling, a.previews, a.px, ct)
        except Exception as e:  # noqa: BLE001 - the numbers stand without the pictures
            notes.append("预览图没出来：%s" % str(e)[:120])
    one = joined(bpy, obs, name="floor%d" % room["floor"])
    for o in obs:
        o.hide_render = True
    num, _ = measure(bpy, one)
    num["textures"] = textures(bpy, one, limits, notes)
    num["objects"] = len(obs)
    if mode == "recipe":
        num["shapes"] = len(ins["shapes"])
        num["furniture_top"] = top
    export_glb(bpy, one, a.out_glb, "ACTIVE" if mode == "recipe" else "MATERIAL", extra=keep, lights=True)
    num["kb"] = max(1, int(math.ceil(os.path.getsize(a.out_glb) / 1024)))
    if a.out_blend and os.path.isfile(a.out_blend):
        num["blend_kb"] = max(1, int(math.ceil(os.path.getsize(a.out_blend) / 1024)))
    num.update(floor=room["floor"], room=[round(q, 2) for q in room["foot"]], room_h=room["h"], lights=len([o for o in keep if o.type == "LIGHT"]),
               points={k: [round(q, 2) for q in v] for k, v in sorted(pts.items())})
    P = inside_problems(num, room, limits, parts, {k: v for k, v in pts.items() if k != "door"})
    return {"ok": True, "mode": mode, "inside": True, "numbers": num, "problems": P, "notes": notes, "files": files, "secs": round(time.time() - t0, 1)}


def run(a) -> dict:
    if a.room:
        return run_inside(a)
    import bpy
    t0 = time.time()
    notes = []
    lot, limits = read_lot(a.lot)
    _clear_scene(bpy)
    sc = bpy.context.scene
    if a.recipe:
        mode = "recipe"
        try:
            with open(a.recipe, encoding="utf-8") as fh:
                obj = json.load(fh)
        except (OSError, ValueError) as e:
            raise Fail("配方不是能读的 JSON：%s" % str(e)[:120])
        why, shapes = read_recipe(obj, limits)
        if why:
            raise Fail(*why)
        est = sum(tris_of(s) for s in shapes)
        if est > limits["tris"] * 4:
            raise Fail("太重了：大约 %d 个面，最多 %d" % (est, limits["tris"]))
        coll = bpy.data.collections.new("house")
        sc.collection.children.link(coll)
        for k, s in enumerate(shapes):
            build_shape_object(bpy, s, k, coll)
        parts = recipe_parts(recipe_shapes(obj), shapes)
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
    if a.out_blend:                                       # the .blend he may edit: the shapes as separate objects, the lot beside them
        os.makedirs(os.path.dirname(os.path.abspath(a.out_blend)), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.out_blend), compress=True, copy=True)
    boxes = None if mode == "recipe" else []              # (a recipe names its shapes by number; a .blend / .glb by its objects' names)
    one = joined(bpy, obs, boxes=boxes)
    if boxes is not None:
        parts = boxes if len(boxes) > 1 else None         # (one object is the whole house: naming it says nothing)
    for o in obs:
        o.hide_render = True
    num, _ = measure(bpy, one)
    num["textures"] = textures(bpy, one, limits, notes)
    num["objects"] = len(obs)
    if mode == "recipe":
        num["shapes"] = len(obs)
    export_glb(bpy, one, a.out_glb, "ACTIVE" if mode == "recipe" else "MATERIAL")
    num["kb"] = max(1, int(math.ceil(os.path.getsize(a.out_glb) / 1024)))
    if a.out_blend and os.path.isfile(a.out_blend):
        num["blend_kb"] = max(1, int(math.ceil(os.path.getsize(a.out_blend) / 1024)))
    files = {"glb": os.path.abspath(a.out_glb), "blend": os.path.abspath(a.out_blend) if a.out_blend else None, "previews": []}
    if a.previews:
        try:
            files["previews"] = render_previews(bpy, one, num, lot, a.previews, a.px, _color_type(bpy, one))
        except Exception as e:  # noqa: BLE001 - the numbers stand without the pictures
            notes.append("预览图没出来：%s" % str(e)[:120])
    P = problems_of(num, lot, limits, parts)
    if mode == "recipe" and door_raw is not None:            # 门（11-23）：写了就带回去，岛上照它开门；不写岛上照朝着最近的路的那一面开
        why, door = read_door(door_raw, num["bbox"])
        P += why
        if door is not None:
            num["door"] = door
    return {"ok": True, "mode": mode, "numbers": num, "problems": P, "notes": notes, "files": files, "secs": round(time.time() - t0, 1)}


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
