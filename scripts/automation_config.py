#!/usr/bin/env python3
"""Save/restore known script schedules separately from private runtime data."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / '.local/config/automations.json'
SOURCES = {'server_backup.py', 'daily_backup.py', 'thread_watchdog.py', 'thread_queue_monitor.py'}
SAFE_ENV = {'BB_BACKUP_RECIPIENT', 'BB_BACKUP_DESTINATION_HOST', 'BB_BACKUP_DESTINATION_DIR',
            'BB_CONFIG_ROOT', 'WATCHDOG_THREAD', 'WATCHDOG_STATE', 'MONITOR_STORAGE'}


def bb(args):
    p = subprocess.run([os.environ.get('BB_CLI') or 'bb', *args, '--json'],
                       capture_output=True, text=True, timeout=90)
    if p.returncode:
        raise RuntimeError(f'BB command failed ({p.returncode}): {args[:3]}')
    return json.loads(p.stdout)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--snapshot', action='store_true')
    p.add_argument('--project', action='append', default=[])
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()
    if a.snapshot:
        if a.apply or not a.project:
            p.error('--snapshot requires --project and cannot combine with --apply')
        records = []
        for project in a.project:
            for row in bb(['automation', 'list', '--project', project]):
                execution = row['execution']
                source = execution.get('scriptFile', '')
                # BB versions stored on update carry a UUID before the suffix.
                source = re.sub(r'\.[0-9a-f]{8}-[0-9a-f-]{27}(?=\.py$)', '', source)
                if execution.get('mode') != 'script' or source not in SOURCES:
                    continue
                env = execution.get('env', {})
                if set(env) - SAFE_ENV:
                    raise RuntimeError('Unknown environment fields; review before saving automation ' + row['id'])
                records.append({'id': row['id'], 'project': project, 'name': row['name'],
                                'enabled': row['enabled'], 'trigger': row['trigger'],
                                'source': 'scripts/' + source, 'interpreter': execution['interpreter'],
                                'timeoutMs': execution['timeoutMs'], 'env': env,
                                'workingDirectory': execution['workingDirectory']})
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(json.dumps({'version': 1, 'automations': records}, ensure_ascii=False, indent=2) + '\n')
        MANIFEST.chmod(0o600)
        print(f'Saved {len(records)} schedules to .local/config/automations.json; no run logs or conversation data.')
        return
    records = json.loads(MANIFEST.read_text())['automations']
    for row in records:
        existing = bb(['automation', 'list', '--project', row['project']])
        matches = [x for x in existing if x['id'] == row['id']]
        if not matches:
            matches = [x for x in existing if x['name'] == row['name']]
        if len(matches) > 1:
            raise RuntimeError('Ambiguous automation name; resolve manually')
        action = 'update' if matches else 'create'
        print(f'{action}: {row["name"]} (enabled={row["enabled"]})')
        if not a.apply:
            continue
        trigger = row['trigger']
        if trigger.get('triggerType') != 'schedule' or not trigger.get('cron'):
            raise RuntimeError('Only recurring cron schedules are supported')
        policy = row['workingDirectory']
        directory = policy['path'] if policy['type'] == 'path' else policy['type']
        env = dict(row['env'])
        if row['source'] == 'scripts/daily_backup.py':
            env['BB_CONFIG_ROOT'] = str(ROOT)
            directory = str(ROOT)
        args = ['automation', action]
        if matches:
            args += [matches[0]['id']]
        args += ['--project', row['project'], '--name', row['name'],
                 '--cron', trigger['cron'], '--timezone', trigger['timezone'],
                 '--script-file', str(ROOT / row['source']), '--interpreter', row['interpreter'],
                 '--timeout', str(row['timeoutMs']), '--env-json', json.dumps(env),
                 '--working-directory', directory]
        if not matches:
            args += ['--disabled']
        result = bb(args)
        bb(['automation', 'resume' if row['enabled'] else 'pause', result['id'], '--project', row['project']])


if __name__ == '__main__':
    main()
