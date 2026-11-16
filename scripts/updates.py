#!/usr/bin/env python3
"""Apply published bb-config releases step by step, with a local journal.

A release is a stable GitHub Release vX.Y.Z. Its steps are described by
docs/releases/vX.Y.Z.json (and .md for prose) inside the tagged commit.
Manifests are always read from the pinned commit, never from a branch head.
The journal (.local/updates/) is private to this installation: it records
which step was verified on which machine. A tag or a fresh checkout proves
nothing; only a passed verification marks a step as done.

Run on the BB server, in its bb-config checkout. Output is JSON.
Exit codes: 0 ok, 1 error, 2 steps remain, 3 a decision or evidence is needed.
Procedure: docs/updates.md.
"""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r'^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
STEP_ID = re.compile(r'^[a-z0-9][a-z0-9-]*$')
KINDS = {'local-plugin', 'command', 'manual'}
WHERE = {'server', 'executors'}
DONE = {'verified', 'not-applicable'}
SERVER = 'server'


class UpdateError(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


def version_key(tag):
    match = VERSION.match(tag or '')
    if not match:
        raise UpdateError(f'Not a stable release tag (vX.Y.Z): {tag!r}')
    return tuple(int(part) for part in match.groups())


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def git(root, *args, check=True):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise UpdateError(f'git {" ".join(args)}: {result.stderr.strip() or result.returncode}')
    return result.stdout.strip() if check else result


def bb(*args):
    command = [os.environ.get('BB_CLI') or 'bb', *args]
    try:
        return subprocess.run(command, capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, 'stderr', '') or str(error)
        raise UpdateError(f'bb {" ".join(args)} failed: {detail.strip()[-300:]}')


def installed_plugins():
    listing = json.loads(bb('plugin', 'list', '--json'))
    plugins = listing if isinstance(listing, list) else listing.get('plugins', [])
    return {plugin['id']: plugin for plugin in plugins}


# --- manifests ---------------------------------------------------------------

def manifest_errors(manifest, tag):
    """Structural problems of one release manifest; an empty list means valid."""
    errors = []
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1:
        return ['schemaVersion must be 1']
    if manifest.get('version') != tag:
        errors.append(f'version must equal the file name ({tag})')
    if not str(manifest.get('title') or '').strip():
        errors.append('title is required')
    steps = manifest.get('steps')
    if not isinstance(steps, list):
        return errors + ['steps must be a list']
    seen = set()
    for step in steps:
        name = step.get('id') if isinstance(step, dict) else None
        if not isinstance(name, str) or not STEP_ID.match(name):
            errors.append(f'step id must match {STEP_ID.pattern}: {name!r}')
            continue
        if name in seen:
            errors.append(f'duplicate step id: {name}')
        seen.add(name)
        for field in ('title', 'component', 'rerun', 'rollback'):
            if not str(step.get(field) or '').strip():
                errors.append(f'{name}: {field} is required')
        if step.get('where') not in WHERE:
            errors.append(f'{name}: where must be one of {sorted(WHERE)}')
        kind = step.get('kind')
        if kind not in KINDS:
            errors.append(f'{name}: kind must be one of {sorted(KINDS)}')
        if kind == 'local-plugin':
            plugin = step.get('plugin')
            if not isinstance(plugin, str) or not STEP_ID.match(plugin):
                errors.append(f'{name}: local-plugin needs "plugin" (directory under plugins/)')
            if step.get('where') != 'server':
                errors.append(f'{name}: plugins are installed on the BB server (where: server)')
        for field in ('apply', 'verify', 'applies'):
            argv = step.get(field)
            if argv is not None and not (isinstance(argv, list) and argv and all(isinstance(a, str) for a in argv)):
                errors.append(f'{name}: {field} must be a non-empty argv list')
        if kind == 'command' and not (step.get('apply') and step.get('verify')):
            errors.append(f'{name}: command steps need both apply and verify')
        if kind == 'manual' and step.get('apply'):
            errors.append(f'{name}: manual steps have no apply; describe them in the .md')
        for dependency in step.get('after', []):
            if not isinstance(dependency, str):
                errors.append(f'{name}: after entries are step ids')
    return errors


def load_manifests(root, commit=None):
    """{tag: manifest} from the pinned commit, or the working tree when commit is None."""
    manifests = {}
    if commit:
        names = git(root, 'ls-tree', '--name-only', commit, 'docs/releases/').splitlines()
        read = lambda name: git(root, 'show', f'{commit}:{name}')
    else:
        names = [f'docs/releases/{p.name}' for p in sorted((root / 'docs/releases').glob('*.json'))]
        read = lambda name: (root / name).read_text()
    for name in names:
        tag = Path(name).stem
        if not name.endswith('.json') or not VERSION.match(tag):
            continue
        try:
            manifest = json.loads(read(name))
        except ValueError as error:
            raise UpdateError(f'{name}: invalid JSON ({error})')
        errors = manifest_errors(manifest, tag)
        if errors:
            raise UpdateError(f'{name}: ' + '; '.join(errors))
        manifests[tag] = manifest
    ordered = dict(sorted(manifests.items(), key=lambda item: version_key(item[0])))
    known = {f'{tag}/{step["id"]}' for tag, m in ordered.items() for step in m['steps']}
    for tag, manifest in ordered.items():
        for step in manifest['steps']:
            for dependency in step.get('after', []):
                if full_id(tag, dependency) not in known:
                    raise UpdateError(f'{tag}/{step["id"]}: unknown dependency {dependency}')
    return ordered


def full_id(tag, step_id):
    return step_id if '/' in step_id else f'{tag}/{step_id}'


def validate(root, only=None):
    """Publishing check of the working tree: structure, prose, version bumps."""
    manifests = load_manifests(root)
    if only and only not in manifests:
        raise UpdateError(f'docs/releases/{only}.json is missing')
    problems = []
    tags = sorted(manifests, key=version_key)
    for index, tag in enumerate(tags):
        if only and tag != only:
            continue
        prose = root / f'docs/releases/{tag}.md'
        text = prose.read_text() if prose.is_file() else ''
        if not text:
            problems.append(f'{tag}: docs/releases/{tag}.md is missing')
        previous = tags[index - 1] if index else None
        for step in manifests[tag]['steps']:
            if text and f'`{step["id"]}`' not in text:
                problems.append(f'{tag}: the .md does not describe step `{step["id"]}`')
            if step['kind'] != 'local-plugin':
                continue
            directory = f'plugins/{step["plugin"]}'
            package = root / directory / 'package.json'
            if not package.is_file() or not (root / directory / 'package-lock.json').is_file():
                problems.append(f'{tag}/{step["id"]}: {directory} needs package.json and package-lock.json')
                continue
            # Verification compares versions, so a changed plugin must bump its version.
            if previous and git(root, 'rev-parse', '-q', '--verify', f'{previous}^{{commit}}', check=False).returncode == 0:
                old = git(root, 'show', f'{previous}:{directory}/package.json', check=False)
                changed = git(root, 'diff', '--quiet', previous, '--', directory, check=False).returncode != 0
                if old.returncode == 0 and changed and \
                        json.loads(old.stdout)['version'] == json.loads(package.read_text())['version']:
                    problems.append(f'{tag}/{step["id"]}: {directory} changed since {previous}; bump its version')
    return problems


# --- journal -----------------------------------------------------------------

def state_dir(root):
    return Path(os.environ.get('BB_CONFIG_UPDATES_DIR') or root / '.local/updates')


@contextlib.contextmanager
def journal(root, write=False):
    """The journal under a short file lock; saved atomically when write is set."""
    directory = state_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / 'journal.flock', 'w') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        path = directory / 'journal.json'
        data = json.loads(path.read_text()) if path.is_file() else {}
        data.setdefault('schemaVersion', 1)
        data.setdefault('installed', None)
        data.setdefault('partial', None)
        data.setdefault('run', None)
        data.setdefault('entries', [])
        yield data
        if write:
            temporary = directory / 'journal.json.tmp'
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n')
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)


