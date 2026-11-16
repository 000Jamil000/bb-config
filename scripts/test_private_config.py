import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

import privacy_check
import private_backup
import backup_keys
from unittest.mock import patch


class PrivacyTests(unittest.TestCase):
    def test_reports_categories_without_returning_values(self):
        address = b'https://' + b'private-server' + b'.getbb.app'
        self.assertEqual(list(privacy_check.findings('file.ts', address)), ['personal BB address'])
        self.assertEqual(list(privacy_check.findings('.local/config/private.json', b'{}')), ['private path'])
        self.assertFalse(list(privacy_check.findings('example.md', b'https://example.getbb.app /Users/example/test')))
        self.assertTrue(list(privacy_check.findings('file', b'host_' + b'abcdefgh12')))


@unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'), 'age tools required')
class PrivateBackupTests(unittest.TestCase):
    def test_real_roundtrip_contains_private_config_and_docs_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for folder in ('config', '.local/config', '.local/docs', '.local/privacy-migration'):
                (root / folder).mkdir(parents=True)
            (root / '.local/config/private.json').write_text('{"address":"private fixture"}')
            (root / '.local/docs/recovery.md').write_text('Private recovery')
            (root / '.local/privacy-migration/old.bundle').write_text('must not include')
            (root / 'config/general.json').write_text('{}')
            identity = subprocess.check_output(['age-keygen'], stderr=subprocess.DEVNULL)
            public = subprocess.check_output(['age-keygen', '-y'], input=identity).decode().strip()
            target = private_backup.backup(root, public)
            plain = subprocess.check_output(['age', '--decrypt', '-i', '-', str(target)], input=identity)
            with tarfile.open(fileobj=io.BytesIO(plain), mode='r:gz') as archive:
                self.assertEqual(set(archive.getnames()), {'.local/config', '.local/config/private.json',
                    '.local/docs', '.local/docs/recovery.md'})
                self.assertEqual(json.load(archive.extractfile('.local/config/private.json')), {'address': 'private fixture'})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            # The same Keychain recovery command must accept daily config and
            # full-server formats; the fixture key stays in memory.
            with patch.object(backup_keys, 'Keychain') as keychain, \
                 patch.object(backup_keys, 'age_tool', side_effect=shutil.which):
                keychain.return_value.get.return_value = identity
                restored = root / 'restored.tar.gz'
                backup_keys.decrypt(target, restored)
                self.assertEqual(restored.read_bytes(), plain)

    def test_no_recipient_or_symlink_cannot_export_private_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.local/config').mkdir(parents=True)
            with self.assertRaises(ValueError):
                private_backup.backup(root)
            (root / '.local/config/escape').symlink_to(root)
            with self.assertRaisesRegex(ValueError, 'symbolic links'):
                private_backup.backup(root, 'not-used')
            self.assertFalse(list(root.rglob('*.age')))


if __name__ == '__main__':
    unittest.main()
