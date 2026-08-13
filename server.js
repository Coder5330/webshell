'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const WebSocket = require('ws');
const pty = require('node-pty');
const { Pool } = require('pg');

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
// Comma-separated names of host env vars to forward into every fresh
// container as -e VAR=value (e.g. "DATABASE_URL,NEON_DATABASE_URL"). Lets
// you set a Neon/Postgres connection string once on the host and have it
// available in every session without it living anywhere in the container's
// (ephemeral) filesystem. Only the listed names are forwarded — the rest
// of the host's env stays out of the sandbox. See README for setup.
const SANDBOX_ENV_PASSTHROUGH = (process.env.SANDBOX_ENV_PASSTHROUGH || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---- Optional persistence (Neon/Postgres) -------------------------------
// Every docker-mode session gets a brand-new, empty throwaway container, so
// anything saved in one session is gone once it ends. If DATABASE_URL is
// set on the HOST (same var you'd list in SANDBOX_ENV_PASSTHROUGH), the
// server itself also mirrors every successful fs write out to Postgres,
// keyed by file path, and transparently restores a file from there the
// first time it's read in a fresh session (e.g. right after opening it in
// a brand-new container). This is a simple path-keyed overlay, not a
// per-session snapshot — two sessions editing the same path will still
// last-write-wins against each other, same as the container fs would.
const PERSIST_DATABASE_URL = process.env.DATABASE_URL || '';
const pgPool = PERSIST_DATABASE_URL
  ? new Pool({ connectionString: PERSIST_DATABASE_URL, max: 5 })
  : null;

let pgReady = null;
function ensurePgSchema() {
  if (!pgPool) return Promise.resolve(false);
  if (!pgReady) {
    pgReady = pgPool
      .query(
        `CREATE TABLE IF NOT EXISTS webshell_files (
           path TEXT PRIMARY KEY,
           content TEXT NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      )
      .then(() => true)
      .catch((e) => {
        console.error('[persist] failed to create webshell_files table:', e.message);
        pgReady = null; // allow retry on next op
        return false;
      });
  }
  return pgReady;
}

async function persistWrite(p, b64Content) {
  if (!pgPool) return;
  const ok = await ensurePgSchema();
  if (!ok) return;
  try {
    await pgPool.query(
      `INSERT INTO webshell_files (path, content, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (path) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
      [p, b64Content]
    );
  } catch (e) {
    console.error('[persist] write failed for', p, e.message);
  }
}

async function persistDelete(p) {
  if (!pgPool) return;
  const ok = await ensurePgSchema();
  if (!ok) return;
  try {
    // Covers both the exact file and, for directories, anything nested
    // under it (path + '/%').
    await pgPool.query(`DELETE FROM webshell_files WHERE path = $1 OR path LIKE $2`, [p, `${p}/%`]);
  } catch (e) {
    console.error('[persist] delete failed for', p, e.message);
  }
}

async function persistRename(src, dst) {
  if (!pgPool) return;
  const ok = await ensurePgSchema();
  if (!ok) return;
  try {
    await pgPool.query(`UPDATE webshell_files SET path = $2 WHERE path = $1`, [src, dst]);
    await pgPool.query(
      `UPDATE webshell_files SET path = $2 || substring(path from length($1) + 1) WHERE path LIKE $3`,
      [src, dst, `${src}/%`]
    );
  } catch (e) {
    console.error('[persist] rename failed for', src, '->', dst, e.message);
  }
}

async function persistLookup(p) {
  if (!pgPool) return null;
  const ok = await ensurePgSchema();
  if (!ok) return null;
  try {
    const res = await pgPool.query(`SELECT content FROM webshell_files WHERE path = $1`, [p]);
    return res.rows[0] ? res.rows[0].content : null;
  } catch (e) {
    console.error('[persist] lookup failed for', p, e.message);
    return null;
  }
}

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

// ---- Full-tree persistence for local mode -------------------------------
// Editor saves go through fs:write above and are mirrored per-file. But
// terminal commands (touch, echo >, mv, rm, a script writing output, etc.)
// touch the filesystem directly via the pty shell and never go through
// fs:write at all. So in local mode (the only mode where Node can see the
// real, shared filesystem — docker mode's containers are each private and
// thrown away), we also periodically walk the whole home directory, mirror
// any new/changed files to Neon, and remove DB rows for files that vanished
// locally (e.g. `rm`'d from the terminal). On startup we restore everything
// Neon knows about back onto disk first, since a fresh deploy means an
// empty filesystem.
const LOCAL_PERSIST_ROOT = MODE === 'local' ? (dropUser ? dropUser.home : process.env.HOME || os.homedir()) : null;
const PERSIST_SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', '.npm']);
const PERSIST_SYNC_INTERVAL_MS = 5000;
const PERSIST_DEBOUNCE_MS = 1200; // sync shortly after terminal output goes quiet

// relPath -> mtimeMs, so we only re-read/re-upload files that actually changed.
const knownFileState = new Map();

async function walkTree(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (PERSIST_SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

let syncInFlight = false;
async function syncLocalTreeToDb() {
  if (!pgPool || !LOCAL_PERSIST_ROOT || syncInFlight) return;
  syncInFlight = true;
  try {
    const ok = await ensurePgSchema();
    if (!ok) return;
    const files = await walkTree(LOCAL_PERSIST_ROOT);
    const seen = new Set();
    for (const full of files) {
      seen.add(full);
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      if (st.size > FS_MAX_FILE_BYTES) continue;
      const prevMtime = knownFileState.get(full);
      if (prevMtime === st.mtimeMs) continue; // unchanged since last sync
      try {
        const data = await fsp.readFile(full);
        await persistWrite(full, data.toString('base64'));
        knownFileState.set(full, st.mtimeMs);
      } catch (e) {
        console.error('[persist] tree sync read/write failed for', full, e.message);
      }
    }
    // Anything we knew about last time but didn't see this walk was deleted.
    for (const prevPath of knownFileState.keys()) {
      if (!seen.has(prevPath)) {
        knownFileState.delete(prevPath);
        await persistDelete(prevPath);
      }
    }
  } catch (e) {
    console.error('[persist] tree sync failed:', e.message);
  } finally {
    syncInFlight = false;
  }
}

async function restoreLocalTreeFromDb() {
  if (!pgPool || !LOCAL_PERSIST_ROOT) return;
  const ok = await ensurePgSchema();
  if (!ok) return;
  try {
    const res = await pgPool.query(
      `SELECT path, content FROM webshell_files WHERE path LIKE $1`,
      [`${LOCAL_PERSIST_ROOT}/%`]
    );
    for (const row of res.rows) {
      try {
        const data = Buffer.from(row.content, 'base64');
        await fsp.mkdir(path.dirname(row.path), { recursive: true });
        await fsp.writeFile(row.path, data);
        const st = await fsp.stat(row.path);
        knownFileState.set(row.path, st.mtimeMs);
      } catch (e) {
        console.error('[persist] restore failed for', row.path, e.message);
      }
    }
    console.log(`persistence: restored ${res.rows.length} file(s) from Neon into ${LOCAL_PERSIST_ROOT}`);
  } catch (e) {
    console.error('[persist] restore-all failed:', e.message);
  }
}

let debounceTimer = null;
function scheduleDebouncedSync() {
  if (!pgPool || !LOCAL_PERSIST_ROOT) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(syncLocalTreeToDb, PERSIST_DEBOUNCE_MS);
}

if (pgPool && LOCAL_PERSIST_ROOT) {
  setInterval(syncLocalTreeToDb, PERSIST_SYNC_INTERVAL_MS).unref();
  const finalSync = () => {
    syncLocalTreeToDb().finally(() => process.exit(0));
  };
  process.on('SIGTERM', finalSync);
  process.on('SIGINT', finalSync);
}


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

// ---- File manager / editor backend -----------------------------------
// Same trust boundary as the terminal itself: docker-mode ops run inside
// that session's own throwaway container (via `docker exec`, arguments
// passed as an argv array — never interpolated into a shell string), and
// local-mode ops touch the host directly, exactly like the pty shell
// already does. This doesn't grant any capability the user doesn't
// already have through the terminal; it's just a friendlier UI over it.
const FS_EXEC_TIMEOUT_MS = 15000;
const FS_MAX_FILE_BYTES = 3 * 1024 * 1024;

const PY_LIST = `
import sys, os, json
p = sys.argv[1]
try:
    entries = []
    with os.scandir(p) as it:
        for e in it:
            try:
                st = e.stat(follow_symlinks=False)
                is_link = e.is_symlink()
                is_dir = e.is_dir(follow_symlinks=True)
                entries.append({"name": e.name, "isDir": is_dir, "isSymlink": is_link,
                                 "size": st.st_size, "mtime": int(st.st_mtime)})
            except OSError:
                pass
    entries.sort(key=lambda x: (not x["isDir"], x["name"].lower()))
    print(json.dumps({"ok": True, "path": os.path.abspath(p), "entries": entries}))
except Exception as ex:
    print(json.dumps({"ok": False, "error": str(ex)}))
`;

const PY_READ = `
import sys, os, json, base64
p = sys.argv[1]
MAX = ${FS_MAX_FILE_BYTES}
try:
    size = os.path.getsize(p)
    if size > MAX:
        print(json.dumps({"ok": False, "error": "file too large to open (%d bytes, max %d)" % (size, MAX)}))
    else:
        with open(p, "rb") as f:
            data = f.read()
        is_text = True
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            is_text = False
        print(json.dumps({"ok": True, "content": base64.b64encode(data).decode("ascii"), "isText": is_text, "size": size}))
except Exception as ex:
    print(json.dumps({"ok": False, "error": str(ex)}))
`;

const PY_WRITE = `
import sys, os, json, base64
p = sys.argv[1]
try:
    raw = sys.stdin.buffer.read()
    data = base64.b64decode(raw)
    d = os.path.dirname(p)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)
    print(json.dumps({"ok": True, "size": len(data)}))
except Exception as ex:
    print(json.dumps({"ok": False, "error": str(ex)}))
`;

const PY_MKDIR = `
import sys, os, json
p = sys.argv[1]
try:
    os.makedirs(p, exist_ok=True)
    print(json.dumps({"ok": True}))
except Exception as ex:
    print(json.dumps({"ok": False, "error": str(ex)}))
`;

const PY_RM = `
import sys, os, json, shutil
p = sys.argv[1]
try:
    if os.path.isdir(p) and not os.path.islink(p):
        shutil.rmtree(p)
    else:
        os.remove(p)
    print(json.dumps({"ok": True}))
except Exception as ex:
    print(json.dumps({"ok": False, "error": str(ex)}))
`;

const PY_RENAME = `
import sys, os, json
src, dst = sys.argv[1], sys.argv[2]
try:
    os.rename(src, dst)
    print(json.dumps({"ok": True}))
except Exception as ex:
    print(json.dumps({"ok": False, "error": str(ex)}))
`;

function dockerExecPy(containerName, script, args, stdinB64) {
  return new Promise((resolve) => {
    const dockerArgs = ['exec', ...(stdinB64 != null ? ['-i'] : []), containerName, 'python3', '-c', script, ...args];
    const child = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ ok: false, error: 'timed out' });
      }
    }, FS_EXEC_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        const line = out.trim().split('\n').pop();
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: (err || out || 'no output').trim().slice(0, 500) });
      }
    });
    if (stdinB64 != null) {
      child.stdin.write(stdinB64);
    }
    child.stdin.end();
  });
}

