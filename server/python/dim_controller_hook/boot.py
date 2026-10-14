"""Run from the .pth file at interpreter startup: patch WorldMonitor.finalize when (if ever) dimos imports it.

Costs every Python process in the venv one import-hook lookup per module import and nothing else. Set
DIM_CONTROLLER_HOOK=0 to turn it off.
"""

import importlib.abc
import importlib.machinery
import os
import sys

TARGET = "dimos.manipulation.planning.monitor.world_monitor"


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name != TARGET:
            return None
        sys.meta_path.remove(self)
        try:
            spec = importlib.machinery.PathFinder.find_spec(name, path)
        finally:
            sys.meta_path.insert(0, self)
        if spec is None or spec.loader is None or not hasattr(spec.loader, "exec_module"):
            return spec
        exec_module = spec.loader.exec_module

        def exec_and_patch(module):
            exec_module(module)
            try:
                from dim_controller_hook.tee import patch

                patch(module)
            except Exception as error:
                print(f"[dim-controller hook] off: {error!r}", file=sys.stderr)

        spec.loader.exec_module = exec_and_patch
        sys.meta_path.remove(self)
        return spec


if os.environ.get("DIM_CONTROLLER_HOOK", "1") != "0" and TARGET not in sys.modules:
    sys.meta_path.insert(0, _Finder())
