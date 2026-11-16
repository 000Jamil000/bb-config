#!/usr/bin/env python3
"""Export through the BB CLI; deliver verified daily snapshots to an enrolled Mac."""
import argparse
import base64
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import shutil
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import uuid
from zoneinfo import ZoneInfo

# Node's built-in fetch supplies its own five-minute headers timeout. Override
# that per request in this CLI child only; BB itself and its routing are untouched.
EXPORT_HTTP_PRELOAD = """
const { Agent, setGlobalDispatcher } = require(process.env.BB_EXPORT_UNDICI);
const agent = new Agent();
const dispatch = agent.dispatch.bind(agent);
agent.dispatch = (options, handler) => dispatch({
  ...options, headersTimeout: Number(process.env.BB_EXPORT_HEADERS_TIMEOUT_MS)
}, handler);
setGlobalDispatcher(agent);
"""

def backup_day(now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    return (now.astimezone(ZoneInfo('Europe/Moscow')) - dt.timedelta(hours=5)).date().isoformat()

def export_due(state, day, interval_days):
    try:
        elapsed = (dt.date.fromisoformat(day) - dt.date.fromisoformat(state['day'])).days
        return elapsed < 0 or elapsed >= interval_days
    except (KeyError, ValueError):
        return True


def digest(path):
    with Path(path).open('rb') as stream:
        result = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def validate_archive(path):
    """Check every manifest member without extracting or opening any database."""
    # Streaming avoids repeated gzip seeks and quadratic name lookup in large
    # archives. The official BB writer places the manifest first.
    with tarfile.open(path, 'r|gz') as archive:
        members = iter(archive)
        first = next(members, None)
        if first is None or first.name != 'manifest.json' or not first.isfile():
            raise ValueError('BB archive must start with its manifest')
        manifest = json.load(archive.extractfile(first))
        if manifest.get('format') != 'bb-server-archive' or manifest.get('version') != 2:
            raise ValueError('Unsupported BB archive format')
        expected = {}
        for entry in manifest['entries']:
            name = entry['path']
            if name.startswith('/') or '..' in Path(name).parts or name in expected:
                raise ValueError('Unsafe archive member')
            expected[name] = entry
        seen = set()
        for member in members:
            if not member.isfile() or not member.name.startswith('files/'):
                raise ValueError('Unexpected BB archive member')
            name = member.name[len('files/'):]
            if name not in expected or name in seen:
                raise ValueError('Unexpected or duplicate BB archive member')
            entry = expected[name]
            stream = archive.extractfile(member)
            result = hashlib.sha256()
            size = 0
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                result.update(chunk)
                size += len(chunk)
            if size != entry['size'] or result.hexdigest() != entry['sha256']:
                raise ValueError('Archive member checksum mismatch')
            seen.add(name)
        if seen != expected.keys():
            raise ValueError('BB archive is missing manifest members')
        return manifest


def rotate(directory, keep=3):
    snapshots = sorted(Path(directory).glob('bb-server-*.tar.gz.age'), reverse=True)
    for old in snapshots[keep:]:
        old.unlink()
        old.with_suffix(old.suffix + '.json').unlink(missing_ok=True)


def save_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    os.replace(temporary, path)


def read_json(path):
    return json.loads(path.read_text()) if path.exists() else {}


def report_backup_alert(source, kind, cli, now=None):
    """Publish a durable, deduplicated Needs You activity; never include secrets."""
    source = Path(source)
    source.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = source / 'notification-state.json'
    state = read_json(path)
    if kind == 'healthy' and not state:
        return
    if state.get('kind') != kind:
        timestamp = max(int((time.time() if now is None else now) * 1000),
                        state.get('event', {}).get('occurredAt', 0) + 1)
        titles = {'backup-error': 'Не удалось создать бэкап BB',
                  'delivery-stale': 'Бэкап BB давно не доставлен на Mac',
                  'healthy': 'Бэкапы BB снова работают'}
        bodies = {'backup-error': 'Экспорт или шифрование завершились ошибкой. Открой историю автоматизации; повторная попытка будет выполнена по расписанию.',
                  'delivery-stale': 'Более 24 часов нет успешной доставки на Mac. Зашифрованная копия остаётся на сервере; доставка повторяется каждые 30 минут.',
                  'healthy': 'Зашифрованный бэкап доставлен на Mac и проверен. Предыдущий сбой устранён.'}
        project = os.environ.get('BB_PROJECT_ID', '')
        automation = os.environ.get('BB_AUTOMATION_ID', 'manual-backup')
        event = {'sourceId': 'automations', 'sourceName': 'Бэкапы BB',
                 'entityId': 'bb-server-backup:' + automation,
                 'eventId': uuid.uuid4().hex, 'occurredAt': timestamp,
                 'projectId': project, 'title': titles[kind], 'body': bodies[kind],
                 'status': 'ready' if kind == 'healthy' else 'error',
                 'target': {'panel': 'automations', 'segments': [project, automation]}}
        state = {'kind': kind, 'event': event, 'pending': True}
        save_json(path, state)
    if not state.get('pending'):
        return
    try:
        capability = cli.call('plugin', 'rpc', 'call', 'inbox', 'activityCapabilities', '--json', timeout=15)
        if capability.get('version') != 1:
            return
        payload = source / 'notification-payload.json'
        save_json(payload, state['event'])
        result = cli.call('plugin', 'rpc', 'call', 'inbox', 'publishActivity',
                          '--input-file', str(payload), '--json', timeout=15)
        if result.get('accepted'):
            state['pending'] = False
            save_json(path, state)
            print('Backup status notification saved in Needs You.')
    except Exception:
        # The next tick retries the same event ID/time. Notification failures
        # must never turn a good backup into a failed one.
        print('Backup notification pending; will retry on a later tick.')


def delivery_succeeded(source, archive, cli, now=None):
    path = source / 'delivery-state.json'
    state = read_json(path)
    if state.get('archive') != archive.name:
        save_json(path, {'archive': archive.name,
                         'lastSuccessfulDeliveryAt': time.time() if now is None else now})
    report_backup_alert(source, 'healthy', cli, now)


def delivery_pending(source, cli, now=None):
    now = time.time() if now is None else now
    path = source / 'delivery-state.json'
    state = read_json(path)
    if 'firstPendingAt' not in state:
        state['firstPendingAt'] = now
        save_json(path, state)
    since = state.get('lastSuccessfulDeliveryAt', state['firstPendingAt'])
    if now - since >= 24 * 3600:
        report_backup_alert(source, 'delivery-stale', cli, now)


def encrypt_archive(plaintext, ciphertext, recipient):
    executable = shutil.which('age')
    if not executable:
        raise RuntimeError('Install age on the server before enabling encrypted backups')
    temporary = ciphertext.with_name(ciphertext.name + '.partial')
    try:
        subprocess.run([executable, '--encrypt', '--recipient', recipient,
                        '--output', str(temporary), str(plaintext)],
                       capture_output=True, check=True, timeout=300)
        temporary.chmod(0o600)
        with temporary.open('rb') as stream:
            if stream.read(22) != b'age-encryption.org/v1\n':
                raise ValueError('age did not produce an encrypted archive')
        os.replace(temporary, ciphertext)
    finally:
        temporary.unlink(missing_ok=True)


class Cli:
    def __init__(self):
        requested = os.environ.get('BB_CLI') or 'bb'
        configured = Path(shutil.which(requested) or requested).resolve()
        if configured.is_file():
            with configured.open('rb') as stream:
                header = stream.read(2048).decode('utf8', errors='replace')
            entry = re.search(r"^entry='([^']+)'$", header, re.MULTILINE)
            if header.startswith('#!/bin/sh') and '# Written by bb:' in header and entry:
                configured = Path(entry.group(1))
        # Desktop automations may inject dist/bb.js, an Electron launcher.
        # Use the bundled native Node CLI, and keep its re-exec target identical.
        native = configured.parent.parent / 'host-daemon/dist/bb'
        self.path = str(native if native.is_file() else configured)

    def call(self, *args, stdin=None, timeout=120):
        env = {**os.environ, 'BB_CLI': self.path}
        with tempfile.TemporaryDirectory(prefix='bb-export-http-') as directory:
            if args[:2] == ('server', 'export'):
                candidates = [parent / 'npm/node_modules/undici' for parent in Path(self.path).parents]
                undici = next((p for p in candidates if (p / 'package.json').is_file()), None)
                if undici is None:
                    raise RuntimeError('BB bundled HTTP client not found; export was not started')
                preload = Path(directory) / 'export.cjs'
                preload.write_text(EXPORT_HTTP_PRELOAD)
                env.update(BB_EXPORT_UNDICI=str(undici),
                           BB_EXPORT_HEADERS_TIMEOUT_MS=str(timeout * 1000),
                           NODE_OPTIONS=env.get('NODE_OPTIONS', '') + ' --require=' + json.dumps(str(preload)))
            completed = subprocess.run([self.path, *args], input=stdin, text=True,
                                       capture_output=True, timeout=timeout, env=env)
        if completed.returncode:
            # Never echo terminal contents, file bodies, or inherited credentials.
            detail = ''
            if args[:2] == ('server', 'export'):
                try:
                    detail = ': ' + json.loads(completed.stdout).get('error', {}).get('message', '')[:500]
                except (ValueError, AttributeError):
                    detail = ': ' + completed.stderr.splitlines()[0][:300] if completed.stderr else ''
            raise RuntimeError('BB command failed: ' + ' '.join(args[:2]) + detail)
        return json.loads(completed.stdout)

    def remote_python(self, host, code, *args):
        terminal = self.call('terminal', 'create', '--machine', host,
                             '--title', 'BB backup maintenance', '--json', '--',
                             'python3', '-c', code, *args)
        terminal_id = terminal['id']
        try:
            for _ in range(120):
                output = self.call('terminal', 'output', terminal_id,
                                   '--tail-bytes', '8192', '--json')
                if output['status'] == 'exited':
                    if output.get('exitCode') != 0:
                        raise RuntimeError('Backup verification on destination failed')
                    return
                time.sleep(0.25)
            raise TimeoutError('Backup maintenance timed out')
        finally:
            self.call('terminal', 'close', terminal_id, '--json')


# This is executed by the destination's normal BB terminal API. It receives no
# credentials, only a private incoming directory and the expected ciphertext digest.
FINALIZE = r'''
import sys,pathlib,hashlib,base64,os,json,tarfile,shutil
incoming=pathlib.Path(sys.argv[1]); destination=pathlib.Path(sys.argv[2])
expected=sys.argv[3]; keep=int(sys.argv[4]); temp=incoming/'archive.partial'
with temp.open('wb') as out:
 for part in sorted(incoming.glob('part-*')): out.write(base64.b64decode(part.read_bytes(),validate=True))
temp.chmod(0o600)
h=hashlib.sha256()
with temp.open('rb') as stream:
 for chunk in iter(lambda:stream.read(1048576),b''):h.update(chunk)
assert h.hexdigest()==expected,'Archive delivery digest mismatch'
encrypted=destination.name.endswith('.age')
if encrypted:
 with temp.open('rb') as stream: assert stream.read(22)==b'age-encryption.org/v1\n','Not an age archive'
else:
 # Legacy-format validation remains for the migration/retention tests.
 with tarfile.open(temp,'r:gz') as archive:
  m=json.load(archive.extractfile('manifest.json'))
  assert m['format']=='bb-server-archive' and m['version']==2
  for e in m['entries']:
   assert not e['path'].startswith('/') and '..' not in pathlib.Path(e['path']).parts
   stream=archive.extractfile('files/'+e['path']); h=hashlib.sha256(); size=0
   for chunk in iter(lambda:stream.read(1048576),b''):h.update(chunk);size+=len(chunk)
   assert size==e['size'] and h.hexdigest()==e['sha256'],'Member checksum mismatch'
os.replace(temp,destination)
receipt=destination.with_suffix(destination.suffix+'.json')
receipt.write_text(json.dumps({'sha256':expected,'sizeBytes':destination.stat().st_size,'encrypted':encrypted}))
receipt.chmod(0o600)
# Delete old complete copies only after the newly delivered copy is verified.
prefix='private-config-' if destination.name.startswith('private-config-') else 'bb-server-'
pattern=prefix+('*.tar.gz.age' if encrypted else '*.tar.gz')
for old in sorted(destination.parent.glob(pattern),reverse=True)[keep:]:
 old.unlink();old.with_suffix(old.suffix+'.json').unlink(missing_ok=True)
shutil.rmtree(incoming)
'''


def deliver(cli, archive, host, destination, keep):
    destination = Path(destination)
    incoming = destination / ('.incoming-' + uuid.uuid4().hex)
    prepare = ('import pathlib,sys,shutil; p=pathlib.Path(sys.argv[1]); '
               'p.mkdir(parents=True,exist_ok=True,mode=0o700); p.chmod(0o700); '
               '[(shutil.rmtree(x)) for x in p.glob(".incoming-*") if x.is_dir()]; '
               'pathlib.Path(sys.argv[2]).mkdir(mode=0o700)')
    cli.remote_python(host, prepare, str(destination), str(incoming))
    with archive.open('rb') as stream:
        index = 0
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            cli.call('file', 'write', str(incoming / ('part-%08d' % index)),
                     '--host', host, '--stdin', '--json',
                     stdin=base64.b64encode(chunk).decode('ascii'))
            index += 1
    cli.remote_python(host, FINALIZE, str(incoming), str(destination / archive.name),
                      digest(archive), str(keep))


def tick(args):
    os.umask(0o077)
    source = Path(args.source_dir).expanduser()
    source.mkdir(parents=True, exist_ok=True, mode=0o700)
    source.chmod(0o700)
    if not args.recipient:
        raise RuntimeError('A public age recipient is required; plaintext backups are disabled')
    cli = Cli()
    # Advisory locking also covers manual invocations outside the automation.
    with (source / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        now = dt.datetime.now(dt.timezone.utc)
        day = backup_day(now)
        state_file = source / 'state.json'
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
        archive = source / state.get('archive', 'missing')
        if (export_due(state, day, getattr(args, 'interval_days', 7)) or not archive.is_file() or args.force
                or state.get('recipient') != args.recipient or not archive.name.endswith('.age')):
            archive = source / ('bb-server-' + now.strftime('%Y%m%dT%H%M%S%fZ') + '.tar.gz.age')
            plaintext = source / ('.export-' + uuid.uuid4().hex + '.tar.gz')
            try:
                cli.call('server', 'export', '--out', str(plaintext), '--json', timeout=780)
                validate_archive(plaintext)
                encrypt_archive(plaintext, archive, args.recipient)
            finally:
                plaintext.unlink(missing_ok=True)
            state = {'day': day, 'archive': archive.name, 'sha256': digest(archive),
                     'delivered': False, 'recipient': args.recipient}
            temp = source / 'state.json.tmp'
            temp.write_text(json.dumps(state))
            os.replace(temp, state_file)
            rotate(source, args.keep)
            print('Created and encrypted verified BB server backup (' + str(archive.stat().st_size) + ' bytes).')
            if getattr(args, 'defer_delivery', False):
                print('Encrypted full backup saved; delivery will run on the next tick.')
                return
        if state.get('delivered'):
            delivery_succeeded(source, archive, cli)
            return
        if digest(archive) != state['sha256']:
            raise ValueError('Encrypted BB backup checksum changed before delivery')
        try:
            machine = cli.call('machine', 'show', args.destination_host, '--json')
            if machine.get('status') != 'connected':
                print('Backup retained on server; waiting for Mac to reconnect.')
                delivery_pending(source, cli)
                return
            deliver(cli, archive, args.destination_host, args.destination_dir, args.keep)
        except Exception as error:
            # Offline Macs and interrupted deliveries must not pause the daily job.
            print('Delivery pending; next tick will retry. ' + type(error).__name__)
            delivery_pending(source, cli)
            return
        state['delivered'] = True
        temp = source / 'state.json.tmp'
        temp.write_text(json.dumps(state))
        os.replace(temp, state_file)
        delivery_succeeded(source, archive, cli)
        print('Verified backup delivered to Mac; retaining ' + str(args.keep) + ' complete copies.')


def main():
    root = Path(__file__).resolve().parents[1]
    delivery = read_json(root / '.local/config/backup-delivery.json')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', default=str(Path.home() / '.bb-backups/server'))
    parser.add_argument('--destination-host', default=os.environ.get('BB_BACKUP_DESTINATION_HOST') or delivery.get('destinationHost'))
    parser.add_argument('--destination-dir', default=os.environ.get('BB_BACKUP_DESTINATION_DIR') or delivery.get('destinationDir'))
    parser.add_argument('--keep', type=int, default=3)
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--interval-days', type=int, default=7)
    settings = root / '.local/config/backup-encryption.json'
    recipient = os.environ.get('BB_BACKUP_RECIPIENT')
    if not recipient and settings.is_file():
        recipient = json.loads(settings.read_text())['recipient']
    parser.add_argument('--recipient', default=recipient, help='Public age encryption recipient; never a secret identity')
    args = parser.parse_args()
    if not args.destination_host or not args.destination_dir:
        parser.error('Set --destination-host and --destination-dir, or .local/config/backup-delivery.json')
    if args.keep < 1:
        parser.error('--keep must be positive')
    if args.interval_days < 1:
        parser.error('--interval-days must be positive')
    try:
        tick(args)
    except Exception:
        try:
            report_backup_alert(Path(args.source_dir).expanduser(), 'backup-error', Cli())
        except Exception:
            pass
        raise


if __name__ == '__main__':
    main()