def latest(data, step, machine, mode='release'):
    for entry in reversed(data['entries']):
        if entry['step'] == step and entry['machine'] == machine and entry['mode'] == mode:
            return entry
    return None


def add_entry(data, step, machine, status, how, detail, mode, commit):
    entry = {'step': step, 'machine': machine, 'status': status, 'how': how,
             'detail': (detail or '')[-600:], 'mode': mode, 'commit': commit, 'at': now()}
    data['entries'].append(entry)
    return entry


def installed_version(data):
    return (data.get('installed') or {}).get('release')


def targets(step, machines):
    return [SERVER] if step['where'] == 'server' else list(machines)


def pending(manifests, data, target, machines):
    """Steps of releases in (installed, target] that are not done, oldest first."""
    base = version_key(installed_version(data)) if installed_version(data) else (-1, -1, -1)
    rows = []
    for tag, manifest in manifests.items():
        if not base < version_key(tag) <= version_key(target):
            continue
        for step in manifest['steps']:
            for machine in targets(step, machines):
                entry = latest(data, f'{tag}/{step["id"]}', machine)
                if not entry or entry['status'] not in DONE:
                    rows.append({'step': f'{tag}/{step["id"]}', 'machine': machine,
                                 'status': entry['status'] if entry else 'pending',
                                 'detail': entry['detail'] if entry else ''})
    return rows