// ---- Local-mode fs helpers (direct host access, same trust level as the
// pty shell in local mode — no extra confinement is added here). --------
async function localList(p) {
  const names = await fsp.readdir(p);
  const entries = [];
  for (const name of names) {
    const full = path.join(p, name);
    try {
      const lst = await fsp.lstat(full);
      const isSymlink = lst.isSymbolicLink();
      const st = isSymlink ? await fsp.stat(full).catch(() => lst) : lst;
      entries.push({
        name,
        isDir: st.isDirectory(),
        isSymlink,
        size: st.size,
        mtime: Math.floor(st.mtimeMs / 1000),
      });
    } catch {
      /* skip unreadable entries */
    }
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { ok: true, path: path.resolve(p), entries };
}
async function localRead(p) {
  const st = await fsp.stat(p);
  if (st.size > FS_MAX_FILE_BYTES) {
    return { ok: false, error: `file too large to open (${st.size} bytes, max ${FS_MAX_FILE_BYTES})` };
  }
  const data = await fsp.readFile(p);
  let isText = true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    isText = false;
  }
  return { ok: true, content: data.toString('base64'), isText, size: st.size };
}
async function localWrite(p, b64) {
  const data = Buffer.from(b64, 'base64');
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, data);
  return { ok: true, size: data.length };
}
async function localMkdir(p) {
  await fsp.mkdir(p, { recursive: true });
  return { ok: true };
}
async function localRm(p) {
  await fsp.rm(p, { recursive: true, force: false });
  return { ok: true };
}
async function localRename(src, dst) {
  await fsp.rename(src, dst);
  return { ok: true };
}

