#!/usr/bin/env python3
"""Validate compatible catalog upgrades in staging before restoring preferences."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import shutil
import subprocess
import tempfile

import apply as patcher

STATE_DIR = patcher.REPO / '.local/plugin-patches/voice-mode'
TOOLCHAIN = patcher.REPO / 'plugins/voice-mode-keeper/node_modules'
KEEPER_NODE = os.environ.get('VOICE_KEEPER_NODE', 'node')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory():
    plugins = json.loads(subprocess.check_output(['bb', 'plugin', 'list', '--json']))['plugins']
    return next((p for p in plugins if p['id'] == 'voice-mode'), None)


def loose(fragment):
    """The fragment as a pattern that ignores how whitespace is laid out."""
    # Tokens in order; any whitespace may appear between them (a line break
    # after "(" from a formatter), and words stay separated by some.
    tokens = re.findall(r'\w+|\S', fragment)
    pattern = ''
    for index, token in enumerate(tokens):
        if index:
            pattern += r'\s+' if token[0].isalnum() and tokens[index - 1][-1].isalnum() else r'\s*'
        pattern += re.escape(token)
    return re.compile(pattern)


def present(text, fragment):
    return fragment in text or loose(fragment).search(text) is not None


def find_unique(text, fragment):
    """(start, end) of the single place fragment occurs, exactly or reformatted."""
    if text.count(fragment) == 1:
        start = text.index(fragment)
        return start, start + len(fragment)
    if text.count(fragment) > 1:
        return None
    matches = list(loose(fragment).finditer(text))
    return (matches[0].start(), matches[0].end()) if len(matches) == 1 else None


def forward_prepare(root, spec):
    """Re-applies the edits to a new release by their source anchors.

    Any version is attempted: an anchor may move or be reformatted, but it must
    still occur exactly once. Whether the result still works is decided by the
    upstream tests, the added regression tests, typecheck and build in
    staging; on any failure the release keeps running unmodified.
    """
    changed = {}
    for name in spec['fileStates']:
        original = (root / name).read_text()
        text = original
        for edit in spec['changes']:
            if edit['file'] != name:
                continue
            if edit['after'] and present(text, edit['after']):
                continue
            if not edit['after'] and not present(text, edit['before']):
                continue
            span = find_unique(text, edit['before'])
            if span is None:
                raise ValueError('Voice Mode source contracts changed: ' + name)
            text = text[:span[0]] + edit['after'] + text[span[1]:]
        if text != original:
            changed[name] = text
    return changed


def run(command, cwd=None):
    # Tool output can contain source paths; keep it out of persistent notices.
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=100)
    if result.returncode:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        log = STATE_DIR / 'last-validation.log'
        log.write_text((result.stdout + result.stderr)[-32_768:])
        log.chmod(0o600)
        raise RuntimeError('Validation failed: ' + Path(command[0]).name)


def recover(plugin, spec):
    journal = STATE_DIR / 'pending-recovery.json'
    if not journal.exists():
        return
    saved = json.loads(journal.read_text())
    root = Path(plugin['rootDir'])
    backup = Path(saved['backup']).resolve()
    if not backup.is_relative_to(STATE_DIR.resolve()):
        raise ValueError('Invalid recovery backup')
    if saved['root'] == str(root):
        for name in saved['files']:
            if name not in spec['fileStates']:
                raise ValueError('Invalid recovery file')
            shutil.copy2(backup / name, root / name)
        shutil.copytree(backup / 'dist', root / 'dist', dirs_exist_ok=True)
        run(['bb', 'plugin', 'reload', 'voice-mode'])
    journal.unlink()


def sync():
    plugin = inventory()
    if not plugin or not plugin['enabled']:
        return {'state': 'idle', 'message': 'Voice Mode выключен или не установлен.', 'version': ''}
    if patcher.verify_fork(plugin):
        return {'state': 'ready', 'message': 'Проверенный форк Voice Mode: правки встроены, повторный патч не нужен.', 'version': plugin['version']}
    if not plugin['source'].startswith('git:https://github.com/steveafrost/bb-plugin-voice-mode.git@'):
        raise ValueError('Voice Mode no longer uses the original catalog source')
    root = Path(plugin['rootDir'])
    spec = json.loads((patcher.HERE / 'changes.json').read_text())
    recover(plugin, spec)
    policy = digest(patcher.HERE / 'changes.json')
    receipt_path = STATE_DIR / 'automatic-receipt.json'
    names = tuple(spec['fileStates'])
    hashes = {name: digest(root / name) for name in names}
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    if receipt.get('policy') == policy and receipt.get('hashes') == hashes:
        return {'state': 'ready', 'message': 'Настройки и правки Voice Mode сохранены.', 'version': plugin['version']}
    try:
        changed = patcher.prepare(root, spec)
    except RuntimeError:
        changed = forward_prepare(root, spec)
    if not changed:
        return {'state': 'ready', 'message': 'Настройки и правки Voice Mode сохранены.', 'version': plugin['version']}
    before = {name: (root / name).read_bytes() for name in changed}
    # Tests and build run outside the installed source, with the keeper's
    # pinned dependencies. No npm install or network access during upgrades.
    with tempfile.TemporaryDirectory(prefix='voice-mode-update-') as directory:
        stage = Path(directory) / 'plugin'
        shutil.copytree(root, stage, ignore=shutil.ignore_patterns('node_modules', 'dist', 'media', '.git'))
        (stage / 'node_modules').symlink_to(TOOLCHAIN, target_is_directory=True)
        for name, text in changed.items():
            (stage / name).write_text(text)
        run([KEEPER_NODE, str(TOOLCHAIN / 'vitest/vitest.mjs'), 'run', 'test/server.test.ts', 'test/compact-hosts.test.ts'], stage)
        run([KEEPER_NODE, str(TOOLCHAIN / 'typescript/bin/tsc'), '--noEmit', '--skipLibCheck'], stage)
        run(['bb', 'plugin', 'build', str(stage)])
        current = inventory()
        if not current or not current['enabled'] or current['rootDir'] != str(root):
            raise ValueError('Voice Mode changed again during validation; retry after the update')
        if any(digest(root / name) != hashes[name] for name in names):
            raise ValueError('Voice Mode source changed during validation')
        backup = Path(tempfile.mkdtemp(prefix='automatic-backup-', dir=STATE_DIR))
        shutil.copytree(root / 'dist', backup / 'dist')
        for name, data in before.items():
            saved = backup / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            saved.write_bytes(data)
        journal = STATE_DIR / 'pending-recovery.json'
        journal.write_text(json.dumps({'root': str(root), 'backup': str(backup), 'files': list(changed)}))
        try:
            for name, text in changed.items():
                (root / name).write_text(text)
            shutil.copytree(stage / 'dist', root / 'dist', dirs_exist_ok=True)
            run(['bb', 'plugin', 'reload', 'voice-mode'])
            active = inventory()
            if not active or active['rootDir'] != str(root) or active['status'] != 'running':
                raise RuntimeError('Voice Mode did not activate')
        except BaseException:
            for name, data in before.items():
                (root / name).write_bytes(data)
            shutil.copytree(backup / 'dist', root / 'dist', dirs_exist_ok=True)
            current = inventory()
            if current and current['rootDir'] == str(root):
                run(['bb', 'plugin', 'reload', 'voice-mode'])
            journal.unlink(missing_ok=True)
            raise
        journal.unlink()
    receipt_path.write_text(json.dumps({'policy': policy, 'hashes': {n: digest(root / n) for n in names}}))
    return {'state': 'ready', 'message': 'Правки автоматически восстановлены после обновления Voice Mode.', 'version': plugin['version']}


def main():
    def interrupted(_signum, _frame):
        raise InterruptedError('Update validation was cancelled')
    signal.signal(signal.SIGTERM, interrupted)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with (STATE_DIR / 'automatic.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'state': 'checking', 'message': 'Проверка обновления уже выполняется.', 'version': ''}))
            return
        try:
            if '--snapshot' in sys.argv[1:]:
                run([sys.executable, str(patcher.REPO / 'scripts/snapshot.py'), '--settings-only'])
                result = {'state': 'ready', 'message': 'Приватный снимок bb-config обновлён.', 'version': ''}
            else:
                result = sync()
        except Exception as error:
            report = STATE_DIR / 'last-error.txt'
            report.write_text(type(error).__name__ + ': ' + str(error)[:1000])
            report.chmod(0o600)
            message = ('Правки Voice Mode сохранены, но приватный снимок bb-config не удалось обновить.'
                       if '--snapshot' in sys.argv[1:] else
                       'Новая версия Voice Mode работает в исходном виде: личные правки не прошли проверку совместимости. Настройки сохранены; требуется адаптация правок.')
            result = {'state': 'attention', 'message': message, 'version': ''}
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
