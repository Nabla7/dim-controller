"""The hook in a real ManipulationModule (xArm7, Drake world, no visualizer), queried over zenoh as the server does.

Run with a dimos checkout's venv:  <dimos>/.venv/bin/python -m pytest server/python/tests -q -p no:cacheprovider
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import time
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dim_controller_hook.boot  # noqa: E402,F401  (before dimos: the hook patches WorldMonitor as it is imported)

zenoh = pytest.importorskip("zenoh")
if importlib.util.find_spec("dimos") is None or importlib.util.find_spec("pydrake") is None:
    pytest.skip("needs a dimos venv with Drake", allow_module_level=True)

from dimos.control.coordinator import ControlCoordinator  # noqa: E402
from dimos.manipulation.manipulation_module import ManipulationModule  # noqa: E402
from dimos.manipulation.planning.planners.config import RRTConnectPlannerConfig  # noqa: E402
from dimos.msgs.geometry_msgs.Pose import Pose  # noqa: E402
from dimos.msgs.geometry_msgs.Vector3 import Vector3  # noqa: E402
from dimos.msgs.manipulation_msgs.GraspCandidate import GraspCandidate  # noqa: E402
from dimos.msgs.manipulation_msgs.GraspCandidateArray import GraspCandidateArray  # noqa: E402
from dimos.msgs.sensor_msgs.JointState import JointState  # noqa: E402
from dimos.robot.manipulators.xarm.config import make_xarm7_model_config  # noqa: E402

from dim_controller_hook.tee import LOOPBACK_INTERFACE, Tee  # noqa: E402

JOINTS = [f"joint{index}" for index in range(1, 8)]


@pytest.fixture(scope="module")
def module():
    planner = ManipulationModule(
        model=make_xarm7_model_config(add_gripper=False),
        world_backend="drake",
        planner=RRTConnectPlannerConfig(),
        visualization={"backend": "none"},
    )
    planner._control_coordinator = MagicMock(spec=ControlCoordinator)
    planner.coordinator_joint_state = None
    planner.voxel_map = None
    planner.objects = None
    planner.start()
    planner._on_joint_state(JointState(name=JOINTS, position=[0.0] * 7))
    yield planner
    planner.stop()


@pytest.fixture(scope="module")
def ask(module):
    config = zenoh.Config()
    config.insert_json5("listen/endpoints", '["tcp/127.0.0.1:0"]')
    config.insert_json5("scouting/multicast/interface", json.dumps(LOOPBACK_INTERFACE))
    session = zenoh.open(config)

    def ask(name: str, request: object = None) -> object:
        deadline = time.time() + 10
        while time.time() < deadline:
            payload = None if request is None else json.dumps(request)
            for reply in session.get(f"dim_controller/hook/{name}", payload=payload, timeout=5.0):
                answer = json.loads(reply.ok.payload.to_bytes())
                assert answer["ok"], answer.get("trace")
                return answer["result"]
            time.sleep(0.2)
        raise AssertionError(f"no hook answered {name}")

    yield ask
    session.close()


def test_the_world_monitor_got_the_tee(module):
    # visualization "none": the tee stands in for a visualizer that isn't there
    assert isinstance(module._world_monitor.visualization, Tee)


def test_info_lists_groups_and_joint_topology(ask):
    info = ask("info")
    assert info["operator"] is True
    assert info["visualization"] is None
    assert info["groups"][0]["id"] == "manipulator"
    assert info["groups"][0]["joints"] == JOINTS
    assert set(info["joint_topology"]) >= set(JOINTS)


def test_robot_description_has_meshes(ask):
    description = ask("robot_description")
    assert description["format"] == "dimos.robot_description.v1"
    assert description["joint_names"] == JOINTS
    assert len(description["meshes"]) >= 7
    assert any(link["visuals"] for link in description["links"])


def test_evaluate_joint_target_reports_collision(module, ask):
    free = ask("evaluate", {"groups": ["manipulator"], "joints": dict.fromkeys(JOINTS, 0.1)})
    assert free["success"] and free["collision_free"], free["message"]
    tip = free["poses"]["manipulator"]["position"]
    module.add_obstacle("in_the_way", Pose(position=Vector3(*tip)), "sphere", [0.1])
    blocked = ask("evaluate", {"groups": ["manipulator"], "joints": dict.fromkeys(JOINTS, 0.1)})
    assert not blocked["success"]
    assert blocked["status"] == "COLLISION"
    module.remove_obstacle("in_the_way")


def test_evaluate_pose_target_solves_collision_aware_ik(ask):
    pose = ask("evaluate", {"groups": ["manipulator"], "joints": dict.fromkeys(JOINTS, 0.2)})["poses"]["manipulator"]
    solved = ask("evaluate", {"groups": ["manipulator"], "poses": {"manipulator": pose}, "seed": dict.fromkeys(JOINTS, 0.0)})
    assert solved["success"], solved["message"]
    assert set(solved["joints"]) == set(JOINTS)
    assert solved["poses"]["manipulator"]["position"] == pytest.approx(pose["position"], abs=1e-3)


def test_scene_carries_obstacle_shapes_and_versions(module, ask):
    before = ask("scene")
    module.add_obstacle("table", Pose(position=Vector3(0.5, 0.0, -0.1)), "box", [0.4, 0.6, 0.05])
    scene = ask("scene", before["versions"])
    assert scene["versions"]["obstacles"] > before["versions"]["obstacles"]
    table = next(shape for shape in scene["obstacles"] if shape["name"].startswith("table"))
    assert table["type"] == "box"
    assert table["dimensions"] == pytest.approx([0.4, 0.6, 0.05])
    assert table["pose"]["position"] == pytest.approx([0.5, 0.0, -0.1])
    # unchanged parts are left out when the asker already has them
    assert "obstacles" not in ask("scene", scene["versions"])


def test_scene_carries_grasp_proposals(module, ask):
    best = GraspCandidate(Pose(position=Vector3(0.4, 0.1, 0.2)), score=0.9)
    module.show_grasp_proposals(GraspCandidateArray(candidates=[best, GraspCandidate(score=0.1)]))
    grasps = ask("scene")["grasps"]
    assert [grasp["score"] for grasp in grasps] == [0.9, 0.1]
    assert grasps[0]["pose"]["position"] == pytest.approx([0.4, 0.1, 0.2])
