#!/usr/bin/env python3
"""Encrypt private config/docs with age; keep the archive outside Git."""
import argparse
import datetime as dt
import json
import os
import posixpath
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def validate_backup(path):
    """Validate the private archive's paths without extracting personal data."""
    files = 0
    has_config = False
    with tarfile.open(path, 'r|gz') as archive:
        for member in archive:
            relative = Path(member.name)
            allowed = relative.parts[:2] in [('.local', 'config'), ('.local', 'docs')]
            source = relative.parts[:1] == ('source',)
            if relative.is_absolute() or '..' in relative.parts or not (allowed or source):
                raise ValueError('Unsafe private backup member')
            has_config |= relative.parts[:2] == ('.local', 'config')
            if member.issym() and source:
                target = posixpath.normpath(posixpath.join(relative.parent.as_posix(), member.linkname))
                if not target.startswith('source/'):
                    raise ValueError('Source link escapes restored checkout')
            elif not (member.isfile() or member.isdir()):
                raise ValueError('Unsupported private backup member')
            if member.isfile():
                files += 1
                with archive.extractfile(member) as stream:
                    while stream.read(1024 * 1024):
                        pass
    if not has_config:
        raise ValueError('Private backup has no configuration snapshot')
    return files


def backup(root=ROOT, recipient=None, include_sources=False):
    if not recipient:
        raise ValueError('Set BB_BACKUP_RECIPIENT or .local/config/backup-encryption.json first')
    folders = [root / '.local' / name for name in ('config', 'docs')]
    if not folders[0].is_dir():
        raise ValueError('No .local/config/ snapshot to back up')
    output = root / '.local/backups/config'
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    name = 'private-config-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.tar.gz.age'
    target = output / name
    # Plaintext exists only inside a private temporary directory, removed on exit.
    with tempfile.TemporaryDirectory(prefix='bb-private-') as directory:
        plain = Path(directory) / 'config.tar.gz'
        with tarfile.open(plain, 'w:gz') as archive:
            for folder in folders:
                if folder.exists():
                    # Never follow symlinks out of the two explicit private folders.
                    for path in [folder, *sorted(folder.rglob('*'))]:
                        if path.is_symlink():
                            raise ValueError('Private backup refuses symbolic links')
                        if path.is_file() or path.is_dir():
                            archive.add(path, arcname=str(path.relative_to(root)), recursive=False)
            if include_sources:
                # Preserve current customizations without committing on the
                # user's behalf. Git's ignore rules exclude runtime/private data.
                result = subprocess.run(['git', 'ls-files', '--cached', '--others',
                                         '--exclude-standard', '-z'], cwd=root,
                                        capture_output=True, check=True, timeout=30)
                roots = {'scripts', 'plugins', 'config', 'docs', '.bb'}
                top = {'README.md', 'AGENTS.md', 'CLAUDE.md', '.gitignore'}
                for name in sorted(set(result.stdout.decode().split('\0')) - {''}):
                    relative = Path(name)
                    if relative.parts[0] not in roots and name not in top:
                        continue
                    if any(part in {'.git', '.local', 'node_modules', 'logs', 'auth', 'credentials'}
                           or part.startswith('.env') for part in relative.parts):
                        continue
                    if relative.suffix.lower() in {'.db', '.sqlite', '.sqlite3', '.pem', '.key', '.p12'}:
                        continue
                    path = root / relative
                    if path.is_symlink():
                        if Path(os.readlink(path)).is_absolute() or not path.resolve().is_relative_to(root.resolve()):
                            raise ValueError('Source backup refuses links outside checkout')
                    elif not path.is_file():
                        continue
                    archive.add(path, arcname='source/' + name, recursive=False)
        plain.chmod(0o600)
        validate_backup(plain)
        encrypted = Path(directory) / 'encrypted.age'
        subprocess.run(['age', '--encrypt', '--recipient', recipient, '--output', str(encrypted), str(plain)],
                       check=True, capture_output=True)
        encrypted.chmod(0o600)
        # The temporary directory may be on another filesystem.
        with target.open('xb') as stream:
            os.chmod(target, 0o600)
            stream.write(encrypted.read_bytes())
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    settings = ROOT / '.local/config/backup-encryption.json'
    recipient = os.environ.get('BB_BACKUP_RECIPIENT')
    if not recipient and settings.is_file():
        recipient = json.loads(settings.read_text()).get('recipient')
    print('Encrypted private backup: ' + str(backup(recipient=recipient)))
    print('Copy this archive to another machine or external storage; it is not in Git.')


if __name__ == '__main__':
    main()
