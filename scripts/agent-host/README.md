# Remember Agent host

This optional service runs an installed Codex app-server under a macOS user's login session. It uses that user's existing Codex login in place and does not copy credential files. A second computer connects through an SSH tunnel. Remember does not require this service for local use.

## Install on the host

Install Codex, sign in, and make its executable available on `PATH`. From this repository on the host, run:

```sh
python3 scripts/agent-host/service.py install
python3 scripts/agent-host/service.py start
python3 scripts/agent-host/service.py status
```

The installer creates:

- A workspace at `~/Remember Agent/workspace`.
- Private logs at `~/Remember Agent/logs/{stdout,stderr}.log`.
- A LaunchAgent at `~/Library/LaunchAgents/computer.remember.agent-host.plist`.
- A loopback endpoint at `ws://127.0.0.1:47831` with readiness at `http://127.0.0.1:47831/readyz`.

Use `stop`, `start`, or `restart` to control the service. Stop it before reinstalling its plist, then start it again. The plist invokes the installed Codex binary directly. Launchd restarts the process after an exit, and starts it when that user logs in; it is not a system daemon that starts before login. Manage host sleep and log retention separately.

## Connect from another Mac

Enable Remote Login for the host account and configure SSH key authentication. Verify the host fingerprint through a trusted channel before installing the tunnel. The loopback WebSocket has no bearer authentication: remote access relies on SSH authentication and encryption. Do not expose it through public port forwarding or an unrestricted TCP proxy.

Set the host and account for your environment, then install the client LaunchAgent:

```sh
export REMEMBER_SSH_HOST=agent-host.example.com
export REMEMBER_SSH_USER=your-user

python3 scripts/agent-host/client-tunnel.py install \
  --host "$REMEMBER_SSH_HOST" --user "$REMEMBER_SSH_USER"
python3 scripts/agent-host/client-tunnel.py start
python3 scripts/agent-host/client-tunnel.py status
```

The tunnel forwards `127.0.0.1:47832` on the client to `127.0.0.1:47831` on the host. It uses strict host-key checking, noninteractive authentication, keepalives, and launchd restart behavior. Use `stop`, `start`, or `restart` to manage it. After reinstalling a loaded tunnel's configuration, stop and start it to apply the change.

A reachable private DNS name, including a VPN hostname, can be used for `--host`. If the same trusted machine changes its reachable name, `--host-key-alias` can preserve its existing SSH identity. It must not be used to bypass fingerprint verification for a different machine.

In Remember's agent computer settings, use `ws://127.0.0.1:47832/` and the absolute path to `Remember Agent/workspace` on the host. The tunnel status checks transport readiness; it does not establish that an agent task completed. Do not start a second tunnel on the managed port.

## Verify the protocol and persistence

Run the bounded probe on the host. It asks the real provider to create and read small proof files inside the dedicated workspace:

```sh
node scripts/agent-host/probe.mjs create
python3 scripts/agent-host/service.py restart
node scripts/agent-host/probe.mjs resume
```

The probe saves its thread pointer in `~/Remember Agent/state/probe.json`, resumes that thread after restart, and independently reads the resulting files. It rejects approval requests. A successful probe establishes this host protocol and file-persistence path; it does not prove native Remember integration or recovery from every interrupted side effect.

Native remote QA scenarios additionally require explicit configuration:

```sh
export REMEMBER_QA_SSH_TARGET="$REMEMBER_SSH_USER@$REMEMBER_SSH_HOST"
export REMEMBER_QA_REMOTE_WORKSPACE='/absolute/path/to/dedicated/qa/workspace'
```

These values are read only when the relevant live remote scenario runs. The workspace must match the remote agent configuration. Other host-job scenarios have their own required `REMEMBER_QA_HOST_*` settings and isolated runtime constraints; see their scenario source and [native verification](../../docs/native-verification.md).

## Client contract

Use the installed CLI's generated schema as the source of truth:

```sh
codex app-server generate-json-schema --out /tmp/remember-agent-schema
```

Initialize each WebSocket with `initialize`, then `initialized`. Create a thread with `thread/start`, an explicit workspace `cwd`, `sandbox: "workspace-write"`, and `approvalPolicy: "on-request"`. Persist the returned thread ID and start work with `turn/start`. Present approval requests to the user.

After transport or process loss, reconnect and call `thread/resume` with the saved ID. Inspect its state before starting another turn. Reconcile interrupted side effects before retrying them; a process restart does not guarantee safe replay. The service remains available while clients disconnect and does not create work while idle.

Official protocol reference: <https://learn.chatgpt.com/docs/app-server>