def find_step(manifests, step_id):
    tag, _, name = step_id.partition('/')
    for step in manifests.get(tag, {}).get('steps', []):
        if step['id'] == name:
            return tag, step
    raise UpdateError(f'Unknown step {step_id}; use the full id vX.Y.Z/<step>')


def require_run(data, owner, development):
    """Release-mode changes need the run lock taken by `begin` for this owner."""
    if development:
        return None
    run = data.get('run')
    if not run:
        raise UpdateError('No update run is open. Start with: updates.py begin <tag> --commit <sha>')
    if run['owner'] != owner:
        raise UpdateError(f'Another update run is open (owner {run["owner"]}, since {run["startedAt"]}). '
                          'Do not work in parallel; see docs/updates.md about stale runs.', 3)
    return run


# --- steps -------------------------------------------------------------------

def expand(argv, root):
    return [part.replace('{python}', sys.executable).replace('{root}', str(root)) for part in argv]


def execute(argv, root):
    result = subprocess.run(expand(argv, root), cwd=root, capture_output=True, text=True)
    return result.returncode, (result.stdout + result.stderr).strip()[-600:]


def plugin_state(step, root, plugins):
    """(ok, detail) — the running plugin is this checkout's build of this version."""
    directory = root / 'plugins' / step['plugin']
    wanted = json.loads((directory / 'package.json').read_text())['version']
    plugin = plugins.get(step['plugin'])
    if not plugin:
        return False, 'not installed'
    if Path(plugin.get('rootDir') or '').resolve() != directory.resolve():
        return False, f'installed from another source ({plugin.get("source")}), not from this checkout'
    if plugin.get('version') != wanted:
        return False, f'installed {plugin.get("version")}, release has {wanted}'
    if plugin.get('enabled') and plugin.get('status') != 'running':
        return False, f'status {plugin.get("status")}: {plugin.get("statusDetail")}'
    return True, f'{step["plugin"]} {wanted} from this checkout' + ('' if plugin.get('enabled') else ' (disabled by the user, kept)')


