#!/usr/bin/env python3
"""Put dim-controller's hook (dim_controller_hook/) into the venv a dimos blueprint runs from, or take it out.

    install_hook.py                     # every venv a running `dimos run` uses (from dimos's run registry)
    install_hook.py --venv PATH         # that venv (or its python)
    install_hook.py --uninstall [...]   # take it out again
    install_hook.py --status [...]      # say where it is installed

The hook loads when a process starts, so a blueprint that is already running sees it after a restart. Stdlib only:
it runs under any python.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

PACKAGE = Path(__file__).resolve().parent / "dim_controller_hook"
PTH_NAME = "dim_controller_hook.pth"
# one line, run by site.py at startup; harmless when the package has since been removed
PTH_LINE = 'import importlib.util as _u; _u.find_spec("dim_controller_hook") and __import__("dim_controller_hook.boot")\n'
RUNS = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "dimos" / "runs"


def running_pythons() -> list[Path]:
    """The python of every live `dimos run` in dimos's run registry (each worktree's own venv)."""
    pythons: list[Path] = []
    for entry in sorted(RUNS.glob("*.json")):
        try:
            pid = int(json.loads(entry.read_text())["pid"])
            os.kill(pid, 0)
        except (OSError, ValueError, KeyError):
            continue
        executable = process_executable(pid)
        if executable is not None and executable not in pythons:
            pythons.append(executable)
    return pythons


def process_executable(pid: int) -> Path | None:
    if sys.platform.startswith("linux"):
        try:
            return Path(os.readlink(f"/proc/{pid}/exe"))
        except OSError:
            return None
    answer = subprocess.run(["ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True)
    executable = answer.stdout.strip()
    return Path(executable) if executable else None


def python_of(venv: Path) -> Path:
    if venv.is_file():
        return venv
    for candidate in (venv / "bin" / "python", venv / "bin" / "python3"):
        if candidate.exists():
            return candidate
    raise SystemExit(f"no python in {venv}")


def site_packages(python: Path) -> Path:
    answer = subprocess.run(
        [str(python), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
        capture_output=True,
        text=True,
        check=True,
    )
    return Path(answer.stdout.strip())


def install(target: Path) -> None:
    destination = target / "dim_controller_hook"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(PACKAGE, destination, ignore=shutil.ignore_patterns("__pycache__"))
    (target / PTH_NAME).write_text(PTH_LINE)


def uninstall(target: Path) -> None:
    shutil.rmtree(target / "dim_controller_hook", ignore_errors=True)
    (target / PTH_NAME).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--venv", type=Path, action="append", help="a venv (or its python); repeatable")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--uninstall", action="store_true")
    action.add_argument("--status", action="store_true")
    args = parser.parse_args()

    pythons = [python_of(venv) for venv in args.venv] if args.venv else running_pythons()
    if not pythons:
        raise SystemExit(f"no running `dimos run` in {RUNS}: pass --venv")
    for python in pythons:
        target = site_packages(python)
        if args.status:
            installed = (target / PTH_NAME).exists() and (target / "dim_controller_hook").exists()
            print(f"{'installed' if installed else 'not installed'}: {target}")
        elif args.uninstall:
            uninstall(target)
            print(f"removed: {target}")
        else:
            install(target)
            print(f"installed: {target} (restart the blueprint to load it)")


if __name__ == "__main__":
    main()
