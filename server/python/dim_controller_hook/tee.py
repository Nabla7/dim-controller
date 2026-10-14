"""Stand beside WorldMonitor's visualization and answer dim-controller's zenoh queries about it.

``patch`` wraps ``WorldMonitor.finalize(visualization, *, operator)``: the visualization it is given (viser, meshcat
or none) is wrapped in a Tee that forwards every call unchanged and notes what the controller needs. The queries
(``dim_controller/hook/<name>``, JSON payloads) run on zenoh's threads, never on dimos's.
"""

from __future__ import annotations

import inspect
import json
import math
import os
import sys
import threading
import traceback
from typing import Any

from dim_controller_hook import VERSION

KEY_PREFIX = "dim_controller/hook"
LOOPBACK_INTERFACE = "lo0" if sys.platform == "darwin" else "lo"
# The coordinator interpolates between trajectory points at control rate (the viser panel plans the same way).
CARTESIAN_PLAN_DT = 0.05

_session: Any = None
_queryables: list[Any] = []


def _warn(message: str) -> None:
    print(f"[dim-controller hook] {message}", file=sys.stderr)


def patch(world_monitor_module: Any) -> None:
    """Wrap WorldMonitor.finalize, if it still has the shape this hook was written against."""
    world_monitor_class = getattr(world_monitor_module, "WorldMonitor", None)
    finalize = getattr(world_monitor_class, "finalize", None)
    if finalize is None:
        _warn("off: dimos has no WorldMonitor.finalize")
        return
    parameters = inspect.signature(finalize).parameters
    if "visualization" not in parameters or "operator" not in parameters:
        _warn(f"off: WorldMonitor.finalize{inspect.signature(finalize)} isn't (visualization, *, operator)")
        return

    def finalize_with_tee(self: Any, visualization: Any = None, *args: Any, **kwargs: Any) -> Any:
        tee = None
        try:
            tee = Tee(visualization, kwargs.get("operator"), self)
        except Exception:
            _warn(f"off for this world: {traceback.format_exc()}")
        result = finalize(self, tee if tee is not None else visualization, *args, **kwargs)
        if tee is not None:
            try:
                tee.serve()
            except Exception:
                _warn(f"can't serve: {traceback.format_exc()}")
        return result

    world_monitor_class.finalize = finalize_with_tee
    _warn(f"on (v{VERSION}, pid {os.getpid()}): dim-controller can see this process's manipulation planner")


