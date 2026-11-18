"""Windows compatibility for the scripts; on other systems every helper is a no-op.

Three things differ on Windows and each broke a script that was written on Linux/macOS:

- `bb` and `npm` are `.cmd` launchers, which `subprocess` cannot start by bare
  name without a shell: `argv()` resolves them to something CreateProcess runs.
- Files in this repository and the output of `bb`/`git` are UTF-8, while Python
  defaults to the ANSI code page: `utf8_main()` re-runs the script in UTF-8 mode.
- There is no `fcntl`: `lock()` takes the same exclusive lock through `msvcrt`.
"""
import functools
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

WINDOWS = os.name == 'nt'


def utf8_main():
    """Call first under `if __name__ == '__main__'`: continue in Python UTF-8 mode."""
    if WINDOWS and not sys.flags.utf8_mode:
        raise SystemExit(subprocess.call([sys.executable, '-X', 'utf8', *sys.argv]))


def _node_version(node):
    try:
        text = subprocess.run([node, '-p', 'process.versions.node'], capture_output=True, text=True, timeout=20).stdout
        return tuple(int(part) for part in text.strip().split('.')[:3])
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def node_exits_cleanly(version):
    """False for Node releases that abort on Windows when the bb CLI calls process.exit().

    nodejs/node#56645: a libuv assertion (src\\win\\async.c) kills the process
    after the command has printed its result, so every plugin command reports
    failure. It came with V8 12.8 (Node 23) and was fixed by nodejs/node#61999.
    Checked here: 24.13.0 aborts every time, 24.22.1 never does. Unknown
    versions count as broken; the fallback below is harmless.
    """
    if version is None:
        return False
    return version < (23, 0, 0) or (24, 22, 1) <= version < (25, 0, 0) or version >= (26, 0, 0)


@functools.lru_cache(maxsize=1)
def _bb_command():
    """argv prefix that runs the bb CLI on Windows, and extra environment for it."""
    script = os.environ.get('BB_CLI')
    if not script or not Path(script).is_file():
        script = shutil.which('bb')
        if not script:
            raise FileNotFoundError('bb was not found on PATH and BB_CLI is not set')
    if script.lower().endswith(('.cmd', '.bat')):
        text = Path(script).read_text(encoding='utf-8', errors='replace')
        entry = re.search(r'^"[^"\r\n]+\.exe"\s+"([^"\r\n]+)"\s+%\*', text, re.MULTILINE)
        if 'Written by bb:' in text and entry:
            # The desktop app's own launcher (<data dir>\bin\bb.cmd, which is
            # what an automation gets): `"<bb.exe>" "<app>\dist\bb.js" %*`.
            script = entry.group(1)
        else:
            # The host daemon's launcher only runs `node <the script next to it>`.
            script = str(Path(script).with_suffix(''))
    # <app>/dist/bb.js is an Electron launcher; the Node CLI is in
    # host-daemon/dist (the same choice server_backup.Cli makes).
    native = Path(script).resolve().parent.parent / 'host-daemon/dist/bb'
    if native.is_file():
        script = str(native)
    if script.lower().endswith('.exe'):
        return (script,), {}
    node = shutil.which('node')
    if node and node_exits_cleanly(_node_version(node)):
        return (node, script), {}
    # The desktop app ships its own Node (the one its server and daemon run on):
    # <install>\resources\app.asar.unpacked\node_modules\bb-app\host-daemon\dist\bb
    for parent in Path(script).resolve().parents:
        if parent.name == 'resources' and (parent.parent / 'bb.exe').is_file():
            return (str(parent.parent / 'bb.exe'), script), {'ELECTRON_RUN_AS_NODE': '1'}
    if node:
        return (node, script), {}
    raise FileNotFoundError('Node.js was not found on PATH; the bb CLI needs it')


def argv(command):
    """The command as CreateProcess can start it. `bb` may also be the value of $BB_CLI."""
    command = [str(part) for part in command]
    if not WINDOWS:
        return command
    head = command[0]
    if head == 'bb' or (os.environ.get('BB_CLI') and head == os.environ['BB_CLI']):
        prefix, environment = _bb_command()
        os.environ.update(environment)
        return [*prefix, *command[1:]]
    found = shutil.which(head)
    if not found and head == 'patch' and shutil.which('git'):
        # Git for Windows ships GNU patch next to git, outside PATH.
        bundled = Path(shutil.which('git')).resolve().parents[1] / 'usr/bin/patch.exe'
        found = str(bundled) if bundled.is_file() else None
    return [found or head, *command[1:]]


def lock(handle):
    """Exclusive lock on an open file until it is closed (fcntl.flock semantics)."""
    if not WINDOWS:
        import fcntl
        fcntl.flock(handle, fcntl.LOCK_EX)
        return
    import msvcrt
    while True:
        try:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return
        except OSError:
            time.sleep(0.05)


def try_lock(handle):
    """Like lock(), but returns False at once when another process holds it."""
    try:
        if WINDOWS:
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def link_directory(link, target):
    """A directory link that needs no privileges: a junction on Windows, a symlink elsewhere."""
    if WINDOWS:
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    else:
        Path(link).symlink_to(target, target_is_directory=True)


def _is_junction(link):
    """Path.is_junction() exists from Python 3.12; 3.11 reads the reparse-point attribute."""
    if hasattr(link, 'is_junction'):
        return link.is_junction()
    try:
        attributes = os.lstat(link).st_file_attributes
    except (OSError, AttributeError):
        return False
    return bool(attributes & 0x400) and not link.is_symlink()  # FILE_ATTRIBUTE_REPARSE_POINT


def unlink_directory(link):
    """Remove such a link only, never what it points at."""
    link = Path(link)
    if WINDOWS and _is_junction(link):
        os.rmdir(link)
    elif link.is_symlink():
        link.unlink()
