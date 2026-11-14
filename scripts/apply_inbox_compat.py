#!/usr/bin/env python3
"""Apply the reviewed Needs You 0.2.1 UI compatibility patch without uninstalling."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from server_backup import Cli

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='host_example')
    parser.add_argument('--apply', action='store_true', help='Write, build and reload; default only checks')
    args = parser.parse_args()
    cli = Cli()
    plugin = next(p for p in cli.call('plugin', 'list', '--json')['plugins'] if p['id'] == 'inbox')
    location = plugin['rootDir']
    patch_root = ROOT / 'plugins/inbox-compat'
    known = json.loads((patch_root / 'upstream.json').read_text())
    remote = cli.call('file', 'read', location + '/app.tsx', '--host', args.host, '--json')
    current = remote['sha256']
    if current not in {known['originalSha256'], known['patchedSha256']}:
        raise RuntimeError('Needs You source changed; review the new upstream version before patching')
    if not args.apply:
        print('Compatibility patch installed.' if current == known['patchedSha256'] else 'Known affected source; run with --apply to repair popups and the badge.')
        return
    if current == known['originalSha256']:
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'app.tsx'
            source.write_text(remote['content'])
            subprocess.run(['patch', '--batch', '--silent', '-p1'], cwd=folder,
                input=(patch_root / 'app.patch').read_text(), text=True,
                capture_output=True, check=True)
            fixed = source.read_text()
        if hashlib.sha256(fixed.encode()).hexdigest() != known['patchedSha256']:
            raise RuntimeError('Patched source checksum mismatch')
        cli.call('file', 'write', location + '/app.tsx', '--host', args.host,
                 '--expected-sha256', current, '--stdin', '--json', stdin=fixed)
    code = '''import subprocess,sys,os
os.chdir(sys.argv[1])
for args in [['bb','plugin','types','.'],['npm','install','--no-audit','--no-fund'],['bb','plugin','build','.'],['bb','plugin','reload','inbox']]:
 subprocess.run(args,check=True)
'''
    cli.remote_python(args.host, code, location)
    print('Needs You UI repaired through normal build/reload; settings and inbox data preserved.')


if __name__ == '__main__':
    main()
