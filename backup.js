// Backups of the addon's memory (STATE_DIR) to a private GitHub repository of yours, away from the Oracle server.
//
// What is saved: everything in STATE_DIR (stream health record, SerienStream link memory + availability history +
// last working answers, notification state, Plex link, WARP account), except this module's own settings.
// How: once a day (and on demand) the files are packed, compressed and encrypted (AES-256-GCM) with a backup key
// that you keep; the result goes to <repo>/backups/latest.bin and a rolling copy per weekday (7 days of history).
// GitHub only ever sees encrypted data.
//
// Setup (/backup, admin password): a fine-grained GitHub token limited to that one private repository
// ("Contents: read and write") and the repository name. The page shows the backup key once: keep it (password
// manager or a note). Without it a backup can't be opened, by anyone.
//
// Restore test (/backup/test, no password needed, nothing changed): the newest backup is downloaded, decrypted,
// checked file by file, unpacked into a scratch folder and loaded there by the addon's own modules in a separate
// process — the same code that reads the memory at start-up — and the counts are compared with the running addon.
//
// Restore (/backup, admin password + backup key): the backup is checked, put aside, and moved into place at the
// next start, before anything reads the memory; then the addon restarts by itself (Docker starts it again).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DIR = process.env.STATE_DIR || path.join(os.homedir(), '.german-addon');
const CONFIG = path.join(DIR, 'backup-config.json');
const PENDING = path.join(DIR, 'restore-pending');
const SKIP = new Set(['backup-config.json', 'restore-pending']);
const API = process.env.GITHUB_API || 'https://api.github.com';
const fetch = (...a) => require('./net.js').nativeFetch(...a);   // plain connection, not the WARP/Chrome layer

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) {}
const state = { last: null, lastError: null, lastTest: null };
function saveConfig() { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(config), { mode: 0o600 }); }

// ---------- packing ----------
function collect(dir = DIR, prefix = '') {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return out; }
    for (const n of names) {
        if (!prefix && SKIP.has(n)) continue;
        const p = path.join(dir, n), rel = prefix + n;
        const st = fs.statSync(p);
        if (st.isDirectory()) Object.assign(out, collect(p, rel + '/'));
        else if (st.isFile() && st.size < 50 * 1048576) out[rel] = fs.readFileSync(p);
    }
    return out;
}
function pack(files, meta) {
    const manifest = { v: 1, at: new Date().toISOString(), meta, files: {} };
    for (const [n, b] of Object.entries(files)) manifest.files[n] = { sha256: crypto.createHash('sha256').update(b).digest('hex'), data: b.toString('base64') };
    return zlib.gzipSync(Buffer.from(JSON.stringify(manifest)), { level: 9 });
}
function encrypt(buf, keyHex) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    const body = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([Buffer.from('GPAB1'), iv, c.getAuthTag(), body]);
}
function decrypt(buf, keyHex) {
    if (buf.subarray(0, 5).toString() !== 'GPAB1') throw new Error('not an addon backup');
    const iv = buf.subarray(5, 17), tag = buf.subarray(17, 33);
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    d.setAuthTag(tag);
    try { return Buffer.concat([d.update(buf.subarray(33)), d.final()]); } catch (e) { throw new Error('wrong backup key or damaged backup'); }
}
// -> { at, meta, files: { name: Buffer } }, every file checked against its checksum
function unpack(gz) {
    const m = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
    const files = {};
    for (const [n, f] of Object.entries(m.files || {})) {
        if (n.includes('..') || path.isAbsolute(n)) throw new Error(`bad file name in backup: ${n}`);
        const b = Buffer.from(f.data, 'base64');
        if (crypto.createHash('sha256').update(b).digest('hex') !== f.sha256) throw new Error(`checksum mismatch: ${n}`);
        files[n] = b;
    }
    return { at: m.at, meta: m.meta, files };
}

