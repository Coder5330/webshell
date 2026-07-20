# webshell

A browser-based terminal, like the picoCTF webshell: an `xterm.js` frontend
talking over a WebSocket to a real shell running elsewhere.

```
browser (xterm.js)  <--WebSocket-->  server.js  <--pty-->  docker run (sandbox container)
```

By default every browser session gets its **own throwaway Docker container**:
outbound internet access, capped CPU/memory/processes, all Linux
capabilities dropped, a non-root user, and a read-only filesystem. When you
disconnect, the container is killed and removed — nothing persists, and it
can't see your Mac's files or local network shares. This is the same shape
as picoCTF's shell pool (one isolated environment per user), just running
locally via Docker Desktop instead of a fleet of servers.

## Setup

Requires Node.js 18+ and Docker Desktop (or another Docker daemon) running.

```bash
npm install

# build the sandbox image once (rebuild after editing Dockerfile.sandbox)
docker build -t webshell-sandbox -f Dockerfile.sandbox .

npm start
```

Open http://127.0.0.1:3000 — you'll land in a fresh container as the
non-root `sandbox` user. Close the tab (or let it sit idle) and the
container is torn down.

## Modes

| `MODE`   | What it does                                                          |
|----------|------------------------------------------------------------------------|
| `docker` | **Default.** Fresh, sandboxed, network-less container per session.    |
| `local`  | Original behaviour — spawns a shell directly on this machine, optionally dropped to `SHELL_USER`. Only use this on localhost, and only if Docker isn't an option for you. |

## Configuration

All via environment variables:

| Variable            | Default            | Meaning                                              |
|---------------------|---------------------|-------------------------------------------------------|
| `PORT`              | `3000`              | Port to listen on                                      |
| `HOST`              | `127.0.0.1`         | Bind address. Use `0.0.0.0` to expose on the network   |
| `SHELL_PASSWORD`    | *(empty)*           | Access password. Required to bind non-local            |
| `MODE`              | `docker`            | `docker` or `local`                                    |
| `SANDBOX_IMAGE`     | `webshell-sandbox`  | Image built from `Dockerfile.sandbox`                  |
| `CONTAINER_MEMORY`  | `512m`              | Memory cap per session container (shared with the tmpfs sizes below) |
| `CONTAINER_CPUS`    | `0.5`               | CPU cap per session container                           |
| `CONTAINER_PIDS`    | `64`                | Max processes per session container                     |
| `CONTAINER_HOME_SIZE` | `256m`            | Writable space at `/home/sandbox` (RAM-backed, counts against `CONTAINER_MEMORY`) |
| `CONTAINER_TMP_SIZE`  | `128m`            | Writable space at `/tmp` (RAM-backed, counts against `CONTAINER_MEMORY`) |
| `CONTAINER_NETWORK` | `bridge`            | `bridge` (internet access) or `none` (fully offline)     |
| `MAX_CONTAINERS`    | `20`                | Max simultaneous sandbox sessions                        |
| `IDLE_TIMEOUT_MIN`  | `20`                | Minutes of inactivity before a session is closed          |
| `SHELL_CMD`         | `bash` / `powershell` | (local mode only) which shell to launch                |
| `SHELL_USER`        | *(empty)*           | (local mode only) OS user to drop the shell to, needs `sudo` |

Example, password-protected and exposed on your LAN:

```bash
HOST=0.0.0.0 SHELL_PASSWORD='choose-something-strong' npm start
```

The server refuses to start if you bind to a non-localhost address without a
password, in either mode.

## Sharing with others over the internet

Don't forward a port on your router for this — that puts your home IP
directly on the internet and is a pain to lock back down. Use a **tunnel**
instead: a small program that opens a temporary, encrypted public URL and
forwards it to your Mac. No router changes, and your home IP stays hidden.

```bash
# one-time install
brew install cloudflared

# terminal 1 — run the server as usual, but set a real password
# (HOST can stay at its default 127.0.0.1; the tunnel forwards to it locally)
SHELL_PASSWORD='choose-something-strong' npm start

# terminal 2 — open the tunnel
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints a random `https://something.trycloudflare.com` URL —
send that to your friends. It's HTTPS automatically, so the password and
terminal traffic are encrypted in transit, unlike a plain LAN connection.
Close the `cloudflared` process (Ctrl-C) when you're done; the URL stops
working immediately.

The password is still the real gate — the URL alone isn't a secret, just
hard to guess. The server now rate-limits login attempts (5 tries, then a
15-minute lockout per source), so brute-forcing the password isn't
practical either.

One more thing worth deciding: `CONTAINER_NETWORK=bridge` (the default)
lets each session reach the internet — fine for friends you trust, but
means their traffic exits from your home connection. If you'd rather not
allow that for people who aren't you, start the server with
`CONTAINER_NETWORK=none` instead.

## Security

**Docker mode** (default) gives real defense in depth per session:
- `--memory` / `--cpus` / `--pids-limit` — one session can't starve the host
- `--cap-drop ALL` + `--security-opt no-new-privileges` — no elevated syscalls
- `--read-only` root filesystem, with small writable `tmpfs` mounts for
  `/tmp` and the sandbox user's home — nothing written inside survives the
  session, and the image itself can't be modified
- non-root `sandbox` user inside the container
- `--rm` plus an explicit `docker kill` on disconnect, so containers don't
  pile up; an idle timeout closes forgotten sessions too
- the container has its own filesystem and can't see your Mac's files or
  LAN shares, regardless of the networking setting below

**Networking:** `CONTAINER_NETWORK=bridge` (the default) gives sessions real
outbound internet access — `curl`, `wget`, `git clone`, etc. all work, same
as any normal Docker container. This doesn't weaken the isolation above; a
session still can't reach your Mac's filesystem. The tradeoff is that a
session *can* reach the internet, which matters more if you ever expose this
beyond localhost. Set `CONTAINER_NETWORK=none` for a fully offline sandbox
if you'd rather not allow that.

Still worth knowing:
- The **password gate** is a single shared secret. Fine for personal/lab use,
  not for multi-user production auth.
- If you expose this beyond localhost, put it behind **HTTPS** (a reverse
  proxy like nginx or Caddy) so the WebSocket runs over `wss://`, and
  consider `CONTAINER_NETWORK=none` so a compromised or abusive session can't
  use your server as a relay.
- `MAX_CONTAINERS` is a blunt but effective backstop against someone opening
  many tabs to exhaust your host — tune it to your machine.
- **Local mode** has none of the container isolation above. It's the original
  "real shell on this machine" version, useful mainly if Docker isn't
  available to you. Keep it on localhost.

## Alternatives worth knowing

If you just want this working without maintaining code, [`ttyd`](https://github.com/tsl0922/ttyd),
[`wetty`](https://github.com/butlerx/wetty), and [`gotty`](https://github.com/yudai/gotty)
do the same job. This project exists so you can see and control every moving
part — including, now, the sandboxing.