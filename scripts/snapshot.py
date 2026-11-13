#!/usr/bin/env python3
"""Read BB settings using its CLI; never export secret settings or runtime state."""
import json, subprocess, shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def bb(*args):
    return json.loads(subprocess.check_output(['bb', *args, '--json'], text=True))
def save(name, data):
    p = ROOT / 'config' / (name + '.json')
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
s = bb('settings', 'show')
general = {k:v for k,v in s['generalSettings'].items() if k not in {'machineServerUrl','machineGitCredentialsEnabled','defaultMachineAccess','onboardingCompletedAt'}}
save('general', general)
save('experiments', s['experiments'])
save('appearance', {k:s['appearance'][k] for k in ['themeId','customCss','faviconColor']})
save('keyboard', s['keybindingOverrides'])
save('ui', {k:v['value'] for k,v in bb('settings','ui','list')['preferences'].items()})
save('thread-list', bb('thread-list','prefs','list'))
save('ai-services', bb('settings','ai-services')['selections'])
plugins = bb('plugin','list')['plugins']
manifest=[]
for p in plugins:
    row={k:p[k] for k in ['id','version','enabled']}
    source=p['source']
    if source.startswith('path:'):
        row['source']='path:plugins/'+p['id']
        src=Path(p['rootDir']); dst=ROOT/'plugins'/p['id']
        # Sync source files; never copy a git directory, dependencies, builds, or logs.
        if src.resolve() != dst.resolve():
            if dst.exists(): shutil.rmtree(dst)
            shutil.copytree(src,dst,ignore=shutil.ignore_patterns('node_modules','dist','.git','.DS_Store','.env','.env.*','*.log','.retry-audit-*','__pycache__'),symlinks=True)
    else: row['source']=source
    manifest.append(row)
    if p.get('hasSettings'):
        config=bb('plugin','config',p['id'])
        values={k:config['values'][k] for k,field in config['schema'].items() if not field.get('secret') and k in config['values']}
        save('plugins/'+p['id'],values)
save('plugins',manifest)
print('Snapshot updated. Review git diff before committing; credentials and runtime data are excluded.')
tabs=bb('plugin','rpc','call','machine-tabs','tabs_state')
save('machine-tabs', {k:tabs[k] for k in ['selectedId','byDay','outer']})
limits=bb('concurrency-limit','status')
save('concurrency', {k:limits[k] for k in ['globalLimit','hostOverrides']})
proxy=bb('proxy-manager','list')
save('proxy-routing', {'proxies':[{k:p[k] for k in ['id','name','protocol','host','port','authenticated'] if k in p} for p in proxy['proxies']], 'bindings':proxy['bindings']})
