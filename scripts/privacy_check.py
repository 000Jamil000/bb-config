#!/usr/bin/env python3
"""Check publishable files, the staged index, or all reachable Git history.

Only report locations and categories, never matched values. Pattern matching
cannot establish that every possible secret or personal detail is absent.
"""
import argparse
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    'private key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|AGE-SECRET-KEY-[A-Z0-9]{20,}'),
    'access token': re.compile(rb'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}'),
    'personal BB address': re.compile(rb'(?<![\w-])(?!example\.getbb\.app)[a-z0-9-]+\.getbb\.app'),
    'installation identifier': re.compile(rb'\b(?:host|thr|proj|env|auto)_[a-z0-9]{10,}\b'),
    'personal home directory': re.compile(rb'/[U]sers/(?!example(?:/|\b))[^/\s"\x27]+'),
    'credential URL': re.compile(rb'\bhttps?://[^\s/<>"\x27:]+:[^\s/<>"\x27@]+@'),
}


def git(*args, **kwargs):
    return subprocess.check_output(['git', *args], cwd=ROOT, **kwargs)


def findings(path, data):
    if path.startswith(('.local/', 'secrets/')) or Path(path).name in {'.env', 'auth.json'}:
        yield 'private path'
    for label, pattern in PATTERNS.items():
        if pattern.search(data):
            yield label


def entries(staged=False, history=False):
    if history:
        # Include branches, tags and remote-tracking refs. Reflogs are not pushed.
        for row in git('rev-list', '--objects', '--all').splitlines():
            oid, _, name = row.partition(b' ')
            if not name or git('cat-file', '-t', oid.decode()).strip() != b'blob':
                continue
            yield name.decode(errors='replace'), git('cat-file', 'blob', oid.decode())
        # Commit messages and author/committer identities are public as well.
        for oid in git('rev-list', '--all').splitlines():
            raw = git('cat-file', 'commit', oid.decode())
            yield 'commit:' + oid[:10].decode(), raw
    elif staged:
        for row in git('ls-files', '--stage', '-z').split(b'\0'):
            if not row:
                continue
            meta, name = row.split(b'\t', 1)
            oid = meta.split()[1]
            yield name.decode(), git('cat-file', 'blob', oid.decode())
    else:
        for name in git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0'):
            if name:
                path = ROOT / name.decode()
                if path.is_file():
                    yield name.decode(), path.read_bytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--staged', action='store_true')
    mode.add_argument('--history', action='store_true')
    args = parser.parse_args()
    count = 0
    checked = 0
    for name, data in entries(args.staged, args.history):
        checked += 1
        for category in findings(name, data):
            print(f'{name}: {category}')
            count += 1
    print(f'Privacy patterns: {checked} entries checked, {count} findings. Review the diff before publishing.')
    return 1 if count else 0


if __name__ == '__main__':
    raise SystemExit(main())
