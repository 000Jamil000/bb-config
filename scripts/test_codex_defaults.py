import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('codex_defaults', Path(__file__).with_name('codex_defaults.py'))
defaults = importlib.util.module_from_spec(spec)
spec.loader.exec_module(defaults)


class CodexDefaultsTests(unittest.TestCase):
    def test_preserves_nested_overrides_and_other_settings(self):
        original = '[profiles.custom]\nproject_doc_max_bytes = 123\n[mcp_servers.private]\ncommand = "preserve"\n'
        updated, old = defaults.update_text(original, 65536)
        self.assertIsNone(old)
        self.assertEqual(updated, 'project_doc_max_bytes = 65536\n' + original)

    def test_preserves_larger_budget_and_comment(self):
        original = 'project_doc_max_bytes = 131_072 # chosen\n'
        self.assertEqual(defaults.update_text(original, 65536), (original, 131072))
        self.assertEqual(defaults.update_text('project_doc_max_bytes = 32768 # chosen\n', 65536)[0],
                         'project_doc_max_bytes = 65536 # chosen\n')

    def test_refuses_ambiguous_input(self):
        for original in ['project_doc_max_bytes = "32768"\n',
                         'project_doc_max_bytes = 1\nproject_doc_max_bytes = 2\n']:
            with self.subTest(original=original), self.assertRaises(ValueError):
                defaults.update_text(original, 65536)

    def test_atomic_write_keeps_mode_and_second_run_has_no_change(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.toml'
            path.write_text('[features]\nenabled = true\n')
            path.chmod(0o640)
            updated, _ = defaults.update_text(path.read_text(), 65536)
            defaults.apply(path, updated)
            if os.name != 'nt':  # NTFS has no POSIX mode bits
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
            self.assertEqual(path.read_text(), updated)
            self.assertEqual(defaults.update_text(updated, 65536)[0], updated)

    def test_multiline_string_is_not_an_assignment(self):
        text = "description = \"\"\"\nproject_doc_max_bytes = 1\n\"\"\"\nproject_doc_max_bytes = 32768\n"
        updated, _ = defaults.update_text(text, 65536)
        self.assertIn('project_doc_max_bytes = 1', updated)
        self.assertTrue(updated.endswith('project_doc_max_bytes = 65536\n'))

    def test_invalid_toml_is_never_written(self):
        with self.assertRaises(ValueError):
            defaults.update_text('broken = [', 65536)


if __name__ == '__main__':
    unittest.main()
