"""Python's own pickle.loads on the requests server/src/pickle.rs writes (src/pickle_fixtures/ours_*.req.pkl):
each must load as dimos's real classes with the intended (args, kwargs). Run with a dimos venv:
    <dimos>/.venv/bin/python server/scripts/check_pickle_requests.py
"""

import pickle
from pathlib import Path

from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.msgs.sensor_msgs.JointState import JointState

FIXTURES = Path(__file__).resolve().parent.parent / "src" / "pickle_fixtures"


def load(name: str):
    return pickle.loads((FIXTURES / f"ours_{name}.req.pkl").read_bytes())


assert load("empty") == ([], {})
assert load("execute") == ([], {"blocking": False, "plan_id": "84a9de8e36c04ece99efcd5d7716bf88"})

args, kwargs = load("plan_to_joints")
target = args[0]["manipulator"]
assert isinstance(target, JointState), type(target)
assert target.name == [f"joint{i}" for i in range(1, 8)]
assert target.position == [0.6, 0.1, 0.0, 1.2, 0.0, 1.0, 0.0]
assert kwargs == {"speed_scale": 0.5}

args, kwargs = load("plan_to_poses")
pose = args[0]["manipulator"]
assert isinstance(pose, PoseStamped), type(pose)
assert pose.frame_id == "world"
assert (pose.position.x, pose.position.y, pose.position.z) == (0.35, 0.2, 0.45)
assert (pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w) == (1.0, 0.0, 0.0, 0.0)
assert kwargs == {}

print("ok: Python's pickle.loads reads every request the controller writes, as dimos's own classes")
