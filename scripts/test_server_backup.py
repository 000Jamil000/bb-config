import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('server_backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def archive(path, corrupt=False):
    body = b'fixture: no real credentials or databases'
    manifest = {'format': 'bb-server-archive', 'version': 2, 'entries': [
        {'path': 'fixture.txt', 'size': len(body),
         'sha256': hashlib.sha256(body if not corrupt else b'wrong').hexdigest()}]}
    with tarfile.open(path, 'w:gz') as out:
        for name, data in [('manifest.json', json.dumps(manifest).encode()), ('files/fixture.txt', body)]:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            out.addfile(member, io.BytesIO(data))


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def finalize(self, corrupt=False, wrong_digest=False):
        for n in range(3):
            archive(self.root / ('bb-server-2026010%d.tar.gz' % (n + 1)))
        incoming = self.root / '.incoming-test'
        incoming.mkdir()
        src = incoming / 'source.tar.gz'
        archive(src, corrupt)
        (incoming / 'part-00000000').write_bytes(base64.b64encode(src.read_bytes()))
        expected = '0' * 64 if wrong_digest else backup.digest(src)
        destination = self.root / 'bb-server-20260104.tar.gz'
        completed = subprocess.run([sys.executable, '-c', backup.FINALIZE,
                                    str(incoming), str(destination), expected, '3'],
                                   capture_output=True)
        return completed, destination

    def test_delivery_verifies_then_keeps_three_newest(self):
        completed, destination = self.finalize()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(destination.exists())
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list(self.root.glob('bb-server-*.tar.gz'))), 3)
        self.assertFalse((self.root / 'bb-server-20260101.tar.gz').exists())
        backup.validate_archive(destination)

    def test_corrupt_contents_keep_all_old_backups(self):
        completed, destination = self.finalize(corrupt=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(destination.exists())
        self.assertEqual(len(list(self.root.glob('bb-server-*.tar.gz'))), 3)

    def test_incomplete_delivery_keeps_all_old_backups(self):
        completed, destination = self.finalize(wrong_digest=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(destination.exists())
        self.assertEqual(len(list(self.root.glob('bb-server-*.tar.gz'))), 3)

    def test_validator_rejects_bad_manifest_member(self):
        path = self.root / 'invalid.tar.gz'
        archive(path, corrupt=True)
        with self.assertRaises(ValueError):
            backup.validate_archive(path)

    def test_desktop_launcher_uses_native_cli_without_reexec_loop(self):
        package = self.root / 'bb-app'
        native = package / 'host-daemon/dist/bb'
        native.parent.mkdir(parents=True)
        native.touch()
        launcher = package / 'dist/bb.js'
        with patch.dict(os.environ, {'BB_CLI': str(launcher)}):
            cli = backup.Cli()
            self.assertEqual(cli.path, str(native))
            with patch.object(backup.subprocess, 'run') as run:
                run.return_value.returncode = 0
                run.return_value.stdout = '{}'
                cli.call('status', '--json')
                self.assertEqual(run.call_args.kwargs['env']['BB_CLI'], str(native))

    def test_installed_shell_launcher_resolves_its_native_cli(self):
        package = self.root / 'bb-app'
        native = package / 'host-daemon/dist/bb'
        native.parent.mkdir(parents=True)
        native.touch()
        launcher = self.root / 'bb'
        launcher.write_text("#!/bin/sh\n# Written by bb: installed CLI\nentry='" + str(package / 'dist/bb.js') + "'\n")
        with patch.dict(os.environ, {'BB_CLI': str(launcher)}):
            self.assertEqual(backup.Cli().path, str(native))


if __name__ == '__main__':
    unittest.main()