def run_step(root, step, install=False):
    """Verify first; apply only when needed; verify again. Returns (status, how, detail)."""
    if step['kind'] == 'local-plugin':
        plugins = installed_plugins()
        ok, detail = plugin_state(step, root, plugins)
        if ok:
            return 'verified', 'existing', detail
        directory = root / 'plugins' / step['plugin']
        present = step['plugin'] in plugins
        if not present and not step.get('introduces'):
            return 'not-applicable', 'not-selected', 'plugin is not installed here; the user did not choose it'
        if not present and not install:
            raise UpdateError(f'{step["plugin"]} is a new component. Ask the user; if they want it, rerun with --install. '
                              'Otherwise record not-applicable.', 3)
        if present and Path(plugins[step['plugin']].get('rootDir') or '').resolve() != directory.resolve():
            return 'failed', 'apply', detail
        for command in (['npm', '--prefix', str(directory), 'ci', '--include=dev'], ['bb', 'plugin', 'build', str(directory)],
                        ['bb', 'plugin', 'reload', step['plugin']] if present
                        else ['bb', 'plugin', 'install', f'path:{directory}', '--yes']):
            if command[0] == 'bb':
                command[0] = os.environ.get('BB_CLI') or 'bb'
            code, output = execute(command, root)
            if code != 0:
                return 'failed', 'apply', f'{" ".join(command[:3])}: {output}'
        ok, detail = plugin_state(step, root, installed_plugins())
        return ('verified', 'applied', detail) if ok else ('failed', 'verify', detail)
    if step.get('applies'):
        code, output = execute(step['applies'], root)
        if code != 0:
            return 'not-applicable', 'applies-check', output
    if not step.get('verify'):
        raise UpdateError('This step has no automatic check. Follow the release .md, then use `record` with evidence.', 3)
    code, output = execute(step['verify'], root)
    if code == 0:
        return 'verified', 'existing', output
    if step['kind'] == 'manual':
        raise UpdateError(f'Check failed: {output}. Follow the release .md, then run this step again.', 3)
    code, output = execute(step['apply'], root)
    if code != 0:
        return 'failed', 'apply', output
    code, output = execute(step['verify'], root)
    return ('verified', 'applied', output) if code == 0 else ('failed', 'verify', output)


# --- commands ----------------------------------------------------------------

def contains(root, commit):
    return git(root, 'merge-base', '--is-ancestor', commit, 'HEAD', check=False).returncode == 0


def command_fetch(args, root):
    """Bring the pinned release commit into the checkout without touching local work."""
    version_key(args.release)
    git(root, 'fetch', '--no-tags', 'origin', f'+refs/tags/{args.release}:refs/tags/{args.release}')
    actual = git(root, 'rev-parse', f'{args.release}^{{commit}}')
    if actual != args.commit:
        raise UpdateError(f'Tag {args.release} points at {actual}, expected {args.commit}. The tag was moved; stop.')
    if contains(root, args.commit):
        return {'result': 'already-contained', 'head': git(root, 'rev-parse', 'HEAD')}
    if git(root, 'status', '--porcelain', '--untracked-files=no'):
        raise UpdateError('The checkout has uncommitted changes. Keep them (commit or stash with the user), '
                          'never reset; then rerun.', 3)
    if git(root, 'merge-base', '--is-ancestor', 'HEAD', args.commit, check=False).returncode != 0:
        raise UpdateError('Local commits diverge from the release. Decide with the user how to merge; never reset.', 3)
    git(root, 'merge', '--ff-only', args.commit)
    return {'result': 'fast-forwarded', 'head': git(root, 'rev-parse', 'HEAD')}


def command_status(args, root):
    with journal(root) as data:
        return {'installed': data['installed'], 'partial': data['partial'], 'run': data['run'],
                'journal': str(state_dir(root) / 'journal.json')}


def command_baseline(args, root):
    version_key(args.release)
    with journal(root, write=True) as data:
        if data['run']:
            raise UpdateError('An update run is open; finish it first.')
        current = installed_version(data)
        if current and version_key(current) > version_key(args.release) and not args.force:
            raise UpdateError(f'Installed version {current} is newer; pass --force to lower the baseline.')
        data['installed'] = {'release': args.release, 'commit': args.commit, 'how': 'baseline',
                             'note': args.note, 'at': now()}
        data['partial'] = None
        return {'installed': data['installed']}


