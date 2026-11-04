#!/usr/bin/env python3
"""Keep Remember's private Mac-mini connection alive in the user's login session."""
import argparse
import os
from pathlib import Path
import plistlib
import re
import subprocess
import time
from urllib.request import urlopen

LABEL = 'computer.remember.agent-tunnel'
PLIST = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
TARGET = f'gui/{os.getuid()}/{LABEL}'
ROOT = Path.home() / 'Library/Application Support/Remember Agent Connection'
LOCAL_PORT = 47832
REMOTE_PORT = 47831


def ready():
    try:
        with urlopen(f'http://127.0.0.1:{LOCAL_PORT}/readyz', timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'start', 'stop', 'restart', 'status'])
    parser.add_argument('--host', help='Reachable SSH hostname, preferably the Mini\'s Tailscale DNS name.')
    parser.add_argument('--host-key-alias', help='Existing trusted SSH host identity for the same computer.')
    parser.add_argument('--user', default='ai')
    args = parser.parse_args()
    if args.action == 'install' and not args.host:
        parser.error('install requires --host; use a Tailscale DNS name for access away from home.')
    for hostname in [args.host, args.host_key_alias]:
        if hostname is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', hostname):
            parser.error('Use an SSH hostname without options, credentials or a URL.')
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_-]*', args.user):
        parser.error('Invalid SSH user.')

    ssh = ['/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
           '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
           '-o', 'ServerAliveCountMax=3']
    if args.host_key_alias:
        ssh += ['-o', f'HostKeyAlias={args.host_key_alias}']
    if args.action == 'install':
        subprocess.run(ssh + [f'{args.user}@{args.host}', 'true'], check=True, timeout=15)
        if PLIST.exists():
            existing = plistlib.loads(PLIST.read_bytes())
            if existing.get('Label') != LABEL or existing.get('ProgramArguments', [None])[0] != '/usr/bin/ssh':
                raise SystemExit('Existing service does not match this tunnel; left unchanged.')
        ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        config = {
            'Label': LABEL,
            'ProgramArguments': ssh + ['-N', '-o', 'ExitOnForwardFailure=yes', '-L',
                                      f'127.0.0.1:{LOCAL_PORT}:127.0.0.1:{REMOTE_PORT}',
                                      f'{args.user}@{args.host}'],
            'RunAtLoad': True,
            'KeepAlive': True,
            'ThrottleInterval': 10,
            'Umask': 0o077,
            'StandardOutPath': str(ROOT / 'tunnel.stdout.log'),
            'StandardErrorPath': str(ROOT / 'tunnel.stderr.log'),
        }
        PLIST.parent.mkdir(parents=True, exist_ok=True)
        with PLIST.open('wb') as file:
            plistlib.dump(config, file)
        PLIST.chmod(0o600)
        print(f'Installed {PLIST}. If already loaded, stop then start to apply the new connection.')
        return
    if args.action == 'status':
        result = subprocess.run(['/bin/launchctl', 'print', TARGET], capture_output=True, text=True)
        print('Service loaded:', result.returncode == 0)
        print('Agent ready:', ready())
        raise SystemExit(0 if result.returncode == 0 and ready() else 1)
    if args.action == 'stop':
        subprocess.run(['/bin/launchctl', 'bootout', TARGET], check=True)
        return
    if args.action == 'start':
        subprocess.run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(PLIST)], check=True)
    else:
        subprocess.run(['/bin/launchctl', 'kickstart', '-k', TARGET], check=True)
    for _ in range(30):
        if ready():
            print(f'Ready: ws://127.0.0.1:{LOCAL_PORT}')
            return
        time.sleep(1)
    raise SystemExit('Tunnel loaded, but the remote agent is not ready. Check connection status and private logs.')


if __name__ == '__main__':
    main()