class Tee:
    """A VisualizationSpec that forwards to the real one (or to nothing) and keeps what dim-controller asks for."""

    def __init__(self, inner: Any, operator: Any, world_monitor: Any) -> None:
        self._inner = inner
        self._operator = operator
        self._world_monitor = world_monitor
        self._lock = threading.Lock()
        self._model: Any = None
        self._groups: tuple[Any, ...] = ()
        self._description: str | None = None
        self.obstacles_version = 0
        self._grasps: list[Any] = []
        self.grasps_version = 0
        self._preview: dict[str, Any] | None = None
        self.preview_version = 0
        self._joint_state: Any = None

    # VisualizationSpec: forward first, so dimos sees exactly what it did before; then note.

    def initialize(self, session: Any) -> None:
        if self._inner is not None:
            self._inner.initialize(session)
        self._note(self._initialize, session)

    def _initialize(self, session: Any) -> None:
        self._model = session.scene.model
        self._groups = tuple(session.scene.planning_groups)
        if self._operator is None:
            self._operator = session.operator

    def add_vis_obstacle(self, obstacle_id: str, obstacle: Any) -> None:
        self._forward("add_vis_obstacle", obstacle_id, obstacle)
        self._bump("obstacles_version")

    def update_vis_obstacle(self, obstacle: Any) -> None:
        self._forward("update_vis_obstacle", obstacle)
        self._bump("obstacles_version")

    def update_vis_obstacle_pose(self, obstacle_id: str, pose: Any) -> None:
        self._forward("update_vis_obstacle_pose", obstacle_id, pose)
        self._bump("obstacles_version")

    def remove_vis_obstacle(self, obstacle_id: str) -> None:
        self._forward("remove_vis_obstacle", obstacle_id)
        self._bump("obstacles_version")

    def clear_vis_obstacles(self) -> None:
        self._forward("clear_vis_obstacles")
        self._bump("obstacles_version")

    def show_grasp_proposals(self, candidates: Any) -> None:
        self._forward("show_grasp_proposals", candidates)
        self._note(self._show_grasp_proposals, candidates)

    def _show_grasp_proposals(self, candidates: Any) -> None:
        with self._lock:
            self._grasps = list(candidates.candidates)
            self.grasps_version += 1

    def get_visualization_url(self) -> str | None:
        return self._inner.get_visualization_url() if self._inner is not None else None

    def update_state(self, frame: Any) -> None:
        self._forward("update_state", frame)
        self._joint_state = getattr(frame, "joint_state", None)

    def animate_trajectory(self, trajectory: Any, duration: float | None = None) -> None:
        # noted before forwarding: viser's animation blocks for the preview's length
        self._note(self._animate_trajectory, trajectory, duration)
        self._forward("animate_trajectory", trajectory, duration)

    def _animate_trajectory(self, trajectory: Any, duration: float | None) -> None:
        with self._lock:
            self._preview = {"trajectory": _trajectory_json(trajectory), "duration": duration}
            self.preview_version += 1

    def cancel_preview_animation(self) -> None:
        self._forward("cancel_preview_animation")

    def close(self) -> None:
        self._forward("close")
        _close_session()

    def __getattr__(self, name: str) -> Any:
        # a VisualizationSpec method added after this hook was written: the real visualizer's, or a no-op
        inner = self.__dict__.get("_inner")
        if inner is not None:
            return getattr(inner, name)
        return lambda *args, **kwargs: None

    def _forward(self, method: str, *args: Any) -> None:
        if self._inner is not None:
            getattr(self._inner, method)(*args)

    def _note(self, function: Any, *args: Any) -> None:
        try:
            function(*args)
        except Exception:
            _warn(f"{function.__name__}: {traceback.format_exc()}")

    def _bump(self, attribute: str) -> None:
        with self._lock:
            setattr(self, attribute, getattr(self, attribute) + 1)

    # Queries

    def serve(self) -> None:
        global _session
        import zenoh

        if _session is None:
            config = zenoh.Config()
            # loopback only, the way dimos's own sessions meet: never a LAN or tailnet peer
            for key, value in (
                ("listen/endpoints", '["tcp/127.0.0.1:0"]'),
                ("scouting/multicast/interface", json.dumps(LOOPBACK_INTERFACE)),
                ("scouting/gossip/autoconnect", "{ router: [], peer: [] }"),
            ):
                config.insert_json5(key, value)
            _session = zenoh.open(config)
        handlers = {
            "info": self.info,
            "robot_description": self.robot_description,
            "scene": self.scene,
            "evaluate": self.evaluate,
            "plan_cartesian": self.plan_cartesian,
        }
        for name, handler in handlers.items():
            _queryables.append(_session.declare_queryable(f"{KEY_PREFIX}/{name}", _replier(handler)))

    def info(self, _request: Any) -> dict[str, Any]:
        model = self._model
        return {
            "hook": VERSION,
            "pid": os.getpid(),
            "python": sys.executable,
            "visualization": type(self._inner).__name__ if self._inner is not None else None,
            "visualization_url": self.get_visualization_url(),
            "operator": self._operator is not None,
            "model": None if model is None else getattr(model.config, "name", None),
            "groups": [
                {
                    "id": str(group.id),
                    "joints": [str(name) for name in group.joint_names],
                    "base": group.base_link,
                    "tip": group.tip_link,
                }
                for group in self._groups
            ],
            "joint_topology": self._joint_topology(),
        }

    def _joint_topology(self) -> dict[str, str]:
        """Per joint, as viser's sliders read it: limited (a slider), circle (-pi..pi) or line (a number box)."""
        try:
            joint_space = self._model.joint_space
            return {
                str(name): str(joint_space.coordinate(str(name)).topology.name).lower()
                for name in self._model.config.joint_names
            }
        except Exception:
            return {}

    def robot_description(self, _request: Any) -> Any:
        if self._model is None:
            raise RuntimeError("the planner has no model yet")
        if self._description is None:
            from dim_controller_hook.description import build_description

            self._description = json.dumps(build_description(self._model), separators=(",", ":"))
        return json.loads(self._description)

    def scene(self, request: Any) -> dict[str, Any]:
        """Obstacles (with shapes), grasp proposals and the last preview, each with a version to skip unchanged ones."""
        known = request or {}
        with self._lock:
            versions = {
                "obstacles": self.obstacles_version,
                "grasps": self.grasps_version,
                "preview": self.preview_version,
            }
            grasps = list(self._grasps)
            preview = self._preview
        answer: dict[str, Any] = {"versions": versions}
        if known.get("obstacles") != versions["obstacles"]:
            answer["obstacles"] = [_obstacle_json(obstacle) for obstacle in self._world_monitor.world.get_obstacles()]
        if known.get("grasps") != versions["grasps"]:
            answer["grasps"] = [{"pose": _pose_json(candidate.pose), "score": float(candidate.score)} for candidate in grasps]
        if known.get("preview") != versions["preview"]:
            answer["preview"] = preview
        return answer

    def evaluate(self, request: dict[str, Any]) -> dict[str, Any]:
        """viser's target check: {groups, joints?: {name: rad}, poses?: {group: {position, orientation}}, seed?}."""
        from dimos.manipulation.visualization.operator import JointTargetRequest, PoseTargetRequest
        from dimos.msgs.sensor_msgs.JointState import JointState

        operator = self._require_operator()
        group_ids = tuple(request["groups"])
        groups = {str(group.id): group for group in self._groups}
        names = [str(name) for group_id in group_ids for name in groups[group_id].joint_names]
        poses = request.get("poses") or {}
        if poses:
            seed = request.get("seed") or {}
            result = operator.evaluate_pose_target(
                PoseTargetRequest(
                    {group_id: _pose_stamped(pose) for group_id, pose in poses.items()},
                    tuple(group_id for group_id in group_ids if group_id not in poses),
                    JointState(name=names, position=[float(seed[name]) for name in names])
                    if all(name in seed for name in names)
                    else None,
                )
            )
        else:
            joints = request.get("joints") or {}
            missing = [name for name in names if name not in joints]
            if missing:
                return {"success": False, "collision_free": False, "status": "INVALID", "message": f"no target for {', '.join(missing)}"}
            result = operator.evaluate_joint_target(
                JointTargetRequest(group_ids, JointState(name=names, position=[float(joints[name]) for name in names]))
            )
        target = result.target_joints
        return {
            "success": bool(result.success),
            "collision_free": bool(result.collision_free),
            "status": str(result.status),
            "message": str(result.message),
            "joints": None if target is None else {str(name): float(value) for name, value in zip(target.name, target.position)},
            "poses": {str(group_id): _pose_json(pose) for group_id, pose in result.group_poses.items() if pose is not None},
        }

    def plan_cartesian(self, request: dict[str, Any]) -> dict[str, Any]:
        """viser's Cartesian-space plan (a straight TCP path): {poses: {group: pose}, auxiliary?, speed?}, as PlanResult."""
        from dimos.manipulation.planning.planners.roboplan_config import RoboPlanCartesianPathConfig
        from dimos.manipulation.visualization.operator import CartesianTargetRequest

        operator = self._require_operator()
        speed = request.get("speed")
        # the operator's speed is viser's "Next plan speed": borrowed for this plan, then given back
        viser_speed = operator.get_motion_speed()
        if speed is not None and not operator.set_motion_speed(float(speed)):
            return {"status": {"name": "INVALID_TARGET"}, "message": f"speed {speed} isn't in (0, 1]", "plan": None}
        try:
            plan = operator.plan_cartesian(
                CartesianTargetRequest(
                    {group_id: _pose_stamped(pose) for group_id, pose in request["poses"].items()},
                    RoboPlanCartesianPathConfig(speed_mode="time_optimal", dt=CARTESIAN_PLAN_DT),
                    tuple(request.get("auxiliary") or ()),
                )
            )
        finally:
            operator.set_motion_speed(viser_speed)
        if plan is None:
            return {"status": {"name": "FAILED"}, "message": operator.status().error or "Cartesian planning failed", "plan": None}
        return {"status": {"name": "SUCCEEDED"}, "message": plan.message, "plan": _plan_json(plan)}

    def _require_operator(self) -> Any:
        if self._operator is None:
            raise RuntimeError("this dimos gives its visualizer no operator")
        return self._operator