def command_begin(args, root):
    version_key(args.release)
    if not contains(root, args.commit):
        raise UpdateError('The checkout does not contain the pinned commit. Run `fetch` first.')
    manifests = load_manifests(root, args.commit)
    if args.release not in manifests:
        raise UpdateError(f'{args.release} has no docs/releases manifest in {args.commit[:12]}.')
    machines = [m for m in (args.machines or '').split(',') if m]
    with journal(root, write=True) as data:
        run = data['run']
        if run and run['owner'] != args.owner and not args.takeover:
            raise UpdateError(f'Another update run is open (owner {run["owner"]}, since {run["startedAt"]}). '
                              'Check that thread first; --takeover only when it is certainly stopped.', 3)
        # A machine that still owes steps stays in scope until it is done or
        # explicitly recorded as not-applicable; omitting it must not hide it.
        for row in (data['partial'] or {}).get('remaining', []):
            if row['machine'] != SERVER and row['machine'] not in machines:
                machines.append(row['machine'])
        resumed = bool(run and run['owner'] == args.owner and run['commit'] == args.commit)
        data['run'] = {'release': args.release, 'commit': args.commit, 'owner': args.owner,
                       'machines': machines, 'startedAt': run['startedAt'] if resumed else now()}
        return {'run': data['run'], 'resumed': resumed, 'installed': data['installed'],
                'pending': pending(manifests, data, args.release, machines),
                'steps': {f'{tag}/{s["id"]}': s for tag, m in manifests.items() for s in m['steps']
                          if any(row['step'] == f'{tag}/{s["id"]}' for row in pending(manifests, data, args.release, machines))}}


def dependencies_done(manifests, data, tag, step, machine, mode):
    base = version_key(installed_version(data)) if installed_version(data) else (-1, -1, -1)
    for dependency in step.get('after', []):
        name = full_id(tag, dependency)
        other_tag, other = find_step(manifests, name)
        if mode == 'release' and version_key(other_tag) <= base:
            continue
        entry = latest(data, name, SERVER if other['where'] == 'server' else machine, mode)
        if not entry or entry['status'] not in DONE:
            raise UpdateError(f'{name} must be done first.', 2)


def command_run(args, root):
    mode = 'development' if args.development else 'release'
    with journal(root) as data:
        run = require_run(data, args.owner, args.development)
    commit = run['commit'] if run else None
    if commit and not contains(root, commit):
        raise UpdateError('The checkout no longer contains the pinned commit. Run `fetch` again.')
    manifests = load_manifests(root, commit)
    tag, step = find_step(manifests, args.step)
    machine = args.machine or SERVER
    if (step['where'] == 'server') != (machine == SERVER):
        raise UpdateError(f'{args.step} runs on {step["where"]}; pass a matching --machine.')
    with journal(root) as data:
        dependencies_done(manifests, data, tag, step, machine, mode)
    try:
        status, how, detail = run_step(root, step, args.install)
    except UpdateError as error:
        if error.code != 3:
            with journal(root, write=True) as data:
                add_entry(data, args.step, machine, 'failed', 'error', str(error), mode, commit)
        raise
    with journal(root, write=True) as data:
        require_run(data, args.owner, args.development)
        entry = add_entry(data, args.step, machine, status, how, detail, mode, commit)
    if status == 'failed':
        raise UpdateError(json.dumps(entry, ensure_ascii=False))
    return entry


def command_record(args, root):
    mode = 'development' if args.development else 'release'
    if not args.evidence.strip():
        raise UpdateError('--evidence is required: what was checked and what it showed.')
    with journal(root, write=True) as data:
        run = require_run(data, args.owner, args.development)
        commit = run['commit'] if run else None
        manifests = load_manifests(root, commit)
        tag, step = find_step(manifests, args.step)
        if (step['where'] == 'server') != (args.machine == SERVER):
            raise UpdateError(f'{args.step} runs on {step["where"]}; pass a matching --machine.')
        automatic = step['kind'] == 'local-plugin' or bool(step.get('verify'))
        if args.status == 'verified' and args.machine == SERVER and automatic:
            raise UpdateError('This step has an automatic check on the server; use `run`, not `record`.')
        if args.status == 'verified':
            dependencies_done(manifests, data, tag, step, args.machine, mode)
        return add_entry(data, args.step, args.machine, args.status, 'evidence', args.evidence, mode, commit)


