#!/usr/bin/env python3
"""Repair Tokenomics 0.2.2 JSON limits response on the BB server machine."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Patch, build and reload; default checks only')
    args = parser.parse_args()
    plugins = json.loads(subprocess.check_output(['bb', 'plugin', 'list', '--json']))['plugins']
    plugin = next(p for p in plugins if p['id'] == 'tokenomics')
    if plugin.get('provenance') != 'catalog':
        raise RuntimeError('Expected Tokenomics installed from the catalog')
    location = Path(plugin['rootDir'])
    target = location / 'server.ts'
    if not target.is_file():
        raise RuntimeError('Run on the BB server machine where the installed source exists')
    patch_root = ROOT / 'plugins/tokenomics-compat'
    known = json.loads((patch_root / 'upstream.json').read_text())
    original = target.read_text()
    current = digest(original)
    if plugin['version'] != known['version'] or current not in {
        known['originalSha256'], known['patchedSha256']
    }:
        raise RuntimeError('Tokenomics upstream changed; review before applying this patch')
    if not args.apply:
        print('Compatibility source patch present.' if current == known['patchedSha256']
              else 'Known affected source; run with --apply to repair the JSON limits response.')
        return
    if current == known['originalSha256']:
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'server.ts'
            source.write_text(original)
            subprocess.run(['patch', '--batch', '--silent', '-p1'], cwd=folder,
                           input=(patch_root / 'server.patch').read_text(), text=True, check=True)
            fixed = source.read_text()
        if digest(fixed) != known['patchedSha256']:
            raise RuntimeError('Patched source checksum mismatch')
        if digest(target.read_text()) != current:
            raise RuntimeError('Installed source changed during patch preparation')
        target.write_text(fixed)
    subprocess.run(['bb', 'plugin', 'build', str(location)], check=True)
    subprocess.run(['bb', 'plugin', 'reload', 'tokenomics'], check=True)
    print('Tokenomics rebuilt and reloaded; catalog source and settings preserved.')


if __name__ == '__main__':
    main()