def _replier(handler: Any) -> Any:
    def reply(query: Any) -> None:
        try:
            payload = query.payload
            request = json.loads(payload.to_bytes()) if payload is not None and len(payload.to_bytes()) else None
            answer: Any = {"ok": True, "result": handler(request)}
        except Exception as error:
            answer = {"ok": False, "error": f"{type(error).__name__}: {error}", "trace": traceback.format_exc()}
        query.reply(query.key_expr, json.dumps(answer, default=_json_default))

    return reply


def _json_default(value: Any) -> Any:
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "name"):
        return value.name
    return str(value)


def _close_session() -> None:
    global _session
    for queryable in _queryables:
        try:
            queryable.undeclare()
        except Exception:
            pass
    _queryables.clear()
    if _session is not None:
        try:
            _session.close()
        except Exception:
            pass
        _session = None


def _pose_stamped(pose: dict[str, list[float]]) -> Any:
    from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped

    return PoseStamped(frame_id="world", position=list(pose["position"]), orientation=list(pose["orientation"]))


def _pose_json(pose: Any) -> dict[str, list[float]]:
    return {
        "position": [float(pose.position.x), float(pose.position.y), float(pose.position.z)],
        "orientation": [float(pose.orientation.x), float(pose.orientation.y), float(pose.orientation.z), float(pose.orientation.w)],
    }


