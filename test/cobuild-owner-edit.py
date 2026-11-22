# 测试用：装作主人在 Blender 里亲手改楼（打开 house.blend，加一根烟囱，把第 1 个形状往高拉一点，保存）。
# blender -b --factory-startup --disable-autoexec --python cobuild-owner-edit.py -- <house.blend>
import sys

import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
src = argv[0]
bpy.ops.wm.open_mainfile(filepath=src, load_ui=False, use_scripts=False)
house = bpy.data.collections.get('house')
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(1.5, -1.0, 6.0))
cube = bpy.context.active_object
cube.name = 'Chimney'
for c in list(cube.users_collection):
    c.objects.unlink(cube)
(house or bpy.context.scene.collection).objects.link(cube)
first = sorted(o.name for o in bpy.data.objects if o.name.startswith('001 '))
if first:
    o = bpy.data.objects[first[0]]
    o.scale = (o.scale[0], o.scale[1], o.scale[2] * 1.2)
bpy.ops.wm.save_mainfile(filepath=src)
print('{"owner_edit": 1, "ok": true}')