async function handleFsOp(ws, msg, fsCtx) {
  const { op, reqId } = msg;
  let result;
  try {
    if (fsCtx.mode === 'docker') {
      switch (op) {
        case 'list':
          result = await dockerExecPy(fsCtx.name, PY_LIST, [msg.path]);
          break;
        case 'read':
          result = await dockerExecPy(fsCtx.name, PY_READ, [msg.path]);
          if (!result.ok && pgPool) {
            // Fresh container (or file just never existed here) — see if
            // Neon has a copy from a previous session and restore it.
            const restored = await persistLookup(msg.path);
            if (restored != null) {
              const writeBack = await dockerExecPy(fsCtx.name, PY_WRITE, [msg.path], restored);
              if (writeBack.ok) {
                result = await dockerExecPy(fsCtx.name, PY_READ, [msg.path]);
              }
            }
          }
          break;
        case 'write':
          result = await dockerExecPy(fsCtx.name, PY_WRITE, [msg.path], msg.content || '');
          if (result.ok) await persistWrite(msg.path, msg.content || '');
          break;
        case 'mkdir':
          result = await dockerExecPy(fsCtx.name, PY_MKDIR, [msg.path]);
          break;
        case 'rm':
          result = await dockerExecPy(fsCtx.name, PY_RM, [msg.path]);
          if (result.ok) await persistDelete(msg.path);
          break;
        case 'rename':
          result = await dockerExecPy(fsCtx.name, PY_RENAME, [msg.path, msg.newPath]);
          if (result.ok) await persistRename(msg.path, msg.newPath);
          break;
        default:
          result = { ok: false, error: 'unknown op' };
      }
    } else {
      switch (op) {
        case 'list':
          result = await localList(msg.path);
          break;
        case 'read':
          result = await localRead(msg.path);
          if (!result.ok && pgPool) {
            const restored = await persistLookup(msg.path);
            if (restored != null) {
              const writeBack = await localWrite(msg.path, restored).catch((e) => ({
                ok: false,
                error: e.message,
              }));
              if (writeBack.ok) {
                result = await localRead(msg.path);
              }
            }
          }
          break;
        case 'write':
          result = await localWrite(msg.path, msg.content || '');
          if (result.ok) await persistWrite(msg.path, msg.content || '');
          break;
        case 'mkdir':
          result = await localMkdir(msg.path);
          break;
        case 'rm':
          result = await localRm(msg.path);
          if (result.ok) await persistDelete(msg.path);
          break;
        case 'rename':
          result = await localRename(msg.path, msg.newPath);
          if (result.ok) await persistRename(msg.path, msg.newPath);
          break;
        default:
          result = { ok: false, error: 'unknown op' };
      }
    }
  } catch (e) {
    result = { ok: false, error: e && e.message ? e.message : String(e) };
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'fs:result', reqId, ...result }));
  }
}