def _trajectory_json(trajectory: Any) -> dict[str, Any]:
    return {
        "joint_names": [str(name) for name in trajectory.joint_names],
        "duration": float(trajectory.duration),
        "points": [
            {"time_from_start": float(point.time_from_start), "positions": [float(value) for value in point.positions]}
            for point in trajectory.points
        ],
    }


def _plan_json(plan: Any) -> dict[str, Any]:
    return {
        "plan_id": plan.plan_id,
        "group_ids": [str(group_id) for group_id in plan.group_ids],
        "path_length": float(plan.path_length),
        "planning_time": float(plan.planning_time),
        "trajectory": _trajectory_json(plan.trajectory),
    }


def _obstacle_json(obstacle: Any) -> dict[str, Any]:
    kind = str(obstacle.obstacle_type.name).lower()
    color = [float(value) for value in obstacle.color]
    shape: dict[str, Any] = {
        "name": obstacle.name,
        "type": kind,
        "pose": _pose_json(obstacle.pose),
        "dimensions": [float(value) for value in obstacle.dimensions],
        # dimos's default obstacle color means "no color given": viser then draws its own
        "color": None if color == [0.8, 0.2, 0.2, 0.8] or not all(math.isfinite(value) for value in color) else color,
    }
    try:
        if kind == "mesh":
            import numpy as np
            import trimesh

            mesh = trimesh.load_mesh(obstacle.mesh_path, process=False)
            if not hasattr(mesh, "vertices"):
                mesh = mesh.dump(concatenate=True)
            shape["vertices"] = np.asarray(mesh.vertices, dtype=float).ravel().tolist()
            shape["faces"] = np.asarray(mesh.faces, dtype=int).ravel().tolist()
        elif kind == "octree":
            shape["points"] = [float(value) for point in obstacle.points for value in point]
            shape["resolution"] = obstacle.octree_resolution
    except Exception as error:
        shape["error"] = f"{type(error).__name__}: {error}"
    return shape

