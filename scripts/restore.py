#!/usr/bin/env python3
"""Preview restoration; --plugins --apply installs plugins and restores preferences."""
import argparse
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1]
# These may change connectivity or provider routing. Preserve for explicit setup.
MANUAL_SETTINGS = {'connect', 'proxy-manager', 'provider-acp'}
MANUAL_STATES = {'connect', 'bb--connect-next', 'account-pool'}


def read(name, root=ROOT):
    return json.loads((root / 'config' / f'{name}.json').read_text())


def value(data):
    return data if isinstance(data, str) else json.dumps(data, separators=(',', ':'))


def install_source(plugin):
    if plugin['source'].startswith('builtin:'):
        return plugin['source']
    if plugin.get('installSource'):
        return plugin['installSource']
    # BB records a normalized internal range; the install CLI takes @<range>.
    return plugin['source'].replace('@semver:', '@')


def plan(install_plugins=False, root=ROOT):
    """Commands are argv arrays; saved text is never interpreted by a shell."""
    commands = []
    manifest = read('plugins', root)
    if install_plugins:
        for plugin in manifest:
            source = install_source(plugin)
            if source.startswith('builtin:'):
                continue  # Bundled with BB; check availability at apply time.
            if source.startswith('path:'):
                relative = Path(source.removeprefix('path:'))
                if relative.is_absolute() or '..' in relative.parts:
                    raise ValueError('Local plugin source must be relative to this repository')
                directory = root / relative
                if not (directory / 'package.json').is_file():
                    raise ValueError('Missing plugin sources: ' + str(relative))
                commands.extend([
                    ['npm', '--prefix', str(directory), 'ci'],
                    ['bb', 'plugin', 'build', str(directory)],
                    ['bb', 'plugin', 'install', 'path:' + str(directory), '--yes'],
                ])
            else:
                commands.append(['bb', 'plugin', 'install', source, '--yes'])
    # Make commands contributed by bundled plugins available before their prefs.
    if install_plugins:
        for plugin in manifest:
            if plugin['enabled'] and plugin['id'] not in MANUAL_STATES:
                commands.append(['bb', 'plugin', 'enable', plugin['id']])
    for key, data in read('general', root).items():
        if key == 'providerCompletedTurnDisplay':
            for provider, mode in data.items():
                commands.append(['bb', 'settings', 'completed-turns', provider, mode])
        else:
            commands.append(['bb', 'settings', 'general', key, value(data)])
    for key, data in read('experiments', root).items():
        commands.append(['bb', 'settings', 'experiment', key, value(data)])
    appearance = read('appearance', root)
    if appearance['customCss'] is None:
        commands.append(['bb', 'theme', 'set', appearance['themeId'], '--favicon-color', appearance['faviconColor']])
    for path in sorted((root / 'config/plugins').glob('*.json')):
        if path.stem in MANUAL_SETTINGS:
            continue
        for key, data in json.loads(path.read_text()).items():
            commands.append(['bb', 'plugin', 'config', path.stem, 'set', key, value(data)])
    for key, data in read('ui', root).items():
        commands.append(['bb', 'settings', 'ui', 'set', key, value(data)])
    for key, data in read('thread-list', root).items():
        # Old machine/project/thread ids cannot be reused on a fresh installation.
        if key in {'hiddenGroups', 'collapsedProjects', 'collapsedThreads', 'collapsedEnvironments',
                   'collapsedThreadSections', 'collapsedMachines'} and data:
            continue
        commands.append(['bb', 'thread-list', 'prefs', 'set', key, value(data)])
    for task, selection in read('ai-services', root).items():
        mode = selection['mode']
        if mode in {'automatic', 'off'}:
            commands.append(['bb', 'settings', 'ai-services', 'set', task, mode])
    if install_plugins:
        # Disabling a provider or command owner comes last.
        for plugin in manifest:
            if not plugin['enabled'] and plugin['id'] not in MANUAL_STATES:
                commands.append(['bb', 'plugin', 'disable', plugin['id']])
    return commands


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Execute the plan (default: print only)')
    parser.add_argument('--plugins', action='store_true', help='Also install plugins and restore enabled/disabled state')
    args = parser.parse_args()
    commands = plan(args.plugins)
    if args.apply and args.plugins:
        # path: sources are read by the BB server. Refuse a remote-server path
        # mismatch before running even npm ci or changing any preferences.
        status = json.loads(subprocess.check_output(['bb', 'status', '--json'], text=True))
        if not Path(status['dataDir']).is_dir():
            raise SystemExit('Run --plugins --apply on the BB server machine, in its bb-config checkout. '
                             'Local plugin paths are server-side; this CLI is connected remotely.')
    for command in commands:
        # Global instructions can contain private text on an existing install.
        is_instructions = command[:5] == ['bb', 'plugin', 'config', 'custom-instructions', 'set']
        print(shlex.join(command[:-1] + ['<saved instructions>'] if is_instructions else command), flush=True)
        if args.apply:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    print('\nManual steps: docs/customizations.md (credentials, routes, machine IDs, keyboard/custom CSS).')
    print('Finish with: python3 scripts/setup_tracking.py --apply')


if __name__ == '__main__':
    main()
