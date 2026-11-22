"""主人和鱼一起盖楼：主人在 Blender 里亲手改的那一层（插件自带的固定脚本，和 recipe_to_blend.py 放在一起）。

她改配方时，插件用 recipe_to_blend.py 从配方重新做一遍楼；这个脚本把主人亲手改过的部分（他加的、他改过的物体，他改过的材料，
他删掉的那几个）记成「主人改的」一层，叠到新做出来的楼上，不被她的新配方盖掉。DSH 鱼缸小镇和 AstrBot 插件带同一个文件。

    blender -b --factory-startup --disable-autoexec -P owner_layer.py -- diff --base B.blend --owner O.blend --out-layer L.blend \
        [--keep K.json] [--alt-base A.blend --alt-keep AK.json] [--json-out r.json]
    blender -b --factory-startup --disable-autoexec -P owner_layer.py -- apply --base N.blend --layer L.blend --spec S.json --out M.blend \
        [--json-out r.json]

diff：B 是主人开始改之前的那一版，O 是他存的文件。他加的（B 里没有的名字）、改过的（同名但形状、位置、材料、修改器、显示不一样）、
      以前就是他那一层的（K 的 layer）都算他的一层，存进 L（只有这些物体和它们用的东西）；B 里有、O 里没有的是他删掉的；
      两个文件里同名、内容不一样的材料是他改过的材料。K（上一次的结果）里删掉的、改过的材料接着算。
      写了 A（B 的上一版）：他存的文件更像 A（他 Blender 里开着的还是上一版，插件换了新的一版他没重新载入），就照 A 和 AK 算，回答里 stale = true。
apply：N 是从她的新配方做出来的楼。先去掉 N 里和他那一层同名的、他删掉的物体，再把 L 里他那一层的物体放进「主人改的」集合；
      他改过的材料替换 N 里同名的材料（她新加的形状用到这种材料也跟着变）。存成 M，之后插件照常用 recipe_to_blend.py --from-blend 出图、量尺寸。

最后打印一行 JSON（以 {"owner_layer": 开头）：diff {"ok", "stale", "layer", "added", "changed", "kept", "deleted", "materials", "objects"}；
apply {"ok", "removed", "added", "materials"}；做不出来 {"ok": false, "why": [...]}，退出码 2。

安全：只读这两个 .blend（打开时关掉自动运行脚本：偏好设置 + open_mainfile(use_scripts=False)），连着别的 .blend 文件的（库链接）不收，
从不执行文件里或别处来的任何代码；原来的文件不改（都另存）。"""
import hashlib
import json
import os
import re
import struct
import sys

VERSION = 1
LOT_COLLECTION = "LOT (not exported)"       # recipe_to_blend.py 里地的那个集合：不算谁的楼
LAYER_COLLECTION = "主人改的"
SUFFIX = re.compile(r"^(.*)\.\d{3}$")


class Fail(Exception):
    def __init__(self, *why):
        super().__init__("; ".join(why))
        self.why = list(why)


def emit(result: dict, json_out: str = "") -> None:
    line = json.dumps(dict({"owner_layer": VERSION}, **result), ensure_ascii=False, separators=(",", ":"))
    if json_out:
        try:
            with open(json_out, "w", encoding="utf-8") as fh:
                fh.write(line)
        except OSError:
            pass
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def parse_args(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="owner_layer.py", description="主人亲手改的那一层：diff 记下来，apply 叠到新做的楼上")
    ap.add_argument("what", choices=("diff", "apply"))
    ap.add_argument("--base", required=True)
    ap.add_argument("--owner", default="")
    ap.add_argument("--out-layer", dest="out_layer", default="")
    ap.add_argument("--keep", default="")
    ap.add_argument("--alt-base", dest="alt_base", default="")
    ap.add_argument("--alt-keep", dest="alt_keep", default="")
    ap.add_argument("--layer", default="")
    ap.add_argument("--spec", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--json-out", dest="json_out", default="")
    a = ap.parse_args(argv)
    if a.what == "diff" and not (a.owner and a.out_layer):
        ap.error("diff 要写 --owner 和 --out-layer")
    if a.what == "apply" and not (a.layer and a.spec and a.out):
        ap.error("apply 要写 --layer、--spec 和 --out")
    return a


def _read_json(path: str) -> dict:
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            obj = json.load(fh)
    except (OSError, ValueError):
        return {}
    return obj if isinstance(obj, dict) else {}


def _names(v) -> list:
    return [str(x)[:120] for x in v if isinstance(x, str) and x][:4000] if isinstance(v, list) else []


# ---------------------------------------------------------------------------------------------------------------------------------
# Blender 里的部分
# ---------------------------------------------------------------------------------------------------------------------------------
def _safe_prefs(bpy):
    try:
        bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    except Exception:  # noqa: BLE001 - background runs without preferences
        pass


def _open(bpy, path: str, what: str):
    if not os.path.isfile(path):
        raise Fail("%s不见了：%s" % (what, path))
    _safe_prefs(bpy)
    try:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(path), load_ui=False, use_scripts=False)
    except Exception as e:  # noqa: BLE001
        raise Fail("%s打不开：%s" % (what, str(e)[:160]))
    _safe_prefs(bpy)
    if len(bpy.data.libraries):
        raise Fail("%s链接了别的 .blend 文件（库链接）：在 Blender 里先把链接的东西做成本地的（Make Local）再存" % what)


