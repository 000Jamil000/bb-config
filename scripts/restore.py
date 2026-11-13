#!/usr/bin/env python3
"""Print a restore plan; --apply runs supported preference commands. No proxy/account changes."""
import json, subprocess, shlex, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def read(name): return json.loads((ROOT/'config'/f'{name}.json').read_text())
def value(v): return v if isinstance(v,str) else json.dumps(v,separators=(',',':'))
def run(*args):
    cmd=['bb',*map(str,args)]
    print(shlex.join(cmd))
    if '--apply' in sys.argv: subprocess.run(cmd,check=True)
# Sources remain installed in their original locations until the user deliberately
# installs the repository copies. Existing settings are not deleted.
for k,v in read('general').items():
    if k=='providerCompletedTurnDisplay':
        for provider,mode in v.items(): run('settings','completed-turns',provider,mode)
    else: run('settings','general',k,value(v))
for k,v in read('experiments').items(): run('settings','experiment',k,value(v))
for p in sorted((ROOT/'config/plugins').glob('*.json')):
    # Connect controls remote access; restore it separately to avoid disconnecting.
    if p.stem in {'connect','proxy-manager','provider-acp'}: continue
    for k,v in json.loads(p.read_text()).items(): run('plugin','config',p.stem,'set',k,value(v))
for k,v in read('ui').items(): run('settings','ui','set',k,value(v))
for k,v in read('thread-list').items(): run('thread-list','prefs','set',k,value(v))
for task,selection in read('ai-services').items():
    mode=selection['mode']
    if mode in {'automatic','off'}: run('settings','ai-services','set',task,mode)
# Complex keyboard structures, theme CSS, host-specific limits and tab state
# are preserved in JSON for explicit restoration using the BB settings UI/RPC.
