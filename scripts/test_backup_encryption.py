import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('backup', ROOT / 'server_backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
spec2 = importlib.util.spec_from_file_location('fixtures', ROOT / 'test_server_backup.py')
fixtures = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(fixtures)


@unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'), 'age tools required')
class EncryptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.identity = subprocess.run(['age-keygen'], capture_output=True, check=True).stdout
        self.public = subprocess.run(['age-keygen', '-y'], input=self.identity,
                                     capture_output=True, check=True).stdout.decode().strip()

    def tearDown(self):
        self.temp.cleanup()

    def decrypt(self, ciphertext):
        return subprocess.run(['age', '--decrypt', '--identity', '-', str(ciphertext)],
                              input=self.identity, capture_output=True)

    def test_real_encryption_decryption_and_ciphertext_delivery(self):
        original = self.root / 'original.tar.gz'
        fixtures.archive(original)
        encrypted = self.root / 'bb-server-20260104.tar.gz.age'
        backup.encrypt_archive(original, encrypted, self.public)
        self.assertNotIn(b'fixture: no real credentials', encrypted.read_bytes())
        result = self.decrypt(encrypted)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, original.read_bytes())
        incoming = self.root / '.incoming'
        incoming.mkdir()
        import base64
        (incoming / 'part-00000000').write_bytes(base64.b64encode(encrypted.read_bytes()))
        destination = self.root / 'received' / encrypted.name
        destination.parent.mkdir()
        result = subprocess.run([__import__('sys').executable, '-c', backup.FINALIZE,
            str(incoming), str(destination), backup.digest(encrypted), '3'], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(backup.digest(encrypted), backup.digest(destination))
        self.assertTrue(json.loads(destination.with_suffix('.age.json').read_text())['encrypted'])

    def test_tampered_ciphertext_cannot_decrypt(self):
        original = self.root / 'original.tar.gz'
        fixtures.archive(original)
        encrypted = self.root / 'backup.age'
        backup.encrypt_archive(original, encrypted, self.public)
        data = bytearray(encrypted.read_bytes())
        data[-1] ^= 1
        encrypted.write_bytes(data)
        self.assertNotEqual(self.decrypt(encrypted).returncode, 0)

    def test_failed_encryption_keeps_source_and_no_partial_ciphertext(self):
        original = self.root / 'original.tar.gz'
        fixtures.archive(original)
        encrypted = self.root / 'backup.age'
        with self.assertRaises(subprocess.CalledProcessError):
            backup.encrypt_archive(original, encrypted, 'invalid-recipient')
        self.assertTrue(original.is_file())
        self.assertFalse(encrypted.exists())
        self.assertFalse(encrypted.with_name(encrypted.name + '.partial').exists())

    def test_missing_recipient_never_exports_plaintext(self):
        args = argparse.Namespace(source_dir=str(self.root / 'source'), recipient=None)
        with self.assertRaisesRegex(RuntimeError, 'plaintext backups are disabled'):
            backup.tick(args)
        self.assertFalse(list((self.root / 'source').glob('*.tar.gz')))


if __name__ == '__main__':
    unittest.main()
