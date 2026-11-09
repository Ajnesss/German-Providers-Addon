// Plex (free films and shows with ads) — step 1: linking your Plex account and looking at the catalogue.
//
// Linking uses Plex's own "link a device" sign-in: the server asks Plex for a PIN, you open the Plex page it shows,
// sign in there yourself and allow "German Providers". Plex then hands the server a token for your account.
// The token is kept on the server only (STATE_DIR/plex.json, readable by the addon only) and is never shown or sent
// anywhere except to Plex.
//
// Nothing is added to the streams yet. For the first 48 hours after linking, /plex/try lets the catalogue be
// examined from the server (Germany): read-only GET requests to Plex's catalogue servers, at most 120 an hour.
// That shows which free titles exist in Germany, which of them are copy-protected and which have German audio,
// before any stream source is built on it.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(process.env.STATE_DIR || path.join(os.homedir(), '.german-addon'), 'plex.json');
const PRODUCT = 'German Providers';
const TRY_HOURS = 48;
const TRY_PER_HOUR = 120;
const TRY_HOSTS = ['discover.provider.plex.tv', 'metadata.provider.plex.tv', 'vod.provider.plex.tv', 'epg.provider.plex.tv', 'plex.tv'];

let state = { clientId: null, token: null, linkedAt: 0, pin: null };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) {}
if (!state.clientId) state.clientId = 'gpa-' + crypto.randomBytes(12).toString('hex');
function save() {
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state), { mode: 0o600 }); } catch (e) {}
}
save();

const headers = extra => Object.assign({
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': '1.0',
    'X-Plex-Client-Identifier': state.clientId,
    'X-Plex-Platform': 'Web',
    'X-Plex-Device': 'Server',
    'X-Plex-Language': 'de',
}, state.token ? { 'X-Plex-Token': state.token } : {}, extra || {});

// start linking: a PIN + the Plex page where you approve it
async function startLink(fetchFn) {
    const h = headers(); delete h['X-Plex-Token'];
    const r = await fetchFn('https://plex.tv/api/v2/pins?strong=true', { method: 'POST', headers: h });
    const d = JSON.parse(await r.text());
    if (!d.id || !d.code) throw new Error(`Plex PIN: HTTP ${r.status}`);
    state.pin = { id: d.id, code: d.code, at: Date.now() };
    save();
    const q = new URLSearchParams({ clientID: state.clientId, code: d.code, 'context[device][product]': PRODUCT });
    return `https://app.plex.tv/auth#?${q.toString()}`;
}
// after you approved: fetch the token for the PIN
async function finishLink(fetchFn) {
    if (!state.pin) return { linked: !!state.token };
    const h = headers(); delete h['X-Plex-Token'];
    const r = await fetchFn(`https://plex.tv/api/v2/pins/${state.pin.id}`, { headers: h });
    const d = JSON.parse(await r.text());
    if (d.authToken) {
        state.token = d.authToken; state.linkedAt = Date.now(); state.pin = null; save();
        return { linked: true };
    }
    return { linked: false, waiting: true };
}
function unlink() { state.token = null; state.linkedAt = 0; state.pin = null; save(); }

const tries = [];
function tryAllowed() {
    if (!state.token) return 'Plex is not linked';
    if (Date.now() - state.linkedAt > TRY_HOURS * 3600e3) return `catalogue look-ups are only open for ${TRY_HOURS} hours after linking`;
    const cut = Date.now() - 3600e3;
    while (tries.length && tries[0] < cut) tries.shift();
    if (tries.length >= TRY_PER_HOUR) return 'too many look-ups this hour';
    return null;
}
// read-only look at Plex's catalogue from the server: GET only, Plex catalogue hosts only, token never echoed
async function tryGet(fetchFn, target) {
    const no = tryAllowed();
    if (no) return { error: no };
    let u;
    try { u = new URL(target); } catch (e) { return { error: 'not a URL' }; }
    if (u.protocol !== 'https:' || !TRY_HOSTS.includes(u.host)) return { error: 'only Plex catalogue addresses' };
    if (u.host === 'plex.tv' && u.pathname !== '/api/v2/geoip') return { error: 'only plex.tv/api/v2/geoip on plex.tv' };
    u.searchParams.delete('X-Plex-Token');
    tries.push(Date.now());
    const r = await fetchFn(u.toString(), { headers: headers() });
    let text = await r.text();
    text = text.split(state.token).join('<token>');
    return { status: r.status, type: r.headers.get('content-type'), length: text.length, body: text.slice(0, 60000) };
}

function status() {
    return { linked: !!state.token, linkedAt: state.linkedAt ? new Date(state.linkedAt).toISOString() : null,
        tryOpenUntil: state.token ? new Date(state.linkedAt + TRY_HOURS * 3600e3).toISOString() : null, waitingForApproval: !!state.pin };
}

module.exports = { startLink, finishLink, unlink, tryGet, status, headers, token: () => state.token };