def _lot_objects(bpy) -> set:
    c = bpy.data.collections.get(LOT_COLLECTION)
    return set(c.all_objects) if c is not None else set()


def _r(v, k=4):
    try:
        return [round(float(x), k) for x in v]
    except TypeError:
        return round(float(v), k) if isinstance(v, float) else v


def _floats(seq, attr: str, n: int, width: int, k: int) -> bytes:
    from array import array
    buf = array("f", [0.0]) * (n * width)
    if n:
        seq.foreach_get(attr, buf)
    return struct.pack("<%di" % len(buf), *[int(round(x * 10 ** k)) for x in buf])


def _ints(seq, attr: str, n: int) -> bytes:
    from array import array
    buf = array("i", [0]) * n
    if n:
        seq.foreach_get(attr, buf)
    return buf.tobytes()


def obj_sig(ob) -> str:
    """一个物体的样子：类型、位置（世界坐标）、显示、材料、修改器、父物体，网格的点、面和颜色。选中与否不算。"""
    h = hashlib.sha256()
    h.update(repr((ob.type, _r([v for row in ob.matrix_world for v in row]), bool(ob.hide_render), bool(ob.hide_viewport),
                   bool(ob.hide_get()), ob.parent.name if ob.parent else None,
                   [(sl.material.name if sl.material else None, sl.link) for sl in ob.material_slots],
                   [(m.type, m.name, bool(m.show_render)) for m in ob.modifiers])).encode("utf-8"))
    me = ob.data
    if ob.type == "MESH" and me is not None:
        h.update(_floats(me.vertices, "co", len(me.vertices), 3, 3))
        h.update(_ints(me.loops, "vertex_index", len(me.loops)))
        h.update(_ints(me.polygons, "loop_total", len(me.polygons)))
        h.update(repr([m.name if m else None for m in me.materials]).encode("utf-8"))
        for ca in me.color_attributes:
            h.update(repr((ca.name, ca.domain, ca.data_type)).encode("utf-8"))
            h.update(_floats(ca.data, "color", len(ca.data), 4, 3))
    elif me is not None:
        h.update(repr((type(me).__name__, me.name)).encode("utf-8"))
    return h.hexdigest()


def mat_sig(m) -> str:
    """一个材料的样子：颜色、金属感、粗糙，节点和连线（节点的每个输入值）。"""
    parts = [_r(m.diffuse_color), _r(m.metallic), _r(m.roughness)]
    nt = m.node_tree
    if nt is not None:
        for n in sorted(nt.nodes, key=lambda x: x.name):
            parts.append((n.bl_idname, n.name, getattr(n, "layer_name", None), getattr(n, "attribute_name", None),
                          (n.image.name, tuple(n.image.size)) if getattr(n, "image", None) is not None else None))
            for i in n.inputs:
                if hasattr(i, "default_value"):
                    try:
                        parts.append((i.identifier, _r(i.default_value)))
                    except (TypeError, ValueError):
                        parts.append((i.identifier, repr(i.default_value)))
        for lk in nt.links:
            parts.append((lk.from_node.name, lk.from_socket.identifier, lk.to_node.name, lk.to_socket.identifier))
    return hashlib.sha256(repr(parts).encode("utf-8")).hexdigest()


def _snapshot(bpy):
    lot = _lot_objects(bpy)
    obs = {ob.name: obj_sig(ob) for ob in bpy.context.scene.objects if ob not in lot}
    mats = {m.name: mat_sig(m) for m in bpy.data.materials if m.library is None and m.users}
    return obs, mats


def _distance(base_obs: dict, own_obs: dict) -> int:
    return sum(1 for n in own_obs if base_obs.get(n) != own_obs[n]) + sum(1 for n in base_obs if n not in own_obs)


