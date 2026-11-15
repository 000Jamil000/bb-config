#!/usr/bin/env python3
"""Reapply reviewed customizations while retaining the catalog installation."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def prepare(root, spec):
    if json.loads((root / 'package.json').read_text())['version'] != spec['version']:
        raise RuntimeError('Unsupported Voice Mode version; review changes.json before applying.')
    original, updated = {}, {}
    for name, states in spec['fileStates'].items():
        content = (root / name).read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if digest not in states:
            raise RuntimeError(f'{name}: unknown source revision; review before applying.')
        original[name] = content.decode()
        text = original[name]
        for edit in spec['changes'][states[digest]:]:
            if edit['file'] != name:
                continue
            # A deletion may be repeated to normalize an older patch revision
            # whose installer skipped empty replacements. File hashes above
            # still restrict this to explicitly reviewed source states.
            if not edit['after'] and edit['before'] not in text:
                continue
            if text.count(edit['before']) != 1:
                raise RuntimeError(f'{name}: source changed; refusing an ambiguous patch.')
            text = text.replace(edit['before'], edit['after'], 1)
        updated[name] = text
    return {name: text for name, text in updated.items() if text != original[name]}


def restore_speech_settings():
    saved = REPO / '.local/config/plugins/voice-mode.json'
    if saved.exists():
        data = json.loads(saved.read_text())
        for key in ('vadThreshold', 'silenceDurationMs', 'noiseReduction'):
            if key in data:
                subprocess.run(['bb', 'plugin', 'config', 'voice-mode', 'set', key,
                                json.dumps(data[key]) if not isinstance(data[key], str) else data[key]], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Patch, build and reload the installed plugin')
    args = parser.parse_args()
    inventory = json.loads(subprocess.check_output(['bb', 'plugin', 'list', '--json']))['plugins']
    plugin = next(p for p in inventory if p['id'] == 'voice-mode')
    if not plugin['source'].startswith('git:https://github.com/steveafrost/bb-plugin-voice-mode.git@'):
        raise RuntimeError('Expected the original managed catalog installation.')
    root = Path(plugin['rootDir'])
    spec = json.loads((HERE / 'changes.json').read_text())
    changed = prepare(root, spec)
    print('Files needing changes:', ', '.join(changed) or 'none (already applied)', flush=True)
    if not args.apply:
        return
    if not changed:
        restore_speech_settings()
        return
    backup_root = REPO / '.local' / 'plugin-patches' / 'voice-mode'
    backup_root.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix='backup-', dir=backup_root))
    for name in changed:
        destination = backup / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, destination)
    if (root / 'dist').exists():
        shutil.copytree(root / 'dist', backup / 'dist')
    try:
        for name, text in changed.items():
            (root / name).write_text(text)
        subprocess.run(['bb', 'plugin', 'build', str(root)], check=True)
        subprocess.run(['bb', 'plugin', 'reload', 'voice-mode'], check=True)
    except BaseException:
        for name in changed:
            shutil.copy2(backup / name, root / name)
        if (backup / 'dist').exists():
            shutil.copytree(backup / 'dist', root / 'dist', dirs_exist_ok=True)
        subprocess.run(['bb', 'plugin', 'reload', 'voice-mode'], check=False)
        raise
    restore_speech_settings()
    print('Applied; catalog source retained. Refresh snapshot with --settings-only.', flush=True)


if __name__ == '__main__':
    main()
