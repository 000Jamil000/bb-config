import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import snapshot
import restore
from plugin_scope import externally_managed

class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "config/plugins").mkdir(parents=True)
        self.write("externally-managed-plugins", ["telegram-projects"])
    def write(self, name, value):
        (self.root / "config" / (name + ".json")).write_text(json.dumps(value))
    def test_restore_ignores_stale_manifest_and_settings(self):
        self.write("plugins", [{"id": "telegram-projects", "source": "git:https://example.test/fork", "enabled": True}, {"id": "other", "source": "builtin:other", "enabled": True}])
        self.write("plugins/telegram-projects", {"owner": "private-value"})
        self.write("appearance", {"customCss": ""})
        for install in (False, True):
            commands = restore.plan(install, root=self.root, installed=set())
            self.assertFalse(any("telegram-projects" in cmd or "private-value" in cmd for cmd in commands))
            if install:
                self.assertIn(["bb", "plugin", "enable", "other"], commands)
    def test_snapshot_never_reads_excluded_plugin_settings(self):
        responses = {("plugin", "list"): {"plugins": [{"id": "telegram-projects", "enabled": True, "hasSettings": True}]}, ("settings", "show"): {"generalSettings": {}, "experiments": {}, "appearance": {"themeId": "default", "customCss": None, "faviconColor": None}, "keybindingOverrides": {}}, ("settings", "ui", "list"): {"preferences": {}}, ("settings", "ai-services"): {"selections": {}}}
        with patch.object(snapshot, "ROOT", self.root), patch.object(snapshot, "bb", side_effect=lambda *args: responses[args]):
            values, plugins = snapshot.collect()
        self.assertEqual(plugins, [])
        self.assertEqual(values["plugins"], [])
        self.assertNotIn("plugins/telegram-projects", values)
    def test_missing_policy_preserves_default_scope(self):
        (self.root / "config/externally-managed-plugins.json").unlink()
        self.assertEqual(externally_managed(self.root), set())
    def test_invalid_policy_fails_closed(self):
        self.write("externally-managed-plugins", "telegram-projects")
        with self.assertRaises(ValueError): externally_managed(self.root)

if __name__ == "__main__": unittest.main()
