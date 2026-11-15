#!/usr/bin/env python3
"""Give existing user LaunchAgents readable names in macOS Login Items.

Default is a plan. Original service arguments, environment and accounts stay in
their LaunchAgents. A tiny launcher execs the original Node; privacy grants,
runtime, accounts and service implementation are not migrated.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

ROLES = {
    'bb': ('BB — Mac Connection', 'BB — Mac Connection', 'app.getbb.personal.mac-service-launcher'),
    'mcpgo-terminal': ('McpGo — Terminal', 'McpGo — Terminal', 'app.getbb.personal.mcpgo-terminal'),
    'mcpgo-oneshot': ('McpGo — Quick Commands', 'McpGo — Quick Commands', 'app.getbb.personal.mcpgo-oneshot'),
    'mcpgo-browser': ('McpGo — Browser', 'McpGo — Browser', 'app.getbb.personal.mcpgo-browser'),
    'mcpgo-proxy': ('McpGo — Browser Proxy', 'McpGo — Browser Proxy', 'app.getbb.personal.mcpgo-proxy'),
    'mcpgo-tunnel': ('McpGo — Tunnel', 'McpGo — Tunnel', 'app.getbb.personal.mcpgo-tunnel'),
    'mcpgo-messaging': ('McpGo — Messages', 'McpGo — Messages', 'app.getbb.personal.mcpgo-messaging'),
    'mcpgo-autosend': ('McpGo — Auto-send', 'McpGo — Auto-send', 'app.getbb.personal.mcpgo-autosend'),
    'mcpgo-dashboard': ('McpGo — Dashboard', 'McpGo — Dashboard', 'app.getbb.personal.mcpgo-dashboard'),
}
BASE = Path.home() / 'Library/Application Support/BB Named Services'
APPS = Path.home() / 'Applications/BB Services'


def role_for(label):
    if label.startswith('app.getbb.host-daemon.'):
        return 'bb'
    return {'com.chatterminalhub.oneshot': 'mcpgo-oneshot',
            'com.chatterminalhub.server': 'mcpgo-terminal',
            'com.mcphub.playwright.browser': 'mcpgo-browser',
            'com.mcphub.playwright.proxy': 'mcpgo-proxy',
            'com.mcphub.playwright.tunnel': 'mcpgo-tunnel',
            'com.mcphub.messaging': 'mcpgo-messaging',
            'com.mcphub.autosend': 'mcpgo-autosend',
            'com.mcphub.dashboard': 'mcpgo-dashboard'}.get(label)


def command(args, check=True, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        # Do not expose service arguments or environment to logs.
        raise RuntimeError(Path(args[0]).name + ' failed: ' + result.stderr[-400:])
    return result


def atomic_plist(path, data):
    mode = path.stat().st_mode & 0o777
    with tempfile.NamedTemporaryFile('wb', dir=path.parent, delete=False) as stream:
        plistlib.dump(data, stream)
        temporary = Path(stream.name)
    temporary.chmod(mode)
    temporary.replace(path)


def save_state(state):
    BASE.mkdir(parents=True, exist_ok=True)
    path = BASE / 'state.json'
    with tempfile.NamedTemporaryFile('w', dir=BASE, delete=False) as stream:
        json.dump(state, stream, ensure_ascii=False, indent=2)
        temporary = Path(stream.name)
    temporary.chmod(0o600)
    temporary.replace(path)


def loaded(label):
    return command(['/bin/launchctl', 'print', 'gui/' + str(os.getuid()) + '/' + label], check=False).returncode == 0


def replacement(data, executable, identifier):
    import copy
    updated = copy.deepcopy(data)
    if not isinstance(updated.get('ProgramArguments'), list) or not updated['ProgramArguments']:
        raise ValueError('LaunchAgent has no ProgramArguments.')
    updated['ProgramArguments'][0] = str(executable)
    if 'Program' in updated:
        updated['Program'] = str(executable)
    updated['AssociatedBundleIdentifiers'] = [identifier]
    return updated


def discover():
    result = []
    for path in sorted((Path.home() / 'Library/LaunchAgents').glob('*.plist')):
        with path.open('rb') as stream:
            data = plistlib.load(stream)
        role = role_for(data.get('Label', ''))
        arguments = data.get('ProgramArguments', [])
        if not role or not arguments:
            continue
        program = Path(arguments[0])
        if program.name != 'node' and program.name != ROLES[role][1]:
            continue
        result.append((path, data, role))
    return result


def build_app(role, source):
    name, binary, identifier = ROLES[role]
    destination = APPS / (name + '.app')
    APPS.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        with (destination / 'Contents/Info.plist').open('rb') as stream:
            if plistlib.load(stream).get('CFBundleIdentifier') != identifier:
                raise ValueError('Refusing to replace an unrelated application.')
    with tempfile.TemporaryDirectory(prefix='.named-service-', dir=APPS) as directory:
        app = Path(directory) / destination.name
        contents = app / 'Contents'; executable = contents / 'MacOS' / binary
        executable.parent.mkdir(parents=True)
        (contents / 'Resources').mkdir()
        command(['/usr/bin/clang', '-Os', str(Path(__file__).with_name('macos_service_launcher.c')), '-o', str(executable)])
        (contents / 'Resources/node-path.txt').write_text(str(source) + '\n')
        info = {'CFBundleName': name, 'CFBundleDisplayName': name,
                'CFBundleIdentifier': identifier, 'CFBundleExecutable': binary,
                'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1',
                'CFBundleShortVersionString': '1.0', 'LSUIElement': True,
                'NSAppleEventsUsageDescription': name + ' runs your authorised automation on this Mac.'}
        candidates = [Path('/Applications/bb.app')] if role == 'bb' else [Path('/Applications/McpGo.app'), Path.home() / 'Applications/McpGo.app', Path('/Volumes/McpGo/McpGo.app')]
        original_app = next((app for app in candidates if app.is_dir()), candidates[0])
        original_info = original_app / 'Contents/Info.plist'
        if original_info.exists():
            with original_info.open('rb') as stream:
                original = plistlib.load(stream)
            icon = original.get('CFBundleIconFile', '')
            if icon and not icon.endswith('.icns'):
                icon += '.icns'
            icon_source = original_app / 'Contents/Resources' / icon
            if icon and icon_source.is_file():
                shutil.copy2(icon_source, contents / 'Resources/Service.icns')
                info['CFBundleIconFile'] = 'Service.icns'
        with (contents / 'Info.plist').open('wb') as stream:
            plistlib.dump(info, stream)
        signing = ['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', identifier]
        command(signing + [str(app)])
        command(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)])
        version = command([str(executable), '--version']).stdout.strip()
        command([str(executable), '-e', 'if(new Function("return 6*7")()!==42)process.exit(1)'])
        if destination.exists():
            shutil.rmtree(destination)
        shutil.move(str(app), str(destination))
    command(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', '-f', str(destination)])
    if original_app.is_dir():
        # Login Items may use the executable's file icon instead of the bundle.
        script = 'function run(argv) { ObjC.import("AppKit"); const w=$.NSWorkspace.sharedWorkspace; return w.setIconForFileOptions(w.iconForFile(argv[0]), argv[1], 0); }'
        command(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, str(original_app), str(destination / 'Contents/MacOS' / binary)], check=False)
    return destination / 'Contents/MacOS' / binary, version


def restart(path, label):
    domain = 'gui/' + str(os.getuid())
    command(['/bin/launchctl', 'bootout', domain, str(path)])
    command(['/bin/launchctl', 'bootstrap', domain, str(path)])


def runtime_check(state):
    import re
    results = []
    for filename, entry in state['agents'].items():
        with Path(filename).open('rb') as stream:
            data = plistlib.load(stream)
        status = command(['/bin/launchctl', 'print', 'gui/' + str(os.getuid()) + '/' + data['Label']], check=False)
        expected = str(APPS / (ROLES[entry['role']][0] + '.app') / 'Contents/MacOS' / ROLES[entry['role']][1])
        if status.returncode:
            results.append({'label': data['Label'], 'loaded': False,
                            'configured_launcher': data['ProgramArguments'][0] == expected}); continue
        program = re.search(r'^\s*program = (.+)$', status.stdout, re.M)
        pid = re.search(r'^\s*pid = (\d+)$', status.stdout, re.M)
        results.append({'label': data['Label'], 'loaded': True, 'running': bool(pid),
                        'configured_launcher': data['ProgramArguments'][0] == expected,
                        'known_runtime': bool(program and program.group(1).strip('"') in (expected, entry['executable']))})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--restart', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--restart-only', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('Run this script on macOS.')
    state_path = BASE / 'state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {'agents': {}, 'apps': {}}
    if args.check:
        print(json.dumps(runtime_check(state), ensure_ascii=False, indent=2)); return
    if args.restart_only:
        if not args.apply:
            print('Restart plan:', len(state['agents']), 'existing service definitions'); return
        report = {'state': 'running', 'restarted': []}
        status_path = BASE / 'restart-status.json'
        def report_status():
            status_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            status_path.chmod(0o600)
        report_status()
        try:
            for filename, entry in sorted(state['agents'].items(), key=lambda item: item[1]['role'] == 'bb'):
                path = Path(filename)
                with path.open('rb') as stream:
                    data = plistlib.load(stream)
                expected = str(APPS / (ROLES[entry['role']][0] + '.app') / 'Contents/MacOS' / ROLES[entry['role']][1])
                if data['ProgramArguments'][0] != expected:
                    raise ValueError('A service definition changed after preparation; recheck the plan.')
                if loaded(data['Label']):
                    restart(path, data['Label'])
                    report['restarted'].append(data['Label'])
                    report_status()
            report['state'] = 'complete'
            report_status()
        except Exception as error:
            report['state'] = 'error'; report['message'] = str(error); report_status(); raise
        print('Restart complete.', flush=True)
        return
    if args.rollback:
        if not args.apply:
            print('Rollback plan:', len(state['agents']), 'LaunchAgents'); return
        for filename, previous in state['agents'].items():
            path = Path(filename)
            with path.open('rb') as stream:
                data = plistlib.load(stream)
            role = previous['role']
            expected = str(APPS / (ROLES[role][0] + '.app') / 'Contents/MacOS' / ROLES[role][1])
            if data['ProgramArguments'][0] != expected:
                continue
            active = loaded(data['Label'])
            data['ProgramArguments'][0] = previous['executable']
            if previous['program_present']:
                data['Program'] = previous['program']
            else:
                data.pop('Program', None)
            if previous['association_present']:
                data['AssociatedBundleIdentifiers'] = previous['association']
            else:
                data.pop('AssociatedBundleIdentifiers', None)
            atomic_plist(path, data)
            if args.restart and active:
                restart(path, data['Label'])
            print('Restored', data['Label'], flush=True)
        return
    agents = discover()
    sources = {}
    for path, data, role in agents:
        current = data['ProgramArguments'][0]
        source = state['agents'].get(str(path), {}).get('executable', current) if str(APPS) in current else current
        if role in sources and sources[role] != source:
            raise SystemExit('This role uses different Node versions; keep the plan and configure it explicitly.')
        sources[role] = source
        print('Plan:', data['Label'], '→', ROLES[role][0], 'loaded=' + str(loaded(data['Label'])), flush=True)
    if not args.apply:
        return
    programs = {}
    # Every bundle and Node/V8 check must pass before a service definition changes.
    for role, source in sources.items():
        programs[role], version = build_app(role, Path(source))
        state['apps'][role] = {'source': source, 'sha256': hashlib.sha256(Path(source).read_bytes()).hexdigest(), 'version': version}
        print('Built', ROLES[role][0], version, flush=True)
    for path, data, role in agents:
        state['agents'].setdefault(str(path), {
            'role': role, 'executable': data['ProgramArguments'][0],
            'program_present': 'Program' in data, 'program': data.get('Program'),
            'association_present': 'AssociatedBundleIdentifiers' in data,
            'association': data.get('AssociatedBundleIdentifiers')})
        state['agents'][str(path)]['role'] = role
        if str(APPS) not in data['ProgramArguments'][0]:
            state['agents'][str(path)]['executable'] = data['ProgramArguments'][0]
    save_state(state)
    # Migrate BB last so another connected tool remains available throughout setup.
    for path, data, role in sorted(agents, key=lambda item: item[2] == 'bb'):
        active = loaded(data['Label'])
        atomic_plist(path, replacement(data, programs[role], ROLES[role][2]))
        if args.restart and active:
            try:
                restart(path, data['Label'])
            except Exception:
                atomic_plist(path, data)
                command(['/bin/launchctl', 'bootstrap', 'gui/' + str(os.getuid()), str(path)], check=False)
                raise
        print('Applied', data['Label'], 'restarted=' + str(args.restart and active), flush=True)
    print('DONE. Login Items now refer to descriptive launchers; original Node and privacy permissions are retained.', flush=True)


if __name__ == '__main__':
    main()
