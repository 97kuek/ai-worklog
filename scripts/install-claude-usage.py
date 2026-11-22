#!/usr/bin/env python3
"""Register one or more Claude Code accounts and preserve their existing status lines."""
import argparse
import fcntl
import json
import os
import re
from pathlib import Path
import shlex
import stat
import tempfile


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    encoded = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as out:
        temp = Path(out.name)
        try:
            os.fchmod(out.fileno(), mode)
            out.write(encoded)
            out.flush()
            os.fsync(out.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    os.replace(temp, path)


def wrapped(settings, binary):
    current = settings.get("statusLine", {})
    if not isinstance(current, dict) or current.get("type", "command") != "command":
        raise ValueError("unsupported statusLine type")
    previous = current.get("command")
    marker = "# taskfolio claude-statusline v1\n"
    if previous:
        if previous.startswith(marker):
            words = shlex.split(previous[len(marker):])
            previous = words[3] if words[:3] == ["set", "--", "--render"] else None
        else:
            # Accept the original one-line wrapper on upgrades.
            try:
                words = shlex.split(previous)
            except ValueError:
                words = []
            if (len(words) in (2, 4) and Path(words[0]).name == binary.name and
                    words[1] == "claude-statusline" and (len(words) == 2 or words[2] == "--render")):
                previous = words[3] if len(words) == 4 else None
    if binary.is_relative_to(Path.home()):
        executable = '"$HOME"/' + shlex.quote(str(binary.relative_to(Path.home())))
    else:
        executable = shlex.quote(str(binary))
    args = "set --" if not previous else "set -- --render " + shlex.quote(previous)
    command = (marker + args + "\n" +
               f'if [ -x {executable} ]; then exec {executable} claude-statusline "$@"; fi\n' +
               'if [ "$#" -eq 2 ]; then exec "${SHELL:-/bin/sh}" -c "$2"; fi')
    return {**settings, "statusLine": {**current, "type": "command", "command": command}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", metavar="ACCOUNT=DIR", action="append", required=True,
                        help="register this Claude Code configuration directory (repeatable)")
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--taskfolio-home", type=Path)
    parser.add_argument("--settings-source", type=Path, help="also wrap the managed source for these settings")
    args = parser.parse_args()
    home = args.taskfolio_home
    if not home:
        override = os.getenv("TASKFOLIO_HOME") or os.getenv("AI_WORKLOG_HOME")
        home = Path(override) if override else Path.home() / ".taskfolio"
        legacy = Path.home() / ".ai-worklog"
        if not override and not home.exists() and legacy.is_dir():
            home = legacy
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY)
    try:
        # Two concurrent additive registrations must see each other's entries.
        fcntl.flock(directory_fd, fcntl.LOCK_EX)
        register(args, parser, home)
    finally:
        os.close(directory_fd)


def register(args, parser, home):
    registry_path = home / "claude-usage-profiles.json"
    existing = json.loads(registry_path.read_text()) if registry_path.exists() else {}
    if not isinstance(existing, dict):
        parser.error("invalid Claude profile registry")
    requested = {}
    for item in args.profile:
        account, separator, value = item.partition("=")
        if not separator or not value or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", account):
            parser.error("--profile requires ACCOUNT=DIR with a valid account ID")
        if account in requested:
            parser.error(f"duplicate account ID: {account}")
        path = Path(value).expanduser().resolve(strict=True)
        if not path.is_dir():
            parser.error("profile must be a directory")
        requested[account] = str(path)
    registry = {**existing, **requested}
    if any(not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", name) or
           not isinstance(value, str) or not Path(value).is_absolute() for name, value in registry.items()):
        parser.error("invalid Claude profile registry")
    if len({Path(value).resolve() for value in registry.values()}) != len(registry):
        parser.error("each account must have its own Claude configuration directory")
    binary = args.binary.expanduser().resolve(strict=True)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error("taskfolio binary must be executable")
    targets = []
    if args.settings_source:
        targets.append(args.settings_source.resolve(strict=True))
    targets.extend((Path(directory) / "settings.json").resolve() for directory in requested.values())
    updates = {}
    for path in dict.fromkeys(targets):
        current = json.loads(path.read_text()) if path.exists() else {}
        updates[path] = (current, wrapped(current, binary))
    if existing != registry:
        atomic_json(registry_path, registry)
    for path, (current, edited) in updates.items():
        if current != edited:
            atomic_json(path, edited)
    print("Registered Claude Code accounts: " + ", ".join(requested))


if __name__ == "__main__":
    main()
