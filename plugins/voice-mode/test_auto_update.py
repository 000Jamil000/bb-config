import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import auto_update as updater


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'catalog-release'
        self.root.mkdir()
        (self.root / 'package.json').write_text('{"version":"0.1.16"}')
        (self.root / 'server.ts').write_text('original\n')
        (self.root / 'dist').mkdir()
        (self.root / 'dist/server.js').write_text('original bundle')
        self.state = self.base / 'state'
        self.state.mkdir()
        policy = self.base / 'policy'
        policy.mkdir()
        self.spec = {'version': '0.1.15', 'fileStates': {'server.ts': {
            hashlib.sha256(b'original\n').hexdigest(): 0,
        }}, 'changes': [{'file': 'server.ts', 'before': 'original', 'after': 'customized'}]}
        (policy / 'changes.json').write_text(json.dumps(self.spec))
        self.plugin = {'id': 'voice-mode', 'enabled': True, 'rootDir': str(self.root),
                       'source': 'git:https://github.com/steveafrost/bb-plugin-voice-mode.git@semver:>=0.1.5',
                       'version': '0.1.16', 'status': 'running'}
        for obj, key, value in [(updater, 'STATE_DIR', self.state), (updater.patcher, 'HERE', policy)]:
            manager = patch.object(obj, key, value)
            manager.start()
            self.addCleanup(manager.stop)

    def validate(self, command, cwd=None):
        if command[:3] == ['bb', 'plugin', 'build']:
            dist = Path(command[3]) / 'dist'
            dist.mkdir()
            (dist / 'server.js').write_text('validated bundle')

    def test_compatible_update_is_staged_and_next_check_is_a_no_op(self):
        with patch.object(updater, 'inventory', return_value=self.plugin), patch.object(updater, 'run', side_effect=self.validate) as run:
            self.assertEqual(updater.sync()['state'], 'ready')
            self.assertEqual((self.root / 'server.ts').read_text(), 'customized\n')
            self.assertEqual((self.root / 'dist/server.js').read_text(), 'validated bundle')
            self.assertEqual(run.call_count, 4)
            run.reset_mock()
            self.assertEqual(updater.sync()['state'], 'ready')
            run.assert_not_called()

    def test_validation_failure_does_not_touch_catalog_source(self):
        with patch.object(updater, 'inventory', return_value=self.plugin), patch.object(updater, 'run', side_effect=RuntimeError('test failure')):
            with self.assertRaises(RuntimeError):
                updater.sync()
        self.assertEqual((self.root / 'server.ts').read_text(), 'original\n')
        self.assertEqual((self.root / 'dist/server.js').read_text(), 'original bundle')

    def test_changed_contract_is_rejected_before_build(self):
        (self.root / 'server.ts').write_text('different API\n')
        with patch.object(updater, 'inventory', return_value=self.plugin), patch.object(updater, 'run') as run:
            with self.assertRaises(ValueError):
                updater.sync()
            run.assert_not_called()
        self.assertEqual((self.root / 'server.ts').read_text(), 'different API\n')

    def test_new_release_with_reformatted_anchor_is_prepared(self):
        # A new version is no longer refused by its number; staging decides.
        (self.root / 'package.json').write_text('{"version":"0.2.0"}')
        spec = {**self.spec, 'changes': [{'file': 'server.ts', 'before': 'const a = f(x, y);',
                                          'after': 'const a = f(x, y) ?? null;'}]}
        (self.root / 'server.ts').write_text('top\nconst a = f(\n  x,\n  y);\nend\n')
        changed = updater.forward_prepare(self.root, spec)
        self.assertEqual(changed['server.ts'], 'top\nconst a = f(x, y) ?? null;\nend\n')
        # Already customized, even if reformatted: nothing to do.
        (self.root / 'server.ts').write_text('const a = f(x,\n y) ?? null;\n')
        self.assertEqual(updater.forward_prepare(self.root, spec), {})

    def test_ambiguous_anchor_is_rejected(self):
        (self.root / 'server.ts').write_text('original\noriginal\n')
        with self.assertRaises(ValueError):
            updater.forward_prepare(self.root, self.spec)

    def test_disabled_plugin_is_not_modified_or_enabled(self):
        with patch.object(updater, 'inventory', return_value={**self.plugin, 'enabled': False}), patch.object(updater, 'run') as run:
            self.assertEqual(updater.sync()['state'], 'idle')
            run.assert_not_called()
        self.assertEqual((self.root / 'server.ts').read_text(), 'original\n')

    def test_interrupted_activation_is_recovered_from_the_journal(self):
        backup = self.state / 'saved'
        (backup / 'dist').mkdir(parents=True)
        (backup / 'server.ts').write_text('original\n')
        (backup / 'dist/server.js').write_text('original bundle')
        (self.root / 'server.ts').write_text('interrupted change\n')
        journal = self.state / 'pending-recovery.json'
        journal.write_text(json.dumps({'root': str(self.root), 'backup': str(backup), 'files': ['server.ts']}))
        with patch.object(updater, 'run') as run:
            updater.recover(self.plugin, self.spec)
            run.assert_called_once_with(['bb', 'plugin', 'reload', 'voice-mode'])
        self.assertFalse(journal.exists())
        self.assertEqual((self.root / 'server.ts').read_text(), 'original\n')

    def test_failed_activation_restores_original_source_and_bundle(self):
        attempts = 0

        def run(command, cwd=None):
            nonlocal attempts
            self.validate(command, cwd)
            if command[:3] == ['bb', 'plugin', 'reload']:
                attempts += 1
                if attempts == 1:
                    raise RuntimeError('activation failed')

        with patch.object(updater, 'inventory', return_value=self.plugin), patch.object(updater, 'run', side_effect=run):
            with self.assertRaises(RuntimeError):
                updater.sync()
        self.assertEqual(attempts, 2)
        self.assertEqual((self.root / 'server.ts').read_text(), 'original\n')
        self.assertEqual((self.root / 'dist/server.js').read_text(), 'original bundle')

    def test_concurrent_catalog_update_is_not_overwritten(self):
        moved = {**self.plugin, 'rootDir': str(self.base / 'another-release')}
        with patch.object(updater, 'inventory', side_effect=[self.plugin, moved]), patch.object(updater, 'run', side_effect=self.validate):
            with self.assertRaises(ValueError):
                updater.sync()
        self.assertEqual((self.root / 'server.ts').read_text(), 'original\n')


if __name__ == '__main__':
    unittest.main()
