#!/usr/bin/env python3
"""Move Voice Mode to the reviewed fork using only the public BB CLI."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import apply as patcher


def cli(*args):
    return json.loads(subprocess.check_output(['bb', *args, '--json'], text=True))


def installed():
    return next((p for p in cli('plugin', 'list')['plugins'] if p['id'] == 'voice-mode'), None)


def restore_preferences(values, enabled):
    for key, value in values.items():
        argument = value if isinstance(value, str) else json.dumps(value)
        subprocess.run(['bb', 'plugin', 'config', 'voice-mode', 'set', key, argument],
                       check=True, stdout=subprocess.DEVNULL)
    if not enabled:
        subprocess.run(['bb', 'plugin', 'disable', 'voice-mode'], check=True, stdout=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    current = installed()
    if current and patcher.verify_fork(current):
        print('Reviewed fork already installed; no reinstall.')
        return
    if args.check:
        raise SystemExit('Reviewed Voice Mode fork is not installed.')
    if not current:
        raise SystemExit('Voice Mode is not installed; this migration does not enable new components.')
    if not current['source'].startswith('git:https://github.com/steveafrost/bb-plugin-voice-mode.git@'):
        raise SystemExit('Unexpected source; refusing to replace it.')
    settings = cli('plugin', 'config', 'voice-mode')
    values = settings['values']
    # Removal clears secrets. Never export credentials or silently discard one.
    secret_keys = {k for k, definition in settings['schema'].items() if definition.get('secret')}
    for key in secret_keys:
        value = values.get(key)
        if value not in (None, '') and value != {'set': False}:
            raise SystemExit('A plugin secret is configured; migration stopped without removing anything. Use a credential-preserving migration or re-enter it securely after explicit approval.')
    preferences = {k: v for k, v in values.items() if k not in secret_keys}
    policy = json.loads((patcher.HERE / 'fork.json').read_text())
    target = 'git:' + policy['repository'] + '@' + policy['commit']
    journal_dir = patcher.REPO / '.local/plugin-patches/voice-mode'
    journal_dir.mkdir(parents=True, exist_ok=True)
    journal = journal_dir / 'fork-migration.json'
    journal.write_text(json.dumps({'source': current['source'], 'enabled': current['enabled'], 'preferences': preferences, 'target': target}, indent=2))
    journal.chmod(0o600)
    subprocess.run(['bb', 'plugin', 'remove', 'voice-mode'], check=True, stdout=subprocess.DEVNULL)
    try:
        subprocess.run(['bb', 'plugin', 'install', target, '--yes'], check=True)
        restore_preferences(preferences, current['enabled'])
        if not patcher.verify_fork(installed()):
            raise RuntimeError('Fork verification failed')
        actual = cli('plugin', 'config', 'voice-mode')['values']
        if any(actual.get(k) != v for k, v in preferences.items()):
            raise RuntimeError('Preference verification failed')
    except Exception:
        # If the install failed before registering, restore the original source.
        # Never remove a newly registered plugin blindly on uncertain failure.
        if installed() is None:
            subprocess.run(['bb', 'plugin', 'install', current['source'], '--yes'], check=True)
            restore_preferences(preferences, current['enabled'])
        raise
    print('Reviewed fork installed; nonsecret settings and enabled state verified.')


if __name__ == '__main__':
    main()
