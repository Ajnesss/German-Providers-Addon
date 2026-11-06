// Your own SerienStream (s.to) login for the addon.
// Logged-in members get hoster links without the human check (tested by Fortune). The addon never logs in itself
// and never sees your password: you copy your browser's s.to cookie once into /sto/session on your own server.
// The addon then sends it with its s.to requests, exactly like your browser does.
//
// Keeping it across updates: the server encrypts the cookie with a key only this Oracle machine knows (its instance
// id from Oracle's metadata service, which is not public) and shows you the result to save as sto-session.enc in the
// repository. On every start it reads that file back. Anyone else only sees unreadable data.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const HOSTS = /(^|\.)(serienstream\.(to|cx)|s\.to)$/i;
const FILE = path.join(__dirname, 'sto-session.enc');

let cookie = '';        // "name=value; name2=value2"
let source = 'none';

// Cloudflare's own cookies belong to your browser and its internet address; never send those from the server
const clean = c => String(c || '').split(';').map(x => x.trim()).filter(x => x && x.includes('=') && !/^(cf_clearance|__cf|_cfuvid|cf_chl)/i.test(x)).join('; ');

let machineKey = null;
async function keyOfMachine() {
    if (machineKey) return machineKey;
    if (process.env.STO_SESSION_KEY) return (machineKey = crypto.createHash('sha256').update(process.env.STO_SESSION_KEY).digest());
    const f = require('./net.js').nativeFetch;
    const r = await f('http://169.254.169.254/opc/v2/instance/id', { headers: { Authorization: 'Bearer Oracle' }, signal: AbortSignal.timeout(2500) });
    const id = (await r.text()).trim();
    if (!r.ok || !/^ocid1\./.test(id)) throw new Error('no Oracle instance id');
    return (machineKey = crypto.createHash('sha256').update('gpa-sto-session|' + id).digest());
}
async function encrypt(text) {
    const key = await keyOfMachine();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}
async function decrypt(blob) {
    const e = JSON.parse(blob);
    const d = crypto.createDecipheriv('aes-256-gcm', await keyOfMachine(), Buffer.from(e.iv, 'base64'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
}

async function load() {
    if (process.env.STO_COOKIE) { cookie = clean(process.env.STO_COOKIE); source = 'settings'; return; }
    try {
        if (fs.existsSync(FILE)) { cookie = clean(await decrypt(fs.readFileSync(FILE, 'utf8'))); source = 'sto-session.enc'; }
    } catch (e) { source = `sto-session.enc unreadable (${e.message})`; }
}

// a fresh login cookie from the entry page; returns the encrypted copy to keep, if this machine can make one
async function set(raw) {
    cookie = clean(raw);
    source = 'entered';
    try { return await encrypt(cookie); } catch (e) { return null; }
}

// s.to renews its session cookie now and then: keep the newest values in memory
function update(setCookieLines) {
    if (!cookie || !setCookieLines || !setCookieLines.length) return;
    const jar = new Map(cookie.split('; ').map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
    for (const line of setCookieLines) {
        const m = String(line).match(/^\s*([^=;\s]+)=([^;]*)/);
        if (!m || /^(cf_clearance|__cf|_cfuvid)/i.test(m[1])) continue;
        if (/expires=Thu, 01 Jan 1970|max-age=0/i.test(line) || m[2] === 'deleted') jar.delete(m[1]); else jar.set(m[1], m[2]);
    }
    cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

const forHost = host => (cookie && (HOSTS.test(String(host || '').replace(/^www\./, '')) || (process.env.STO_TEST_HOST && host === process.env.STO_TEST_HOST))) ? cookie : '';

module.exports = { keyOfMachine, load, set, update, forHost, status: () => ({ loggedIn: !!cookie, source, names: cookie ? cookie.split('; ').map(x => x.split('=')[0]) : [] }), HOSTS, _clean: clean };
