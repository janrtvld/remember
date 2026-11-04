#!/usr/bin/env python3
"""Install/control the isolated Remember Codex LaunchAgent (no credential copying)."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path.home() / 'Remember Agent'
LABEL = 'computer.remember.agent-host'
PLIST = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
TARGET = f'gui/{os.getuid()}/{LABEL}'


def run(*args, check=True):
    return subprocess.run(args, check=check)


def wait_ready():
    for _ in range(30):
        try:
            with urlopen('http://127.0.0.1:47831/readyz', timeout=1) as response:
                if response.status == 200:
                    print('Ready: ws://127.0.0.1:47831')
                    return
        except OSError:
            pass
        time.sleep(1)
    raise SystemExit('Service did not become ready within 30 seconds')


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if action == 'install':
        codex = shutil.which('codex')
        if not codex:
            raise SystemExit('codex must be installed and signed in first')
        for directory in ('workspace', 'logs', 'state'):
            (ROOT / directory).mkdir(parents=True, exist_ok=True, mode=0o700)
        ROOT.chmod(0o700)
        config = {
            'Label': LABEL,
            'ProgramArguments': [codex, 'app-server', '--listen', 'ws://127.0.0.1:47831',
                                 '-c', 'sandbox_mode="workspace-write"',
                                 '-c', 'approval_policy="on-request"'],
            'WorkingDirectory': str(ROOT / 'workspace'),
            'EnvironmentVariables': {'HOME': str(Path.home()),
                                     'PATH': str(Path.home() / '.local/bin') + ':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
            'RunAtLoad': True,
            'KeepAlive': True,
            'ThrottleInterval': 10,
            'Umask': 0o077,
            'StandardOutPath': str(ROOT / 'logs/stdout.log'),
            'StandardErrorPath': str(ROOT / 'logs/stderr.log'),
        }
        PLIST.parent.mkdir(parents=True, exist_ok=True)
        with PLIST.open('wb') as file:
            plistlib.dump(config, file)
        PLIST.chmod(0o600)
        print(f'Installed {PLIST}; run start to load it.')
    elif action == 'start':
        run('launchctl', 'bootstrap', f'gui/{os.getuid()}', str(PLIST))
        wait_ready()
    elif action == 'stop':
        run('launchctl', 'bootout', TARGET)
    elif action == 'restart':
        run('launchctl', 'kickstart', '-k', TARGET)
        wait_ready()
    elif action == 'status':
        run('launchctl', 'print', TARGET)
    else:
        raise SystemExit('Usage: service.py install|start|stop|restart|status')


if __name__ == '__main__':
    main()
