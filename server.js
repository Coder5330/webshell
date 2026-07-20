'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const net = require('net');
const WebSocket = require('ws');
const pty = require('node-pty');

// ---- Config (all via environment variables) --------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
// Bind to localhost by default. Only expose to the network on purpose.
const HOST = process.env.HOST || '127.0.0.1';
// Shared password gate. Empty = no password (allowed ONLY on localhost).
const PASSWORD = process.env.SHELL_PASSWORD || '';

// 'docker' (default): every session gets its own throwaway, isolated
// container (see CONTAINER_NETWORK below for its internet access).
// 'local': old behaviour, spawns a shell directly on this machine
// (optionally dropped to SHELL_USER). Use 'local' only if Docker isn't
// available to you, and only on localhost.
const MODE = process.env.MODE || 'docker';

// ---- Docker-mode config ------------------------------------------------
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'webshell-sandbox';
const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY || '512m';
const CONTAINER_CPUS = process.env.CONTAINER_CPUS || '0.5';
const CONTAINER_PIDS = process.env.CONTAINER_PIDS || '64';
// /tmp and /home/sandbox are RAM-backed (tmpfs), so they draw from
// CONTAINER_MEMORY above — keep their combined size comfortably under it,
// leaving headroom for the shell and any processes you run.
const CONTAINER_HOME_SIZE = process.env.CONTAINER_HOME_SIZE || '256m';
const CONTAINER_TMP_SIZE = process.env.CONTAINER_TMP_SIZE || '128m';
const MAX_CONTAINERS = parseInt(process.env.MAX_CONTAINERS || '20', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MIN || '20', 10) * 60 * 1000;
// 'bridge' (default): normal outbound internet access (curl/wget/git work).
// 'none': fully offline, no networking at all.
// Either way the container can't see your Mac's filesystem or LAN shares —
// that isolation comes from the container boundary itself, not this flag.
const CONTAINER_NETWORK = process.env.CONTAINER_NETWORK || 'bridge';

// ---- Local-mode config (fallback, same as the original version) -------
const SHELL =
  process.env.SHELL_CMD ||
  (os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash');
const SHELL_USER = process.env.SHELL_USER || '';

// ---- Virtual desktop config (MODE=local only) --------------------------
// Lets GUI scripts (e.g. pynput/pygame) run in the shell and draw to a
// virtual display that's streamed into the browser over VNC/noVNC.
const ENABLE_DESKTOP = MODE === 'local' && /^(1|true)$/i.test(process.env.ENABLE_DESKTOP || '');
const DISPLAY_NUM = process.env.DISPLAY || ':99';
const VNC_PORT = parseInt(process.env.VNC_PORT || '5900', 10);
const DESKTOP_WIDTH = process.env.DESKTOP_WIDTH || '1280';
const DESKTOP_HEIGHT = process.env.DESKTOP_HEIGHT || '800';

const isPublicBind = HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1';
if (isPublicBind && !PASSWORD) {
  console.error(
    '\nRefusing to start: HOST is not localhost but no SHELL_PASSWORD is set.\n' +
      'An open shell on the network is a remote-code-execution hole.\n' +
      'Set SHELL_PASSWORD=... (and ideally put this behind HTTPS + a reverse proxy).\n'
  );
  process.exit(1);
}

// ---- Docker mode startup checks ----------------------------------------
if (MODE === 'docker') {
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    console.error(
      '\nMODE=docker but the Docker daemon is not reachable.\n' +
        'Start Docker Desktop (or your Docker daemon) and try again,\n' +
        'or set MODE=local to fall back to a direct shell (less isolated).\n'
    );
    process.exit(1);
  }
  try {
    execSync(`docker image inspect ${SANDBOX_IMAGE}`, { stdio: 'ignore' });
  } catch {
    console.error(
      `\nMODE=docker but the sandbox image "${SANDBOX_IMAGE}" doesn't exist yet.\n` +
        'Build it first:\n' +
        `  docker build -t ${SANDBOX_IMAGE} -f Dockerfile.sandbox .\n`
    );
    process.exit(1);
  }
}

