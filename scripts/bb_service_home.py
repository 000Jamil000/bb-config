#!/usr/bin/env python3
"""Set the service account's HOME for a BB systemd daemon, without restarting it."""
import argparse
import json
import pathlib
import pwd
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('service', help='BB systemd .service unit')
    parser.add_argument('--apply', action='store_true', help='Install a drop-in and reload systemd; does not restart BB')
    parser.add_argument('--verify', action='store_true', help='Fail if the running daemon still has the wrong HOME')
    args = parser.parse_args()
    if not re.fullmatch(r'bb[-a-zA-Z0-9_.@]+\.service', args.service):
        parser.error('Expected an explicit BB .service unit name')
    def property_value(name):
        return subprocess.check_output(['systemctl', 'show', args.service, '--value', '-p', name], text=True).strip()
    if not property_value('FragmentPath'):
        parser.error('Service is not installed')
    account = property_value('User') or 'root'
    user = pwd.getpwuid(int(account)) if account.isdigit() else pwd.getpwnam(account)
    home = user.pw_dir
    if not pathlib.Path(home).is_dir():
        parser.error('The service account home directory does not exist')
    pid = int(property_value('MainPID') or 0)
    current_home = None
    if pid:
        for entry in pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
            if entry.startswith(b'HOME='):
                current_home = entry[5:].decode()
                break
    target = pathlib.Path('/etc/systemd/system') / f'{args.service}.d' / '90-bb-home.conf'
    content = '[Service]\nEnvironment=' + json.dumps(f'HOME={home}') + '\n'
    print(f'Account: {account}; expected HOME: {home}; running HOME: {current_home!r}')
    print(f'Drop-in: {target}')
    if args.apply:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        target.chmod(0o644)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        print('Drop-in installed. Restart the daemon separately when thread resumption is ready.')
    if args.verify and current_home != home:
        raise SystemExit('Running HOME does not match the service account; restart is still required')


if __name__ == '__main__':
    main()
