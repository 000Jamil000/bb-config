#!/usr/bin/env python3
"""Update scenarios for patch_keeper: moved code, nearby edits, shipped fixes, misfits."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import patch_keeper as keeper  # noqa: E402

ORIGINAL = ''.join(f'const line{i} = {i};\n' for i in range(1, 40)).replace(
    'const line20 = 20;\n', 'const size = sizeOf(\n  samples,\n);\n')
PATCH = '''--- a/server.ts
+++ b/server.ts
@@ -19,7 +19,7 @@
 const line19 = 19;
 const size = sizeOf(
   samples,
-);
+) ?? null;
 const line21 = 21;
 const line22 = 22;
 const line23 = 23;
'''


class Fixture:
    def __init__(self, source):
        self.dir = Path(tempfile.mkdtemp())
        self.root = self.dir / 'installed'
        self.root.mkdir()
        (self.root / 'server.ts').write_text(source)
        (self.root / 'dist').mkdir()
        (self.root / 'dist/server.js').write_text('old bundle')
        (self.dir / 'fix.patch').write_text(PATCH)
        self.status = 'running'
        self.reloads = 0

    def spec(self):
        return {'name': 'Demo', 'source': 'git:demo@', 'patches': [str(self.dir / 'fix.patch')],
                'files': ['server.ts'],
                'shipped': lambda text: 'sizeOf(\n  samples,\n) ?? null' in text['server.ts']}

    def installed(self):
        return {'demo': {'id': 'demo', 'enabled': True, 'version': '9.9.9', 'source': 'git:demo@x',
                         'rootDir': str(self.root), 'status': self.status}}

    def run(self, command, cwd=None, data=None):
        if command[0] in ('patch', 'git'):
            result = keeper.subprocess.run(keeper.compat.argv(command), cwd=cwd, input=data.encode(), capture_output=True)
            if result.returncode:
                raise RuntimeError('patch did not fit')
            return result.stdout
        if command[:3] == ['bb', 'plugin', 'build']:
            stage = Path(command[3])
            (stage / 'dist').mkdir(exist_ok=True)
            (stage / 'dist/server.js').write_text('bundle of ' + (stage / 'server.ts').read_text())
            return ''
        if command[:3] == ['bb', 'plugin', 'reload']:
            self.reloads += 1
            return ''
        raise AssertionError(command)


class PatchKeeperTest(unittest.TestCase):
    def go(self, fixture):
        with mock.patch.object(keeper, 'REPO', Path('/')), \
             mock.patch.object(keeper, 'STATE_DIR', fixture.dir / 'state'), \
             mock.patch.object(keeper, 'plugins', fixture.installed), \
             mock.patch.object(keeper, 'run', fixture.run):
            (fixture.dir / 'state').mkdir(exist_ok=True)
            return keeper.keep('demo', fixture.spec(), fixture.installed())

    def test_update_with_moved_code_and_nearby_edit_is_repaired(self):
        moved = ('// new header\n' * 7) + ORIGINAL.replace('const line19 = 19;', 'const line19 = 19; // tweaked')
        fixture = Fixture(moved)
        result = self.go(fixture)
        self.assertEqual(result['state'], 'ready')
        self.assertIn('восстановлено', result['message'])
        self.assertIn(') ?? null;', (fixture.root / 'server.ts').read_text())
        self.assertIn('?? null', (fixture.root / 'dist/server.js').read_text())
        self.assertEqual(fixture.reloads, 1)
        # A second run finds it in place and does nothing.
        self.assertIn('на месте', self.go(fixture)['message'])
        self.assertEqual(fixture.reloads, 1)

    def test_new_overlay_uses_existing_base_and_ignores_old_receipt(self):
        fixture = Fixture(ORIGINAL)
        self.go(fixture)
        base_spec = fixture.spec()
        overlay = fixture.dir / 'second.patch'
        overlay.write_text(PATCH.replace('-);', '-) ?? null;')
                           .replace('+) ?? null;', '+) ?? 0;'))
        spec = {**base_spec, 'overlays': [str(overlay)]}
        fixture.spec = lambda: spec
        self.assertEqual(self.go(fixture)['state'], 'ready')
        self.assertEqual(fixture.reloads, 2)
        self.assertIn(') ?? 0;', (fixture.root / 'server.ts').read_text())
        (fixture.dir / 'state/demo-receipt.json').unlink()
        self.assertEqual(self.go(fixture)['state'], 'ready')
        self.assertEqual(fixture.reloads, 2)

    def test_second_overlay_upgrades_an_installation_with_the_first(self):
        fixture = Fixture(ORIGINAL)
        base_spec = fixture.spec()
        first = fixture.dir / 'first-overlay.patch'
        first.write_text(PATCH.replace('-);', '-) ?? null;')
                         .replace('+) ?? null;', '+) ?? 0;'))
        second = fixture.dir / 'second-overlay.patch'
        second.write_text(PATCH.replace('-);', '-) ?? 0;')
                          .replace('+) ?? null;', '+) ?? 1;'))
        fixture.spec = lambda: {**base_spec, 'overlays': [str(first)]}
        self.assertEqual(self.go(fixture)['state'], 'ready')

        fixture.spec = lambda: {**base_spec, 'overlays': [str(first), str(second)]}
        self.assertEqual(self.go(fixture)['state'], 'ready')
        self.assertIn(') ?? 1;', (fixture.root / 'server.ts').read_text())
        (fixture.dir / 'state/demo-receipt.json').unlink()
        self.assertEqual(self.go(fixture)['state'], 'ready')
        self.assertEqual(fixture.reloads, 2)

    def test_fix_shipped_by_the_author_needs_no_patch(self):
        shipped = ORIGINAL.replace('  samples,\n);', '  samples,\n) ?? null; // upstream')
        fixture = Fixture(shipped.replace('const line19 = 19;', 'const line19 = 190;'))
        result = self.go(fixture)
        self.assertEqual(result['state'], 'ready')
        self.assertIn('у автора', result['message'])
        self.assertEqual(fixture.reloads, 0)

    def test_misfit_leaves_the_release_untouched(self):
        rewritten = ORIGINAL.replace('const size = sizeOf(\n  samples,\n);\n', 'const size = measure(all);\n')
        fixture = Fixture(rewritten)
        with self.assertRaises(RuntimeError):
            self.go(fixture)
        self.assertEqual((fixture.root / 'server.ts').read_text(), rewritten)
        self.assertEqual((fixture.root / 'dist/server.js').read_text(), 'old bundle')
        self.assertEqual(fixture.reloads, 0)

    def test_failed_start_restores_the_original(self):
        fixture = Fixture(ORIGINAL)
        fixture.status = 'error'
        with self.assertRaises(RuntimeError):
            self.go(fixture)
        self.assertEqual((fixture.root / 'server.ts').read_text(), ORIGINAL)
        self.assertEqual((fixture.root / 'dist/server.js').read_text(), 'old bundle')
        self.assertEqual(fixture.reloads, 2)  # with the fix, then back


if __name__ == '__main__':
    unittest.main()
