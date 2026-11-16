#!/usr/bin/env python3
"""Preview/apply safe Codex defaults without copying credentials or other settings."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import uuid
import tomllib

ROOT = Path(__file__).resolve().parents[1]
KEY = 'project_doc_max_bytes'


def update_text(text, minimum):
    """Validate TOML and preserve every setting except the root budget."""
    original = tomllib.loads(text)
    current = original.get(KEY)
    if current is not None and (type(current) is not int or current < 0):
        raise ValueError('Unsupported root instruction budget; config left unchanged')
    if current is not None and current >= minimum:
        return text, current
    if current is None:
        candidates = [f'{KEY} = {minimum}\n' + text]
    else:
        pattern = re.compile(r'(?m)^([ \t]*project_doc_max_bytes[ \t]*=[ \t]*)([0-9_]+)([ \t]*(?:#[^\r\n]*)?\r?)$')
        candidates = [text[:m.start(2)] + str(minimum) + text[m.end(2):] for m in pattern.finditer(text)]
    expected = dict(original, project_doc_max_bytes=minimum)
    safe = [candidate for candidate in candidates if tomllib.loads(candidate) == expected]
    if len(safe) != 1:
        raise ValueError('Ambiguous root instruction budget; config left unchanged')
    return safe[0], current


def apply(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix='.codex-defaults-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def verify(config_home):
    with tempfile.TemporaryDirectory(prefix='codex-defaults-check-') as directory:
        workspace = Path(directory)
        (workspace / '.git').mkdir()
        marker = 'INSTRUCTION_BUDGET_' + uuid.uuid4().hex
        (workspace / 'AGENTS.md').write_text('x' * 34000 + '\n' + marker + '\n', encoding='utf-8')
        result = subprocess.run(['codex', 'debug', 'prompt-input', 'Instruction budget check'],
            cwd=workspace, env=dict(os.environ, CODEX_HOME=str(config_home)),
            capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError('Codex prompt-input verification failed (exit %s)' % result.returncode)
        items = json.loads(result.stdout)
        texts = [part.get('text', '') for item in items for part in item.get('content', [])
                 if isinstance(part, dict)]
        if not any(marker in text for text in texts):
            raise RuntimeError('Marker after 34000 bytes missing from actual Codex prompt')
        print('PASS: actual Codex prompt contains the marker after 34000 bytes')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--defaults', type=Path, default=ROOT / 'config/codex.json')
    parser.add_argument('--config', type=Path, help='Explicit config.toml; otherwise active CODEX_HOME or ~/.codex')
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--apply', action='store_true')
    actions.add_argument('--check', action='store_true')
    parser.add_argument('--verify', action='store_true', help='Also inspect a real offline Codex prompt')
    args = parser.parse_args()
    defaults = json.loads(args.defaults.read_text())
    if set(defaults) != {KEY} or type(defaults[KEY]) is not int or defaults[KEY] <= 0:
        raise SystemExit('Defaults must contain only a positive integer project_doc_max_bytes')
    home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex').expanduser()
    path = (args.config or home / 'config.toml').expanduser().resolve()
    text = path.read_bytes().decode('utf-8') if path.exists() else ''
    updated, current = update_text(text, defaults[KEY])
    changed = updated != text
    print(json.dumps({'config': str(path), 'current': current, 'minimum': defaults[KEY], 'change_needed': changed}))
    if args.apply and changed:
        apply(path, updated)
        assert update_text(path.read_bytes().decode('utf-8'), defaults[KEY])[0] == updated
        print('Applied Codex instruction budget; other settings preserved')
    if args.check and changed:
        raise SystemExit(1)
    if args.verify:
        verify(path.parent)


if __name__ == '__main__':
    main()
