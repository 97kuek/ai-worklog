#!/usr/bin/env python3
"""Install the signed-in user's opt-in Taskfolio queue runner on macOS."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path, help="Installed Taskfolio binary with the runner command")
    parser.add_argument("--state-dir", type=Path, default=Path.home() / ".taskfolio")
    args = parser.parse_args()
    binary = args.binary.expanduser().resolve()
    state = args.state_dir.expanduser().resolve()
    if sys.platform != "darwin" or not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error("Specify an executable Taskfolio binary on macOS.")
    if not all((state / name).is_file() for name in ("config.json", "runner.json")):
        parser.error("Set up the collector login and runner.json in the state directory first.")
    label = "dev.taskfolio.runner"
    domain = f"gui/{os.getuid()}"
    target = Path.home() / "Library" / "LaunchAgents" / (label + ".plist")
    target.parent.mkdir(parents=True, exist_ok=True)
    (state / "logs").mkdir(exist_ok=True)
    props = {
        "Label": label, "ProgramArguments": [str(binary), "runner"],
        "RunAtLoad": True, "StartInterval": 30, "ProcessType": "Background",
        "StandardOutPath": "/dev/null", "StandardErrorPath": str(state / "logs" / "runner.log"),
        "EnvironmentVariables": {
            "TASKFOLIO_HOME": str(state),
            "PATH": f"{Path.home()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        },
    }
    # Do not interrupt a live runner when an install with identical settings is repeated.
    loaded = subprocess.run(["launchctl", "print", f"{domain}/{label}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if loaded:
        if target.is_file() and plistlib.loads(target.read_bytes()) == props:
            print(f"{label} is already installed.")
            return
        parser.error(f"Stop {label} after its current job finishes before replacing the agent.")
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temp:
        plistlib.dump(props, temp)
    os.replace(temp.name, target)
    subprocess.run(["launchctl", "bootstrap", domain, str(target)], check=True)
    print(f"Installed {label}. It polls every 30 seconds while you are logged in.")


if __name__ == "__main__":
    main()
