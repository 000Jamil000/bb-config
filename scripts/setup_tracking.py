#!/usr/bin/env python3
"""Enable the shared BB reminder and repository hook; default is a preview."""
import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOCK = re.compile(r'\[bb-config tracking\].*?\[/bb-config tracking\]', re.S)


def merge_instructions(current, rule):
    if BLOCK.search(current):
        return BLOCK.sub(lambda match: rule.strip(), current)
    return '\n\n'.join(part for part in (current.strip(), rule.strip()) if part)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    rule = (ROOT / 'config/tracking-instructions.txt').read_text()
    print('BB: append/update the bb-config reminder in Custom instructions (all providers/projects).')
    print('Git: set core.hooksPath=.githooks for this repository.')
    if not args.apply:
        print('Preview only. Run with --apply to enable, then snapshot.py --settings-only.')
        return
    current = subprocess.run(['git', 'config', '--get', 'core.hooksPath'], cwd=ROOT,
                             text=True, capture_output=True).stdout.strip()
    if current and current != '.githooks':
        raise SystemExit('Existing hooksPath was preserved: ' + current + '. Chain .githooks/pre-commit manually.')
    # Preserve unrelated global instructions; only replace our marked block.
    config = json.loads(subprocess.check_output(
        ['bb', 'plugin', 'config', 'custom-instructions', '--json'], text=True))
    merged = merge_instructions(config['values'].get('instructions', ''), rule)
    subprocess.run(['bb', 'plugin', 'config', 'custom-instructions', 'set', 'instructions', merged],
                   check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['bb', 'plugin', 'enable', 'custom-instructions'], check=True, stdout=subprocess.DEVNULL)
    (ROOT / '.githooks/pre-commit').chmod(0o755)
    if current != '.githooks':
        subprocess.run(['git', 'config', 'core.hooksPath', '.githooks'], cwd=ROOT, check=True)
    print('Enabled. The hook checks live BB before commits; it never writes a snapshot or commits automatically.')


if __name__ == '__main__':
    main()