function wireTerm(ws, term, sessionState, fsCtx) {
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
    scheduleDebouncedSync();
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
    } else if (msg.type === 'fs' && fsCtx) {
      handleFsOp(ws, msg, fsCtx);
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
      ...SANDBOX_ENV_PASSTHROUGH.flatMap((name) =>
        process.env[name] !== undefined ? ['-e', `${name}=${process.env[name]}`] : []
      ),
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
    wireTerm(ws, term, sessionState, { mode: 'docker', name });
    ws.send(JSON.stringify({ type: 'fs:home', path: '/home/sandbox' }));

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
          ...(ENABLE_DESKTOP
            ? { DISPLAY: DISPLAY_NUM, SDL_VIDEODRIVER: 'x11', SDL_AUDIODRIVER: 'dummy' }
            : {}),
        }
      : {
          ...process.env,
          ...(ENABLE_DESKTOP
            ? { DISPLAY: DISPLAY_NUM, SDL_VIDEODRIVER: 'x11', SDL_AUDIODRIVER: 'dummy' }
            : {}),
        };

    const term = pty.spawn(SHELL, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: dropUser ? dropUser.home : process.env.HOME || process.cwd(),
      env: spawnEnv,
      ...(dropUser ? { uid: dropUser.uid, gid: dropUser.gid } : {}),
    });

    const localHome = dropUser ? dropUser.home : process.env.HOME || os.homedir();
    wireTerm(ws, term, null, { mode: 'local' });
    ws.send(JSON.stringify({ type: 'fs:home', path: localHome }));

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

server.listen(PORT, HOST, async () => {
  console.log(`web terminal listening on http://${HOST}:${PORT}`);
  console.log(`mode: ${MODE}`);
  if (pgPool) {
    console.log('persistence: DATABASE_URL set, connecting to Neon/Postgres...');
    const ok = await ensurePgSchema();
    if (ok) {
      console.log('persistence: connected, webshell_files table ready');
      if (LOCAL_PERSIST_ROOT) {
        await restoreLocalTreeFromDb();
      }
    } else {
      console.error('persistence: FAILED to connect/create table — saves will NOT persist. Check DATABASE_URL.');
    }
  } else {
    console.log('persistence: DATABASE_URL not set — saves will NOT survive a restart');
  }
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
