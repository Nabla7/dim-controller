"""dim-controller's window into a running dimos ManipulationModule, from outside dimos.

dimos hands its manipulation visualizer (viser) everything the controller's arm view needs: the robot model, the
planning world's obstacles, grasp proposals, previews, and an operator that checks a target the way the planner
will (collision-aware IK). None of that is reachable over an RPC, so this package is installed into the venv a
blueprint runs from (install.py: a .pth file Python runs at startup) and, once dimos's WorldMonitor is imported,
wraps WorldMonitor.finalize to stand beside that visualizer. It answers zenoh queries on ``dim_controller/hook/*``
(JSON in, JSON out) on loopback only.

It is a stopgap until WorldMonitor exposes this itself. Every touch point with dimos is checked first; anything
that doesn't match the dimos it finds turns that piece (or the whole hook) off with one warning, never dimos.
"""

VERSION = 1