// ---- Virtual desktop startup (MODE=local only): Xvfb + fluxbox + x11vnc ---
// Shared single desktop process for the whole server lifetime — not
// per-user-isolated. Multiple simultaneous users see/control the same
// desktop. Revisit by moving this into MODE=docker per-session if
// concurrent multi-user access is ever needed.
if (ENABLE_DESKTOP) {
  startVirtualDesktop();
}

function startVirtualDesktop() {
  const xvfb = spawn('Xvfb', [DISPLAY_NUM, '-screen', '0',
    `${DESKTOP_WIDTH}x${DESKTOP_HEIGHT}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
  xvfb.on('exit', (code) => console.error(`Xvfb exited (code ${code})`));

  // give Xvfb a moment to create the display socket before starting clients
  setTimeout(() => {
    const fluxbox = spawn('fluxbox', [], { stdio: 'ignore', env: { ...process.env, DISPLAY: DISPLAY_NUM } });
    fluxbox.on('exit', (code) => console.error(`fluxbox exited (code ${code})`));

    const vnc = spawn('x11vnc', [
      '-display', DISPLAY_NUM,
      '-rfbport', String(VNC_PORT),
      '-localhost',      // bind 127.0.0.1 only, never externally reachable
      '-forever',        // survive client disconnects, don't exit after first client
      '-shared',
      '-nopw',           // no VNC-level password — auth is the existing token gate
      '-quiet',
    ], { stdio: 'ignore', env: { ...process.env, DISPLAY: DISPLAY_NUM } });
    vnc.on('exit', (code) => console.error(`x11vnc exited (code ${code})`));
  }, 1500);
}

// ---- Local-mode user resolution (unchanged from the original) ----------
function resolveUser(name) {
  const uid = parseInt(execSync(`id -u ${name}`).toString().trim(), 10);
  const gid = parseInt(execSync(`id -g ${name}`).toString().trim(), 10);
  let home = `/Users/${name}`;
  try {
    const out = execSync(`dscl . -read /Users/${name} NFSHomeDirectory`)
      .toString()
      .trim();
    home = out.split(/\s+/).slice(1).join(' ') || home;
  } catch {
    /* fall back to default */
  }
  if (Number.isNaN(uid) || Number.isNaN(gid)) {
    throw new Error(`could not resolve uid/gid for user "${name}"`);
  }
  return { uid, gid, home };
}

let dropUser = null;
if (MODE === 'local' && SHELL_USER) {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    console.error(
      `\nSHELL_USER="${SHELL_USER}" is set but the server is not running as root.\n` +
        'Dropping the shell to another user requires root. Start it like:\n' +
        `  sudo SHELL_USER=${SHELL_USER} MODE=local node server.js\n`
    );
    process.exit(1);
  }
  try {
    dropUser = resolveUser(SHELL_USER);
  } catch (e) {
    console.error(`\nCould not set up SHELL_USER: ${e.message}\n`);
    process.exit(1);
  }
}

// ---- Simple token store (issued on login, checked on WS upgrade) -----------
const TOKEN_TTL_MS = 10 * 60 * 1000;
const tokens = new Map(); // token -> expiry epoch ms

function issueToken() {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, Date.now() + TOKEN_TTL_MS);
  return t;
}
function tokenValid(t) {
  if (!t) return false;
  const exp = tokens.get(t);
  if (!exp) return false;
  if (Date.now() > exp) {
    tokens.delete(t);
    return false;
  }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of tokens) if (now > exp) tokens.delete(t);
}, 60 * 1000).unref();

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest();
}
function safeEqual(a, b) {
  const ha = sha256(a);
  const hb = sha256(b);
  return crypto.timingSafeEqual(ha, hb);
}

// ---- Login rate limiting ---------------------------------------------------
// Best-effort client identifier: tunnels (cloudflared, ngrok) proxy the
// real connection through localhost, but usually forward the original
// client IP in a header. Falls back to the raw socket address.
function clientId(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // id -> { count, windowStart, lockedUntil }

function checkLoginLimit(id) {
  const now = Date.now();
  const rec = loginAttempts.get(id);
  if (!rec) return { allowed: true };
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { allowed: false, retryAfterMs: rec.lockedUntil - now };
  }
  if (now - rec.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(id);
    return { allowed: true };
  }
  return { allowed: true };
}
function recordLoginFailure(id) {
  const now = Date.now();
  const rec = loginAttempts.get(id) || { count: 0, windowStart: now, lockedUntil: 0 };
  if (now - rec.windowStart > LOGIN_WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
  loginAttempts.set(id, rec);
}
function recordLoginSuccess(id) {
  loginAttempts.delete(id);
}
setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of loginAttempts) {
    if ((!rec.lockedUntil || now > rec.lockedUntil) && now - rec.windowStart > LOGIN_WINDOW_MS) {
      loginAttempts.delete(id);
    }
  }
}, 60 * 1000).unref();

// ---- HTTP app --------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ authRequired: PASSWORD.length > 0, desktopEnabled: ENABLE_DESKTOP });
});

app.post('/api/login', (req, res) => {
  if (!PASSWORD) return res.json({ token: issueToken() });

  const id = clientId(req);
  const limit = checkLoginLimit(id);
  if (!limit.allowed) {
    const mins = Math.ceil(limit.retryAfterMs / 60000);
    return res.status(429).json({ error: `Too many attempts. Try again in ~${mins} min.` });
  }

  const password = (req.body && req.body.password) || '';
  if (typeof password === 'string' && safeEqual(password, PASSWORD)) {
    recordLoginSuccess(id);
    return res.json({ token: issueToken() });
  }
  recordLoginFailure(id);
  return res.status(401).json({ error: 'Invalid password' });
});

// ---- HTTP server + WebSocket upgrade --------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const vncWss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('token');
  if (!tokenValid(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (url.pathname === '/vnc-ws' && ENABLE_DESKTOP) {
    vncWss.handleUpgrade(req, socket, head, (ws) => vncWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// Raw TCP<->WebSocket bridge to the local x11vnc server, so noVNC's RFB
// client (binary VNC protocol over WS) can reach it without exposing a
// second port — reuses the token check above, no separate auth.
vncWss.on('connection', (ws) => {
  const tcp = net.connect({ host: '127.0.0.1', port: VNC_PORT });
  tcp.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });
  ws.on('message', (data) => {
    tcp.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  const closeBoth = () => {
    try { tcp.destroy(); } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }
  };
  tcp.on('close', closeBoth);
  tcp.on('error', closeBoth);
  ws.on('close', closeBoth);
  ws.on('error', closeBoth);
});

// ws -> { name, term, lastActivity }. Only populated in docker mode, used
// for the container cap and the idle sweep.
const activeContainers = new Map();

function wireTerm(ws, term, sessionState) {
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (sessionState) sessionState.lastActivity = Date.now();
    if (msg.type === 'input' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      try {
        term.resize(msg.cols, msg.rows);
      } catch {
        /* ignore */
      }
    }
  });
}

wss.on('connection', (ws) => {
  if (MODE === 'docker') {
    if (activeContainers.size >= MAX_CONTAINERS) {
      ws.send(
        JSON.stringify({
          type: 'output',
          data: '\r\n\x1b[31mServer is at capacity, please try again shortly.\x1b[0m\r\n',
        })
      );
      ws.close();
      return;
    }

    const name = `webshell-${crypto.randomBytes(6).toString('hex')}`;
    const args = [
      'run',
      '--rm',
      '-it',
      '--name', name,
      '--network', CONTAINER_NETWORK,
      '--memory', CONTAINER_MEMORY,
      '--memory-swap', CONTAINER_MEMORY, // disables swap beyond the memory cap
      '--cpus', CONTAINER_CPUS,
      '--pids-limit', String(CONTAINER_PIDS),
      '--security-opt', 'no-new-privileges:true',
      '--cap-drop', 'ALL',
      '--read-only',
      '--tmpfs', `/tmp:rw,exec,size=${CONTAINER_TMP_SIZE},mode=1777`,
      '--tmpfs', `/home/sandbox:rw,exec,size=${CONTAINER_HOME_SIZE},uid=1000,gid=1000,mode=0755`,
      '--user', 'sandbox',
      SANDBOX_IMAGE,
      '/bin/bash',
    ];

    const term = pty.spawn('docker', args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });

    const sessionState = { name, term, lastActivity: Date.now() };
    activeContainers.set(ws, sessionState);
    wireTerm(ws, term, sessionState);

    const cleanup = () => {
      if (!activeContainers.has(ws)) return;
      activeContainers.delete(ws);
      try {
        term.kill();
      } catch {
        /* ignore */
      }
      try {
        execSync(`docker kill ${name}`, { stdio: 'ignore' });
      } catch {
        /* already gone, fine — --rm handles the common case */
      }
    };

    ws.on('close', cleanup);
    term.onExit(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      cleanup();
    });
  } else {
    // ---- local mode: direct shell on this machine, optionally dropped
    // to SHELL_USER. Not sandboxed the way docker mode is.
    const spawnEnv = dropUser
      ? {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
          HOME: dropUser.home,
          USER: SHELL_USER,
          LOGNAME: SHELL_USER,
          SHELL: SHELL,
          TERM: 'xterm-color',
          ...(ENABLE_DESKTOP ? { DISPLAY: DISPLAY_NUM } : {}),
        }
      : { ...process.env, ...(ENABLE_DESKTOP ? { DISPLAY: DISPLAY_NUM } : {}) };

    const term = pty.spawn(SHELL, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: dropUser ? dropUser.home : process.env.HOME || process.cwd(),
      env: spawnEnv,
      ...(dropUser ? { uid: dropUser.uid, gid: dropUser.gid } : {}),
    });

    wireTerm(ws, term, null);

    ws.on('close', () => {
      try {
        term.kill();
      } catch {
        /* ignore */
      }
    });
    term.onExit(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }
});

// Idle sweep: closes sessions that have had no input for IDLE_TIMEOUT_MS,
// so an abandoned tab doesn't leave a container running indefinitely.
if (MODE === 'docker') {
  setInterval(() => {
    const now = Date.now();
    for (const [ws, state] of activeContainers) {
      if (now - state.lastActivity > IDLE_TIMEOUT_MS) {
        try {
          ws.send(
            JSON.stringify({
              type: 'output',
              data: '\r\n\x1b[33m[idle timeout — session closed]\x1b[0m\r\n',
            })
          );
        } catch {
          /* ignore */
        }
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }
  }, 30 * 1000).unref();
}

server.listen(PORT, HOST, () => {
  console.log(`web terminal listening on http://${HOST}:${PORT}`);
  console.log(`mode: ${MODE}`);
  if (MODE === 'docker') {
    console.log(
      `sandbox image: ${SANDBOX_IMAGE}  |  limits: ${CONTAINER_MEMORY} mem, ` +
        `${CONTAINER_CPUS} cpu, ${CONTAINER_PIDS} pids, network ${CONTAINER_NETWORK}  |  ` +
        `home ${CONTAINER_HOME_SIZE}, tmp ${CONTAINER_TMP_SIZE}  |  ` +
        `max ${MAX_CONTAINERS} concurrent sessions, ${IDLE_TIMEOUT_MS / 60000}min idle timeout`
    );
  } else {
    console.log(`shell: ${SHELL}`);
    if (dropUser) {
      console.log(`shells run as user "${SHELL_USER}" (uid ${dropUser.uid}), home ${dropUser.home}`);
    }
    if (ENABLE_DESKTOP) {
      console.log(`desktop: enabled (display ${DISPLAY_NUM}, vnc 127.0.0.1:${VNC_PORT})`);
    }
  }
  if (!PASSWORD) {
    console.log('no SHELL_PASSWORD set — localhost only. Do NOT expose this publicly.');
  }
});