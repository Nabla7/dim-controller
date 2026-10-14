"""The planner's robot model as a ``dimos.robot_description.v1`` document, for the controller's 3D arm.

Every link's visual and collision geometry (meshes as base64 little-endian float32 vertices and uint32 faces, in the
mesh's own frame), every joint (origin, axis, limits, mimic), the model's base link and base pose. The page does the
forward kinematics from joint states. The URDF is the one viser loads: the prepared model's, with dimos's own
package-path resolution when this dimos has it.
"""

from __future__ import annotations

import base64
from io import BytesIO
from typing import Any

import numpy as np
from scipy.spatial.transform import Rotation
import trimesh
from yourdfpy import URDF

FORMAT = "dimos.robot_description.v1"


def _b64(array: Any, dtype: str) -> str:
    return base64.b64encode(np.ascontiguousarray(array, dtype=dtype).tobytes()).decode()


def _origin(matrix: Any) -> dict[str, list[float]]:
    """A 4x4 transform as xyz + quaternion [x, y, z, w]."""
    if matrix is None:
        return {"xyz": [0.0, 0.0, 0.0], "quat": [0.0, 0.0, 0.0, 1.0]}
    return {
        "xyz": [float(value) for value in matrix[:3, 3]],
        "quat": [float(value) for value in Rotation.from_matrix(matrix[:3, :3]).as_quat()],
    }


def _loaded_description(prepared: Any) -> Any:
    try:
        from dimos.manipulation.planning.utils.mesh_utils import prepare_urdf_for_drake

        return prepare_urdf_for_drake(prepared.description, convert_meshes=False)
    except ImportError:
        return prepared.description


def build_description(prepared: Any) -> dict[str, Any]:
    """``prepared``: the PreparedRobotModel WorldMonitor gives its visualizer."""
    config = prepared.config
    loaded = _loaded_description(prepared)
    urdf = URDF.load(
        BytesIO(loaded.xml.encode()),
        mesh_dir=str(loaded.source_path.parent),
        build_scene_graph=False,
        load_meshes=False,
    )
    materials = {material.name: material for material in urdf.robot.materials if material.name}
    meshes: dict[str, dict[str, str]] = {}

    def mesh_id(filename: str) -> str | None:
        if filename not in meshes:
            try:
                mesh = trimesh.load(filename, force="mesh")
            except Exception:
                return None
            meshes[filename] = {"vertices": _b64(mesh.vertices, "<f4"), "faces": _b64(mesh.faces, "<u4")}
        return filename

    def geometry(item: Any, with_color: bool) -> dict[str, Any] | None:
        shape = item.geometry
        out: dict[str, Any] = {"origin": _origin(item.origin)}
        if shape.mesh is not None:
            mesh = mesh_id(urdf._filename_handler(shape.mesh.filename))
            if mesh is None:
                return None
            scale = np.broadcast_to(1.0 if shape.mesh.scale is None else shape.mesh.scale, 3)
            out.update(type="mesh", mesh=mesh, scale=[float(value) for value in scale])
        elif shape.box is not None:
            out.update(type="box", size=[float(value) for value in shape.box.size])
        elif shape.cylinder is not None:
            out.update(type="cylinder", radius=float(shape.cylinder.radius), length=float(shape.cylinder.length))
        elif shape.sphere is not None:
            out.update(type="sphere", radius=float(shape.sphere.radius))
        else:
            return None
        if with_color:
            material = item.material
            if material is not None and material.color is None and material.name in materials:
                material = materials[material.name]
            if material is not None and material.color is not None:
                out["color"] = [float(value) for value in material.color.rgba]
        return out

    links = [
        {
            "name": link.name,
            "visuals": [shape for visual in link.visuals if (shape := geometry(visual, True)) is not None],
            "collisions": [shape for collision in link.collisions if (shape := geometry(collision, False)) is not None],
        }
        for link in urdf.robot.links
    ]
    joints = []
    for joint in urdf.robot.joints:
        entry: dict[str, Any] = {
            "name": joint.name,
            "type": joint.type,
            "parent": joint.parent,
            "child": joint.child,
            "origin": _origin(joint.origin),
            "axis": [float(value) for value in (joint.axis if joint.axis is not None else (1.0, 0.0, 0.0))],
        }
        if joint.limit is not None and joint.limit.lower is not None and joint.limit.upper is not None:
            entry["limit"] = [float(joint.limit.lower), float(joint.limit.upper)]
        if joint.mimic is not None:
            entry["mimic"] = {
                "joint": joint.mimic.joint,
                "multiplier": float(joint.mimic.multiplier if joint.mimic.multiplier is not None else 1.0),
                "offset": float(joint.mimic.offset or 0.0),
            }
        joints.append(entry)
    base_pose = config.base_pose
    return {
        "format": FORMAT,
        "name": urdf.robot.name,
        "base_link": config.base_link,
        "base_frame": base_pose.frame_id or "world",
        "base_pose": {
            "xyz": [float(base_pose.position.x), float(base_pose.position.y), float(base_pose.position.z)],
            "quat": [
                float(base_pose.orientation.x),
                float(base_pose.orientation.y),
                float(base_pose.orientation.z),
                float(base_pose.orientation.w),
            ],
        },
        "joint_names": list(config.joint_names),
        "links": links,
        "joints": joints,
        "meshes": meshes,
    }
