// Phone notifications through ntfy (ntfy.sh, free, no account): once a day the server checks
//   - that your SerienStream login still leads to German hoster links, and
//   - that each provider still gives streams that actually start playing, for a few well-known titles,
// and sends a message only when something breaks (and again when it works again).
// The channel name is derived from this Oracle machine's private id, so it is not in the public repository;
// /notify/test?token=<admin password> shows it and sends a test message.
'use strict';

const crypto = require('crypto');
const NTFY = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
let topic = process.env.NTFY_TOPIC || null;
const state = { lastRun: null, sto: 'unknown', stoFails: 0, providers: {}, sent: [] };

async function getTopic() {
    if (topic) return topic;
    const key = await require('./sto-session.js').keyOfMachine();
    topic = 'gpa-' + crypto.createHash('sha256').update(Buffer.concat([Buffer.from('ntfy|'), key])).digest('hex').slice(0, 24);
    return topic;
}

async function send(title, message, tags = 'warning') {
    const t = await getTopic();
    const f = require('./net.js').nativeFetch;
    const r = await f(`${NTFY}/${t}`, { method: 'POST', body: message, headers: { Title: title, Tags: tags, Priority: tags === 'warning' ? '4' : '3' }, signal: AbortSignal.timeout(15000) });
    state.sent.unshift(`${new Date().toISOString()} ${title}`);
    state.sent.length = Math.min(state.sent.length, 10);
    return r.ok;
}

// checks: { stoCheck: async () => true|false|null (null = no login set), providerCounts: async () => ({ id: streams }) }
async function run(checks, log = () => {}) {
    state.lastRun = new Date().toISOString();
    try {
        const ok = await checks.stoCheck();
        if (ok === null) state.sto = 'no login';
        else if (ok === true) {
            if (state.sto === 'broken' || state.sto === 'check') await send('SerienStream works again', 'SerienStream gives the addon hoster links again.', 'white_check_mark');
            state.sto = 'ok'; state.stoFails = 0;
        } else {
            state.stoFails++;
            // twice in a row (one check now, one an hour later), so a single hiccup doesn't wake you
            if (ok === 'check') {
                // logged in fine, but s.to shows its human check to the server: nothing to do on your side
                if (state.stoFails >= 2 && state.sto !== 'check') {
                    state.sto = 'check';
                    await send('SerienStream paused',
                        "s.to is showing its human check to the server right now (your login is fine). SerienStream links are missing until s.to stops; you'll get a message when it works again.");
                }
            } else if (state.stoFails >= 2 && state.sto !== 'broken') {
                state.sto = 'broken';
                await send('SerienStream login stopped working',
                    'SerienStream no longer accepts the saved login. Copy a fresh cookie into https://fortune-addon.duckdns.org/sto/session and upload the new sto-session.enc to GitHub.');
            }
        }
    } catch (e) { log(`notify: SerienStream check failed: ${e.message}`); }
    try {
        const counts = await checks.providerCounts();
        const down = [], back = [];
        for (const [id, n] of Object.entries(counts)) {
            const prev = state.providers[id];
            if (prev && prev.n > 0 && n === 0) down.push(id);
            if (prev && prev.n === 0 && prev.alerted && n > 0) back.push(id);
            state.providers[id] = { n, alerted: n === 0 && (prev && (prev.alerted || prev.n > 0)) };
        }
        if (down.length) await send(`Provider stopped working: ${down.join(', ')}`, `${down.join(', ')} gave no working stream for the test titles today (they did before): nothing found, or nothing that plays. Ask Claude to look at it.`);
        if (back.length) await send(`Provider working again: ${back.join(', ')}`, `${back.join(', ')} gives working streams again.`, 'white_check_mark');
    } catch (e) { log(`notify: provider check failed: ${e.message}`); }
    return state;
}

module.exports = { run, send, getTopic, state };