def diff(bpy, a) -> dict:
    keep = _read_json(a.keep)
    _open(bpy, a.base, "开始改之前的那一版")
    base_obs, base_mats = _snapshot(bpy)
    alt = None
    if a.alt_base and os.path.isfile(a.alt_base):
        _open(bpy, a.alt_base, "上一版")
        alt = _snapshot(bpy)
    _open(bpy, a.owner, "主人存的 .blend ")
    own_obs, own_mats = _snapshot(bpy)
    # 他 Blender 里开着的还是上一版（插件换了新的一版他没重新载入）：照上一版算他改了什么
    stale = alt is not None and _distance(alt[0], own_obs) < _distance(base_obs, own_obs)
    if stale:
        base_obs, base_mats = alt
        keep = _read_json(a.alt_keep)
    added = sorted(n for n in own_obs if n not in base_obs)
    changed = sorted(n for n in own_obs if n in base_obs and own_obs[n] != base_obs[n])
    kept = sorted(n for n in _names(keep.get("layer")) if n in own_obs and n not in added and n not in changed)
    layer = sorted(set(added) | set(changed) | set(kept))
    gone = sorted(n for n in base_obs if n not in own_obs)
    deleted = sorted((set(gone) | set(_names(keep.get("deleted")))) - set(own_obs))
    mats = sorted(n for n in own_mats if (n in base_mats and own_mats[n] != base_mats[n]) or (n in _names(keep.get("materials"))))
    # 他那一层另存一份：只留这些物体（父物体先解开，位置不变），他改过的材料就算没物体用也留着
    sc = bpy.context.scene
    want = set(layer)
    for ob in list(sc.objects):
        if ob.name in want and ob.parent is not None and ob.parent.name not in want:
            mw = ob.matrix_world.copy()
            ob.parent = None
            ob.matrix_world = mw
    for ob in list(bpy.data.objects):
        if ob.name not in want:
            bpy.data.objects.remove(ob, do_unlink=True)
    for n in mats:
        m = bpy.data.materials.get(n)
        if m is not None:
            m.use_fake_user = True
    try:
        bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    except Exception:  # noqa: BLE001 - older Blender: the orphans just stay in the layer file
        pass
    os.makedirs(os.path.dirname(os.path.abspath(a.out_layer)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.out_layer), compress=True, copy=True)
    return {"ok": True, "stale": stale, "layer": layer, "added": added, "changed": changed, "kept": kept, "deleted": deleted, "materials": mats,
            "objects": len(own_obs)}


def apply(bpy, a) -> dict:
    spec = _read_json(a.spec)
    layer, deleted, mats = set(_names(spec.get("layer"))), set(_names(spec.get("deleted"))), set(_names(spec.get("materials")))
    if not os.path.isfile(a.layer):
        raise Fail("主人改的那一层的文件不见了：%s" % a.layer)
    _open(bpy, a.base, "新做的那一版")
    lot = _lot_objects(bpy)
    removed = []
    for ob in list(bpy.context.scene.objects):
        if ob not in lot and (ob.name in layer or ob.name in deleted):
            removed.append(ob.name)
            bpy.data.objects.remove(ob, do_unlink=True)
    local_mats = {m.name: m for m in bpy.data.materials if m.library is None}
    with bpy.data.libraries.load(os.path.abspath(a.layer), link=False) as (src, dst):
        dst.objects = [n for n in src.objects if n in layer]
        dst.materials = [n for n in src.materials if n in mats]
    sc = bpy.context.scene
    coll = bpy.data.collections.get(LAYER_COLLECTION) or bpy.data.collections.new(LAYER_COLLECTION)
    if coll.name not in sc.collection.children:
        sc.collection.children.link(coll)
    added = []
    for ob in dst.objects:
        if ob is None:
            continue
        if ob.name not in coll.objects:
            coll.objects.link(ob)
        added.append(ob.name)
    # 他改过的材料替换同名的那个（她新加的形状用到也跟着变）；他没改的、和这里一模一样的材料合成一个
    swapped = []
    for m in dst.materials:
        if m is None:
            continue
        name = SUFFIX.sub(r"\1", m.name)
        old = local_mats.get(name)
        if old is not None and old != m:
            old.user_remap(m)
            bpy.data.materials.remove(old)
        m.name = name
        m.use_fake_user = False
        swapped.append(name)
    for m in list(bpy.data.materials):
        hit = SUFFIX.match(m.name)
        if not hit or m.name in swapped or m.library is not None:
            continue
        twin = bpy.data.materials.get(hit.group(1))
        if twin is not None and twin != m and mat_sig(twin) == mat_sig(m):
            m.user_remap(twin)
            bpy.data.materials.remove(m)
    for lib in list(bpy.data.libraries):                   # append 用完的库记录（不留任何链接）
        try:
            bpy.data.libraries.remove(lib)
        except Exception:  # noqa: BLE001
            pass
    if len(bpy.data.libraries):
        raise Fail("叠主人改的那一层时留下了库链接，没存")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.out), compress=True, copy=True)
    return {"ok": True, "removed": sorted(removed), "added": sorted(added), "materials": sorted(swapped)}


def main(argv=None):
    argv = sys.argv[sys.argv.index("--") + 1:] if argv is None and "--" in sys.argv else (argv or [])
    a = parse_args(argv)
    try:
        import bpy
        out = diff(bpy, a) if a.what == "diff" else apply(bpy, a)
    except Fail as e:
        emit({"ok": False, "why": e.why[:5]}, a.json_out)
        sys.exit(2)
    except Exception as e:  # noqa: BLE001 - one line for whoever reads it
        emit({"ok": False, "why": ["叠主人改的那一层时出错了：%s: %s" % (type(e).__name__, str(e)[:200])]}, a.json_out)
        sys.exit(2)
    emit(out, a.json_out)


if __name__ == "__main__":
    main()
