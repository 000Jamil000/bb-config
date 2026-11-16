#!/usr/bin/env python3
"""Daily encrypted config, weekly official BB export, retry delivery on each tick."""
import argparse
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import time


def install_restore_tools(root, cli, host, destination):
    """Keep recovery usable even when the source server and checkout are lost."""
    tools = Path(destination) / 'restore-tools'
    cli.remote_python(host, 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); '
                      'p.mkdir(parents=True,exist_ok=True,mode=0o700);p.chmod(0o700)', str(tools))
    for name in ('backup_keys.py', 'server_backup.py', 'private_backup.py'):
        cli.call('file', 'write', str(tools / name), '--host', host, '--stdin', '--json',
                 stdin=(root / 'scripts' / name).read_text())
    readme = ('# Восстановление BB\n\n'
              'Запускайте на Mac с ключом восстановления в Keychain и установленным age.\n'
              'Расшифровать и проверить любой архив:\n\n'
              '    python3 restore-tools/backup_keys.py decrypt ARCHIVE.age --output restored.tar.gz\n\n'
              'Для private-config: распакуйте в отдельную папку; source/ содержит текущие\n'
              'исходники bb-config, .local/ — личную конфигурацию. Перенесите их в checkout.\n'
              'Затем python3 scripts/restore.py показывает план восстановления.\n\n'
              'Для bb-server: bb server import restored.tar.gz --data-dir /private/path/new-bb\n'
              'Импортируйте в пустой каталог совместимой версии BB. Перед запуском\n'
              'восстановленного сервера остановите прежний. Рабочие проекты сохраняются отдельно.\n'
              'Удалите расшифрованный архив после восстановления.\n')
    cli.call('file', 'write', str(tools / 'README.md'), '--host', host, '--stdin', '--json', stdin=readme)


def config_tick(root, source, cli, recipient, host, destination, keep=7, force=False):
    import private_backup
    import server_backup as backup
    source.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_path = source / 'state.json'
    state = backup.read_json(state_path)
    archive = Path(state.get('archive', '/missing-config-backup'))
    day = backup.backup_day()
    if (force or state.get('day') != day or not archive.is_file()
            or state.get('recipient') != recipient or state.get('formatVersion') != 2):
        subprocess.run([sys.executable, str(root / 'scripts/snapshot.py'), '--settings-only'],
                       check=True, timeout=180)
        manifest = backup.read_json(root / '.local/config/automations.json')
        projects = sorted({row['project'] for row in manifest.get('automations', [])})
        if projects:
            command = [sys.executable, str(root / 'scripts/automation_config.py'), '--snapshot']
            for project in projects:
                command.extend(['--project', project])
            subprocess.run(command, check=True, timeout=180)
        archive = private_backup.backup(root=root, recipient=recipient, include_sources=True)
        backup.save_json(state_path, {'day': day, 'archive': str(archive),
                                     'formatVersion': 2,
                                     'sha256': backup.digest(archive), 'recipient': recipient,
                                     'delivered': False})
        state = backup.read_json(state_path)
        # Keep daily config copies independently of the three weekly BB copies.
        for old in sorted(archive.parent.glob('private-config-*.tar.gz.age'), reverse=True)[keep:]:
            old.unlink()
        print('Daily config encrypted (' + str(archive.stat().st_size) + ' bytes).')
    if state.get('delivered'):
        return
    if backup.digest(archive) != state['sha256']:
        raise ValueError('Encrypted config checksum changed before delivery')
    try:
        if cli.call('machine', 'show', host, '--json').get('status') != 'connected':
            backup.delivery_pending(source, cli)
            print('Config retained on server; waiting for Mac to reconnect.')
            return
        install_restore_tools(root, cli, host, destination)
        backup.deliver(cli, archive, host, destination, keep)
    except Exception as error:
        backup.delivery_pending(source, cli)
        print('Config delivery pending; next tick will retry. ' + type(error).__name__)
        return
    state['delivered'] = True
    backup.save_json(state_path, state)
    backup.save_json(source / 'delivery-state.json', {'archive': archive.name,
                     'lastSuccessfulDeliveryAt': time.time()})
    print('Daily config delivered to Mac and checksum verified.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--force-full', action='store_true')
    parser.add_argument('--force-config', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(os.environ.get('BB_CONFIG_ROOT', Path(__file__).resolve().parents[1])).resolve()
    if not (root / 'scripts/snapshot.py').is_file():
        parser.error('BB_CONFIG_ROOT must point to the bb-config checkout')
    sys.path.insert(0, str(root / 'scripts'))
    import server_backup as backup
    settings = root / '.local/config'
    delivery = backup.read_json(settings / 'backup-delivery.json')
    recipient = os.environ.get('BB_BACKUP_RECIPIENT') or backup.read_json(settings / 'backup-encryption.json').get('recipient')
    host = os.environ.get('BB_BACKUP_DESTINATION_HOST') or delivery.get('destinationHost')
    destination = os.environ.get('BB_BACKUP_DESTINATION_DIR') or delivery.get('destinationDir')
    if not all((recipient, host, destination)):
        parser.error('Encryption recipient and delivery settings are required')
    source = Path.home() / '.bb-backups/server'
    source.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (source / '.daily-job.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        cli = backup.Cli()
        try:
            config_source = source / 'config'
            before = backup.read_json(config_source / 'state.json')
            config_tick(root, config_source, cli, recipient, host, destination, force=args.force_config)
            if not args.force_full and before != backup.read_json(config_source / 'state.json'):
                # Each phase gets its own automation budget. A large full export
                # must not compete with the daily snapshot's API calls.
                return
            backup.tick(argparse.Namespace(source_dir=str(source), recipient=recipient,
                        destination_host=host, destination_dir=destination, keep=3,
                        interval_days=7, force=args.force_full, defer_delivery=True))
        except Exception:
            backup.report_backup_alert(source, 'backup-error', cli)
            raise


if __name__ == '__main__':
    main()
