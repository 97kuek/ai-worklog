"""Rebuild the runtime models and the café fallback from Taskfolio.blend.

Run from the repository root:
    blender -b design/office/Taskfolio.blend --python-exit-code 1 -P design/office/export.py
"""

from pathlib import Path

import bpy
from mathutils import Vector

scene = bpy.context.scene
public = Path(bpy.data.filepath).resolve().parents[2] / "worker/public/office"
collections = sorted(bpy.data.collections, key=lambda collection: collection.name)
room, station, *employees = [c for c in collections if c.name[:2].isdigit()]
staging = bpy.data.collections.new("Export staging")
scene.collection.children.link(staging)


def export(collection, filename, pivots, anchors=()):
    """Batch editable pieces by their animated joint and original material."""
    for part, position in pivots.items():
        origin = Vector(position)
        vertices, faces, smooth, indices, materials = [], [], [], [], []
        for piece in collection.objects:
            if piece.get("part") != part:
                continue
            offset = len(vertices)
            vertices.extend(piece.matrix_basis @ v.co - origin for v in piece.data.vertices)
            for poly in piece.data.polygons:
                material = piece.material_slots[poly.material_index].material
                if material not in materials:
                    materials.append(material)
                indices.append(materials.index(material))
                faces.append(tuple(offset + index for index in poly.vertices))
                smooth.append(poly.use_smooth)
        if not faces:
            raise ValueError(f"{collection.name} has no geometry for {part}")
        mesh = bpy.data.meshes.new(part + " web mesh")
        mesh.from_pydata(vertices, [], faces)
        for material in materials:
            mesh.materials.append(material)
        mesh.polygons.foreach_set("use_smooth", smooth)
        mesh.polygons.foreach_set("material_index", indices)
        mesh.update()
        node = bpy.data.objects.new(part, mesh)
        staging.objects.link(node)
        node.location = origin
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [*staging.objects, *anchors]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = staging.objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(public / (filename + ".glb")), export_format="GLB", use_selection=True,
        export_texcoords=False, export_tangents=False, export_animations=False,
        export_cameras=False, export_lights=False, export_attributes=False,
    )
    for obj in list(staging.objects):
        mesh = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)


anchors = [o for o in scene.objects if o.name.startswith(("CafeAnchor_", "DeskAnchor_"))]
export(room, "room", {"Studio": (0, 0, 0)}, anchors)
export(station, "station", {"Studio": (0, 0, 0), "Chair": (0, -.59, 0)})
joints = {"Body": (0, -.557, .70), "Head": (0, -.55, 1.32)}
for side, sign in (("L", -1), ("R", 1)):
    joints.update({
        "Arm_" + side: (.218 * sign, -.541, 1.204),
        "Forearm_" + side: (.284 * sign, -.382, 1.067),
        "Thigh_" + side: (.124 * sign, -.557, .737),
        "Shin_" + side: (.124 * sign, -.280, .735),
        "Foot_" + side: (.124 * sign, -.209, .241),
    })
# The first figures in the library occupy the runtime desks. Later collections
# are spare editable models and do not need to ship with the Worker.
desk_count = sum(anchor.name.startswith("DeskAnchor_") for anchor in anchors)
if len(employees) < desk_count:
    raise ValueError(f"Need {desk_count} employee collections for the office desks")
for index, employee in enumerate(employees[:desk_count]):
    export(employee, f"employee-{index}", joints)
bpy.data.collections.remove(staging)
scene.render.resolution_percentage = 80
scene.render.image_settings.file_format = "WEBP"
scene.render.image_settings.quality = 86
scene.render.filepath = str(public / "empty.webp")
bpy.ops.render.render(write_still=True)
