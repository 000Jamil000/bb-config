"""Apply or verify the workspace tab overlay on the catalog installation."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins/voice-mode-keeper'))
import patch_keeper as keeper


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    spec = keeper.KEPT['kodaforge']
    plugin = keeper.plugins().get('kodaforge')
    if not plugin or not plugin.get('enabled') or not plugin['source'].startswith(spec['source']):
        print('KodaForge catalog plugin is not enabled; skipped.')
        return 0
    if args.apply:
        import subprocess
        subprocess.run([sys.executable, keeper.__file__, 'kodaforge'], check=True)
        plugin = keeper.plugins()['kodaforge']
    root = Path(plugin['rootDir'])
    text = {name: (root / name).read_text() for name in spec['files']}
    if keeper.pending_patches(root, spec, text) or plugin.get('status') != 'running':
        print('Workspace tab fixes are missing or the plugin is not running.')
        return 1
    print('KodaForge workspace tab fixes are active.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
