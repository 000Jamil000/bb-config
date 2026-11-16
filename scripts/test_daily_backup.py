import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import daily_backup
import private_backup
import server_backup


@unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'), 'age required')
class DailyConfigTests(unittest.TestCase):
    def test_offline_retry_reuses_encrypted_snapshot_and_can_be_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True, capture_output=True)
            (root / '.gitignore').write_text('.local/\nscripts/ignored.py\n')
            scripts = root / 'scripts'
            scripts.mkdir()
            (scripts / 'fixture.py').write_text('# current uncommitted source')
            (scripts / 'ignored.py').write_text('ignored fixture')
            (scripts / '.env').write_text('fixture secret')
            (scripts / 'fixture.sqlite').write_bytes(b'fixture database')
            config = root / '.local/config'
            config.mkdir(parents=True)
            (config / 'fixture.json').write_text('{"example": true}')
            identity = subprocess.run(['age-keygen'], capture_output=True, check=True).stdout
            public = subprocess.run(['age-keygen', '-y'], input=identity,
                                    capture_output=True, check=True).stdout.decode().strip()
            source = root / 'state'
            cli = Mock()
            cli.call.return_value = {'status': 'disconnected'}
            # The real encryption and disk state run; only BB and delivery are fixtures.
            original_run = subprocess.run
            def run(command, **kwargs):
                if str(command[1]).endswith('snapshot.py'):
                    return subprocess.CompletedProcess(command, 0)
                return original_run(command, **kwargs)
            with patch.object(daily_backup.subprocess, 'run', side_effect=run) as snapshot, \
                 patch.object(daily_backup, 'install_restore_tools'), \
                 patch.object(server_backup, 'deliver') as deliver:
                daily_backup.config_tick(root, source, cli, public, 'fixture-host', '/fixture')
                state = json.loads((source / 'state.json').read_text())
                self.assertFalse(state['delivered'])
                archive = Path(state['archive'])
                cli.call.return_value = {'status': 'connected'}
                daily_backup.config_tick(root, source, cli, public, 'fixture-host', '/fixture')
                self.assertEqual(sum(str(c.args[0][1]).endswith('snapshot.py') for c in snapshot.call_args_list), 1)
                deliver.assert_called_once_with(cli, archive, 'fixture-host', '/fixture', 7)
                self.assertTrue(json.loads((source / 'state.json').read_text())['delivered'])
            decrypted = subprocess.run(['age', '--decrypt', '--identity', '-', str(archive)],
                                       input=identity, capture_output=True, check=True).stdout
            import io
            import tarfile
            checked = root / 'checked-config.tar.gz'
            checked.write_bytes(decrypted)
            self.assertGreater(private_backup.validate_backup(checked), 0)
            with tarfile.open(fileobj=io.BytesIO(decrypted), mode='r:gz') as restored:
                self.assertEqual(restored.extractfile('.local/config/fixture.json').read(), b'{"example": true}')
                self.assertEqual(restored.extractfile('source/scripts/fixture.py').read(), b'# current uncommitted source')
                self.assertFalse(any(x.name.endswith(('.env', '.sqlite', 'ignored.py')) for x in restored.getmembers()))
                self.assertTrue(all(x.name.startswith(('.local/config', '.local/docs', 'source/'))
                                    for x in restored.getmembers()))