def command_finish(args, root):
    with journal(root, write=True) as data:
        run = require_run(data, args.owner, False)
        manifests = load_manifests(root, run['commit'])
        base = version_key(installed_version(data)) if installed_version(data) else (-1, -1, -1)
        done = None
        for tag in manifests:
            if not base < version_key(tag) <= version_key(run['release']):
                continue
            if pending(manifests, data, tag, run['machines']):
                break
            done = tag
        if done:
            data['installed'] = {'release': done, 'commit': run['commit'], 'how': 'release', 'at': now()}
        remaining = pending(manifests, data, run['release'], run['machines'])
        data['partial'] = {'release': run['release'], 'commit': run['commit'], 'remaining': remaining,
                           'at': now()} if remaining else None
        data['run'] = None
        result = {'installed': data['installed'], 'partial': data['partial']}
    if result['partial']:
        raise UpdateError(json.dumps(result, ensure_ascii=False), 2)
    return result


def command_validate(args, root):
    problems = validate(root, args.release)
    if problems:
        raise UpdateError('\n'.join(problems))
    return {'valid': sorted(load_manifests(root), key=version_key)}


def command_require_plugin(args, root):
    """Helper for verify/applies argv: exit 0 when the plugin is installed (and new enough)."""
    plugin = installed_plugins().get(args.plugin)
    if not plugin:
        raise UpdateError(f'{args.plugin} is not installed')
    if args.min and tuple(map(int, re.findall(r'\d+', plugin['version'])[:3])) < version_key('v' + args.min):
        raise UpdateError(f'{args.plugin} {plugin["version"]} is older than {args.min}')
    return {'plugin': args.plugin, 'version': plugin['version'], 'enabled': plugin['enabled']}


def main(argv=None, root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    owner = os.environ.get('BB_THREAD_ID') or f'pid-{os.getppid()}'

    def add(name, function, release=False, commit=False, run=False):
        command = sub.add_parser(name, help=(function.__doc__ or '').strip().split('\n')[0])
        command.set_defaults(function=function)
        if release:
            command.add_argument('release', help='release tag vX.Y.Z')
        if commit:
            command.add_argument('--commit', required=True, help='pinned 40-character commit of the release')
        if run:
            command.add_argument('--owner', default=owner, help='run owner (default: $BB_THREAD_ID)')
        return command

    add('status', command_status)
    add('fetch', command_fetch, release=True, commit=True)
    command = add('baseline', command_baseline, release=True, commit=True)
    command.add_argument('--note', default='')
    command.add_argument('--force', action='store_true')
    command = add('begin', command_begin, release=True, commit=True, run=True)
    command.add_argument('--machines', help='comma-separated BB machine ids for executor steps')
    command.add_argument('--takeover', action='store_true', help='replace a certainly stopped run')
    command = add('run', command_run, run=True)
    command.add_argument('step', help='vX.Y.Z/<step id>')
    command.add_argument('--machine', help='BB machine id for an executor step run on this machine')
    command.add_argument('--install', action='store_true', help='the user agreed to install a new component')
    command.add_argument('--development', action='store_true', help='author check before publishing; no run lock')
    command = add('record', command_record, run=True)
    command.add_argument('step')
    command.add_argument('--machine', required=True, help=f'"{SERVER}" or a BB machine id')
    command.add_argument('--status', required=True, choices=['verified', 'not-applicable', 'failed'])
    command.add_argument('--evidence', required=True)
    command.add_argument('--development', action='store_true')
    add('finish', command_finish, run=True)
    command = add('validate', command_validate)
    command.add_argument('release', nargs='?')
    command = add('require-plugin', command_require_plugin)
    command.add_argument('plugin')
    command.add_argument('--min')
    args = parser.parse_args(argv)
    if getattr(args, 'commit', None) and not re.fullmatch(r'[0-9a-f]{40}', args.commit):
        parser.error('--commit must be a full 40-character SHA')
    try:
        print(json.dumps(args.function(args, root), ensure_ascii=False, indent=1))
        return 0
    except UpdateError as error:
        print(str(error), file=sys.stderr)
        return error.code


if __name__ == '__main__':
    sys.exit(main())