// ---------- GitHub ----------
async function gh(method, p, body) {
    const r = await fetch(`${API}/repos/${config.repo}/contents/${p}`, {
        method, signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'german-providers-addon', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { status: r.status, j };
}
async function put(p, buf, message) {
    const cur = await gh('GET', p);
    const r = await gh('PUT', p, { message, content: buf.toString('base64'), sha: cur.status === 200 && cur.j ? cur.j.sha : undefined });
    if (r.status !== 200 && r.status !== 201) throw new Error(`GitHub ${r.status}: ${(r.j && r.j.message) || 'upload failed'}`);
}
async function download(p = 'backups/latest.bin') {
    const meta = await gh('GET', p);
    if (meta.status !== 200 || !meta.j) throw new Error(`GitHub ${meta.status}: ${(meta.j && meta.j.message) || 'no backup found'}`);
    if (meta.j.content && meta.j.encoding === 'base64' && meta.j.size < 900000) return Buffer.from(meta.j.content, 'base64');
    // bigger files: GitHub gives the content through the blob address
    const r = await fetch(meta.j.git_url, { headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'german-providers-addon' }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`GitHub blob ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
}

const configured = () => !!(config.token && config.repo && config.key);

async function backupNow(meta = {}) {
    if (!configured()) throw new Error('backups are not set up yet (/backup)');
    const files = collect();
    const blob = encrypt(pack(files, meta), config.key);
    const day = new Date().getUTCDay();
    await put('backups/latest.bin', blob, `backup ${new Date().toISOString()}`);
    await put(`backups/day-${day}.bin`, blob, `backup ${new Date().toISOString()} (weekday ${day})`);
    state.last = { at: new Date().toISOString(), files: Object.keys(files).length, bytes: blob.length };
    state.lastError = null;
    config.lastBackup = state.last; saveConfig();
    return state.last;
}

// ---------- restore test: unpack into a scratch folder and load it with the addon's own modules ----------
const LOADER = `
const p = process.env.STATE_DIR;
const out = {};
const health = require(process.argv[1] + '/health.js'); out.health = health.summary().tracked;
const sto = require(process.argv[1] + '/sto-access.js');
sto.init({ nativeFetch: () => Promise.reject(new Error('offline')), smartFetch: () => Promise.reject(new Error('offline')), trace() {}, plainHeaders: h => Object.assign({}, h), session: { forHost: () => '', update() {} } });
const st = sto.status(); out.stoLinks = st.remembered.playLinks; out.stoEpisodes = st.remembered.episodes; out.stoEvents = (st.recentEvents || []).length; out.stoAvail7d = st.availabilityPercent['7d'];
out.plexLinked = require(process.argv[1] + '/plex.js').status().linked;
out.notifyKeys = Object.keys(require(process.argv[1] + '/notify.js').state || {}).length;
process.stdout.write(JSON.stringify(out)); process.exit(0);
`;
function loadIn(dir) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e', LOADER, __dirname], { env: Object.assign({}, process.env, { STATE_DIR: dir, WARP: '0' }), timeout: 30000 },
            (err, stdout, stderr) => { if (err) return reject(new Error(`loading the restored copy failed: ${String(stderr || err.message).slice(0, 200)}`)); try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('loading the restored copy gave no result')); } });
    });
}
async function restoreTest(live) {
    if (!configured()) throw new Error('backups are not set up yet');
    const t = Date.now();
    const blob = await download();
    const b = unpack(decrypt(blob, config.key));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpa-restore-test-'));
    try {
        for (const [n, buf] of Object.entries(b.files)) { fs.mkdirSync(path.dirname(path.join(tmp, n)), { recursive: true }); fs.writeFileSync(path.join(tmp, n), buf); }
        const restored = await loadIn(tmp);
        state.lastTest = { at: new Date().toISOString(), ok: true, backupFrom: b.at, files: Object.keys(b.files), restored, live, ms: Date.now() - t };
        return state.lastTest;
    } catch (e) {
        state.lastTest = { at: new Date().toISOString(), ok: false, error: e.message };
        throw e;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- real restore ----------
async function prepareRestore(keyHex, access = {}) {
    // on a new server: the repository and token come with the restore request
    if (access.token || access.repo) setup(access, { noKey: true });   // the key comes with the restore, never a new one here
    if (!config.token || !config.repo) throw new Error('enter the GitHub repository and token as well (this server has none saved)');
    const b = unpack(decrypt(await download(), keyHex || config.key));
    fs.rmSync(PENDING, { recursive: true, force: true });
    for (const [n, buf] of Object.entries(b.files)) { fs.mkdirSync(path.dirname(path.join(PENDING, n)), { recursive: true }); fs.writeFileSync(path.join(PENDING, n), buf); }
    if (keyHex && keyHex !== config.key) { config.key = keyHex; saveConfig(); }
    return { backupFrom: b.at, files: Object.keys(b.files).length };
}
// at start-up, before any module reads its memory
function applyPendingRestore(log = () => {}) {
    if (!fs.existsSync(PENDING)) return false;
    const move = (from, rel = '') => {
        for (const n of fs.readdirSync(from)) {
            const p = path.join(from, n), to = path.join(DIR, rel, n);
            if (fs.statSync(p).isDirectory()) { fs.mkdirSync(to, { recursive: true }); move(p, path.join(rel, n)); }
            else fs.copyFileSync(p, to);
        }
    };
    move(PENDING);
    fs.rmSync(PENDING, { recursive: true, force: true });
    log('restored the addon memory from the backup');
    return true;
}

// ---------- setup ----------
function setup({ token, repo }, opts = {}) {
    if (token) config.token = token.trim();
    if (repo) config.repo = repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    let newKey = null;
    if (!config.key && !opts.noKey) { config.key = crypto.randomBytes(32).toString('hex'); newKey = config.key; }
    saveConfig();
    return newKey;
}

let timer = null;
function schedule(log = () => {}) {
    if (timer) return;
    const tick = async () => {
        const last = config.lastBackup ? Date.parse(config.lastBackup.at) : 0;
        if (configured() && Date.now() - last > 23 * 3600e3) {
            try { const r = await backupNow({ reason: 'daily' }); log(`backup saved: ${r.files} files, ${Math.round(r.bytes / 1024)} KB`); }
            catch (e) { state.lastError = { at: new Date().toISOString(), error: e.message }; log(`backup failed: ${e.message}`); }
        }
    };
    setTimeout(tick, 10 * 60e3).unref();                 // 10 minutes after a start, if the last one is a day old
    timer = setInterval(tick, 60 * 60e3); timer.unref(); // then checked hourly
}

function status() {
    return { setUp: configured(), repo: config.repo || null, lastBackup: config.lastBackup || null, lastError: state.lastError, lastRestoreTest: state.lastTest, restorePending: fs.existsSync(PENDING) };
}

module.exports = { backupNow, restoreTest, prepareRestore, applyPendingRestore, setup, schedule, status, configured, _pack: pack, _unpack: unpack, _encrypt: encrypt, _decrypt: decrypt, _collect: collect, _reload: () => { try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { config = {}; } } };
