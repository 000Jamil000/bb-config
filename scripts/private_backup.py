#!/usr/bin/env python3
"""Encrypt private config/docs with age; keep the archive outside Git."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def backup(root=ROOT, recipient=None):
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
        plain.chmod(0o600)
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
