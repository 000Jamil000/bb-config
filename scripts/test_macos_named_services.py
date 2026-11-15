import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('named_services', Path(__file__).with_name('macos_named_services.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NamedServices(unittest.TestCase):
    def test_only_known_service_families_are_selected(self):
        self.assertEqual(module.role_for('app.getbb.host-daemon.example'), 'bb')
        self.assertEqual(module.role_for('com.chatterminalhub.oneshot'), 'mcpgo-oneshot')
        self.assertEqual(module.role_for('com.mcphub.playwright.browser'), 'mcpgo-browser')
        self.assertIsNone(module.role_for('org.unrelated.node-app'))

    def test_all_service_configuration_is_preserved_except_identity(self):
        original = {'Label': 'app.getbb.host-daemon.example',
                    'ProgramArguments': ['/original/node', '/existing/entry.js', '--example', 'unchanged'],
                    'EnvironmentVariables': {'EXAMPLE_SETTING': 'unchanged'},
                    'KeepAlive': {'SuccessfulExit': False}, 'RunAtLoad': False,
                    'WorkingDirectory': '/existing/project'}
        unchanged = copy.deepcopy(original)
        updated = module.replacement(original, '/named/App.app/Contents/MacOS/Service', 'app.example.service')
        self.assertEqual(original, unchanged)
        self.assertEqual(updated['ProgramArguments'][1:], original['ProgramArguments'][1:])
        for key in ['EnvironmentVariables', 'KeepAlive', 'RunAtLoad', 'WorkingDirectory', 'Label']:
            self.assertEqual(updated[key], original[key])
        self.assertEqual(updated['AssociatedBundleIdentifiers'], ['app.example.service'])
        self.assertNotIn('Program', updated)

    def test_explicit_program_is_updated_consistently(self):
        updated = module.replacement({'Program': '/original/node', 'ProgramArguments': ['/original/node', '/entry.js']}, '/new/service', 'app.example')
        self.assertEqual(updated['Program'], updated['ProgramArguments'][0])


if __name__ == '__main__':
    unittest.main()
