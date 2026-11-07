// SerienStream (s.to) access layer: every request the addon sends to s.to with your login goes through here.
//
// What s.to does: an episode page lists its hoster buttons; each button is a "play link" (/r?t=...). For a trusted
// visitor s.to answers a play link with a redirect to the hoster (VOE, ...). At times it instead answers with its
// human check (a small page that hands the link to the site's Turnstile box). Only a real browser can pass that box,
// so the addon never tries to. This layer makes sure the addon
//   - asks s.to as little as possible: pages and play-link answers are reused, identical requests share one answer,
//   - asks politely: at most 2 requests at a time, spaced out, the viewer's own requests before background ones,
//   - pauses cleanly when the check appears and resumes on its own as soon as s.to answers normally again,
//   - keeps a record of when s.to worked, when it showed the check and for how long, and what the addon had sent
//     just before (to find out what, if anything, makes it appear), plus whether the login itself is still valid.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const MIN = 60000, HOUR = 60 * MIN;
const CONCURRENCY = Number(process.env.STO_CONCURRENCY) || 2;
const SPACING_MS = process.env.STO_SPACING_MS != null ? Number(process.env.STO_SPACING_MS) : 400;
// play link -> hoster page: s.to's answer for a link doesn't change; it is checked again whenever the hoster page
// stops existing (then the link is asked again), so it can be kept for a week
const LINK_MS = (Number(process.env.STO_LINK_HOURS) || 168) * HOUR;
// pages: the site's search, series and episode pages (an episode page lists the play links; new uploads show up
// within these times)
const PAGE_MS = { search: 6 * HOUR, series: 6 * HOUR, episode: 3 * HOUR };
// while the check is shown: try again after 5, 10, 20, 30, 30 ... minutes in the background, and at most every
// 5 minutes when someone actually wants to watch something
const PROBE_STEPS = (process.env.STO_PROBE_MINUTES || '5,10,20,30').split(',').map(n => Number(n) * MIN);
const DEMAND_PROBE_MS = (Number(process.env.STO_DEMAND_PROBE_MINUTES) || 5) * MIN;
// while it works: if nobody watched anything through s.to for an hour, one quiet check per hour keeps the record
const MONITOR_MS = (Number(process.env.STO_MONITOR_MINUTES) || 60) * MIN;
const STATE_FILE = path.join(process.env.STATE_DIR || path.join(os.homedir(), '.german-addon'), 'sto-state.json');

const priority = new AsyncLocalStorage();      // 'low' for background work (next-episode prefetch, refreshes)
const links = new Map();                        // play link -> { loc, at, until }
const pages = new Map();                        // page url -> { at, until, status, url, type, body }
const inflight = new Map();                     // page url -> Promise of the same
const recent = [];                              // [time, kind] of every request actually sent to s.to (48 h)
const events = [];                              // availability record
const st = {
    state: 'ok',            // ok | check | unreachable
    since: Date.now(), lastOk: 0, lastCheck: 0, lastAttempt: 0, probeStep: 0, nextProbe: 0, probeUrl: null,
    login: 'unknown', loginChecked: 0, peak: 0, active: 0, saved: 0, served: { network: 0, cache: 0, linkMemory: 0, skipped: 0 },
};
let deps = null;            // { nativeFetch, smartFetch, trace, plainHeaders, session }
let timer = null;
const recoverHooks = [];

// SerienStream's own addresses (the site lists them on serien.domains). Both are the same service: same pages, same
// play links, and your login works on both. Only HTTPS addresses with a valid certificate are used; the bare IP
// (186.2.175.5) has no valid certificate and s.to no longer exists, so neither is in the list.
// The first one is used normally; the second only while the first can't be reached (not because of the human check:
// that is s.to's decision about the visitor, and switching address to avoid it would be dodging it).
const DOMAINS = (process.env.STO_DOMAINS || 'https://serienstream.to,https://serienstream.cx').split(',').map(x => new URL(x.trim()).origin);
const domainHosts = DOMAINS.map(o => new URL(o).host);
const dom = { active: 0, fails: 0, firstFail: 0, switchedAt: 0, lastBackTry: 0, info: DOMAINS.map(o => ({ origin: o, lastOk: 0, lastFail: 0, lastError: null })) };
const BACK_TRY_MS = (Number(process.env.STO_BACK_MINUTES) || 30) * MIN;
const isStoHost = h => /(^|\.)(serienstream\.(to|cx)|s\.to)$/i.test(String(h || '').replace(/^www\./, '')) || domainHosts.includes(h) || (process.env.STO_TEST_HOST && h === process.env.STO_TEST_HOST);
// the same request on the address in use right now
function onActive(url) {
    const u = new URL(url);
    if (!domainHosts.includes(u.host)) return url;
    const a = new URL(DOMAINS[dom.active]);
    u.protocol = a.protocol; u.host = a.host;
    return u.href;
}
const keyOf = url => { const u = new URL(url); return domainHosts.includes(u.host) ? u.pathname + u.search : url; };   // same entry on every address
function domainOk(url) { const i = domainHosts.indexOf(new URL(url).host); if (i >= 0) { dom.info[i].lastOk = Date.now(); if (i === dom.active) { dom.fails = 0; } } }
// the address in use failed to answer (no connection, timeout, server error): after 2 such failures within
// 5 minutes, check the other address with one page request and switch if it answers properly
async function domainFailed(url, why) {
    const i = domainHosts.indexOf(new URL(url).host);
    if (i < 0) return false;
    Object.assign(dom.info[i], { lastFail: Date.now(), lastError: String(why).slice(0, 120) });
    if (i !== dom.active || DOMAINS.length < 2) return false;
    if (Date.now() - dom.firstFail > 5 * MIN) { dom.firstFail = Date.now(); dom.fails = 0; }
    if (++dom.fails < 2) return false;
    for (let j = 0; j < DOMAINS.length; j++) {
        if (j === dom.active) continue;
        if (await answersProperly(DOMAINS[j])) {
            event('address-switched', { from: DOMAINS[dom.active], to: DOMAINS[j], reason: String(why).slice(0, 120) });
            dom.active = j; dom.fails = 0; dom.switchedAt = Date.now();
            return true;
        }
    }
    return false;
}
// one page request: does this address answer with the site, logged in?
async function answersProperly(origin) {
    try {
        await slot();
        let r;
        try {
            const cookie = deps.session.forHost(new URL(origin).host);
            note('address-test');
            r = await deps.nativeFetch(origin + '/account', { headers: { 'User-Agent': UA, Cookie: origin.startsWith('https:') || process.env.STO_TEST_HOST ? cookie : '' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
        } finally { release(); }
        const ok = r.status === 200 && /Abmelden|logout/i.test(await r.text());
        const i = DOMAINS.indexOf(origin);
        if (ok) dom.info[i].lastOk = Date.now(); else Object.assign(dom.info[i], { lastFail: Date.now(), lastError: `HTTP ${r.status}` });
        return ok;
    } catch (e) { const i = DOMAINS.indexOf(origin); Object.assign(dom.info[i], { lastFail: Date.now(), lastError: e.message }); return false; }
}
// while on the second address: every 30 minutes, see if the first one is back
async function tryBack() {
    if (dom.active === 0 || Date.now() - dom.lastBackTry < BACK_TRY_MS) return;
    dom.lastBackTry = Date.now();
    if (await answersProperly(DOMAINS[0])) { event('address-switched', { from: DOMAINS[dom.active], to: DOMAINS[0], reason: 'main address answers again' }); dom.active = 0; dom.fails = 0; }
}
function kindOf(u) {
    const p = u.pathname;
    if (/^\/r\b/.test(p)) return 'play';
    if (/^\/suche/.test(p)) return 'search';
    if (/\/staffel-\d+\/episode-\d+/.test(p)) return 'episode';
    if (/^\/serie\//.test(p)) return 'series';
    return 'other';
}

// ---------- polite scheduling ----------
const queues = { high: [], low: [] };
let lastStart = 0, pumpTimer = null;
function slot() {
    return new Promise(resolve => { queues[priority.getStore() === 'low' ? 'low' : 'high'].push(resolve); pump(); });
}
function pump() {
    while (st.active < CONCURRENCY && (queues.high.length || queues.low.length)) {
        const wait = lastStart + SPACING_MS - Date.now();
        if (wait > 0) { if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait); return; }
        st.active++;
        st.peak = Math.max(st.peak, st.active);
        lastStart = Date.now();
        (queues.high.shift() || queues.low.shift())();
    }
}
function release() { st.active--; pump(); }

function note(kind) {
    recent.push([Date.now(), kind]);
    const cut = Date.now() - 48 * HOUR;
    while (recent.length && (recent[0][0] < cut || recent.length > 50000)) recent.shift();
}
// what was sent to s.to in the last n minutes, by kind
function sentWithin(min) {
    const cut = Date.now() - min * MIN, out = { total: 0 };
    for (let i = recent.length - 1; i >= 0 && recent[i][0] >= cut; i--) { out.total++; out[recent[i][1]] = (out[recent[i][1]] || 0) + 1; }
    return out;
}

// ---------- availability ----------
function event(type, extra) {
    events.push(Object.assign({ type, at: new Date().toISOString() }, extra));
    while (events.length > 300) events.shift();
    save();
}
function markOk() {
    st.lastOk = Date.now();
    if (st.state !== 'ok') {
        const was = st.state;
        event(was === 'check' ? 'check-ended' : 'reachable-again', { lastedMinutes: Math.round((Date.now() - st.since) / MIN) });
        st.state = 'ok'; st.since = Date.now(); st.probeStep = 0; st.nextProbe = 0;
        for (const f of recoverHooks) { try { f(was); } catch (e) {} }
    }
    plan();
}
function markCheck(url) {
    st.lastCheck = Date.now();
    st.probeUrl = url;
    if (st.state !== 'check') {
        // the record of what the addon had sent just before: the evidence for (or against) a usage trigger
        event('check-started', { previousState: st.state, okFor: st.state === 'ok' ? Math.round((Date.now() - st.since) / MIN) : null,
            sentBefore: { '1min': sentWithin(1), '5min': sentWithin(5), '15min': sentWithin(15), '60min': sentWithin(60) }, peakConcurrency: st.peak });
        st.state = 'check'; st.since = Date.now(); st.probeStep = 0;
        // and is it really just the check? the account page tells whether the login itself still works
        setTimeout(() => checkLogin().then(l => { if (l !== 'ok') event('login-lost'); }).catch(() => {}), 2000).unref();
    } else st.probeStep = Math.min(st.probeStep + 1, PROBE_STEPS.length - 1);
    st.nextProbe = Date.now() + PROBE_STEPS[st.probeStep];
    st.peak = st.active;
    plan();
}
function markUnreachable(why) {
    if (st.state === 'ok') { event('unreachable', { why }); st.state = 'unreachable'; st.since = Date.now(); st.probeStep = 0; }
    else st.probeStep = Math.min(st.probeStep + 1, PROBE_STEPS.length - 1);
    st.nextProbe = Date.now() + PROBE_STEPS[st.probeStep];
    plan();
}

// background timer: retry while paused, a quiet hourly check while working (only if nothing else proved it)
function plan() {
    if (timer) clearTimeout(timer);
    if (!deps) return;
    const due = st.state === 'ok' ? Math.max(st.lastOk, st.lastAttempt) + MONITOR_MS : st.nextProbe;
    timer = setTimeout(() => { timer = null; probe('background').catch(() => {}).then(plan); }, Math.max(1000, due - Date.now()));
    timer.unref();
}
async function probe(why) {
    const target = st.probeUrl || await freshProbeUrl().catch(() => null);
    if (!target) { if (st.state !== 'ok') { st.nextProbe = Date.now() + PROBE_STEPS[st.probeStep]; } return null; }
    const r = await stoFetch(target, { headers: { 'User-Agent': UA }, _stoProbe: why }).catch(e => { markUnreachable(e.message); return null; });
    return r;
}
// a play link to test with: the first German button of a known episode
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TEST_EPISODE = process.env.STO_TEST_EPISODE || 'https://serienstream.to/serie/merlin-die-neuen-abenteuer/staffel-1/episode-3';
async function freshProbeUrl() {
    const html = await (await stoFetch(TEST_EPISODE, { headers: { 'User-Agent': UA } })).text();
    const m = html.match(/data-play-url="([^"]+)"[^>]*data-language-id="1"|data-language-id="1"[^>]*data-play-url="([^"]+)"/) || html.match(/data-play-url="([^"]+)"/);
    const p = m && (m[1] || m[2]);
    return p ? new URL(p.replace(/&amp;/g, '&'), TEST_EPISODE).href : null;
}

// is the login itself still valid? (separate from the check: the account page opens only for a logged-in member)
async function checkLogin() {
    const base = new URL(TEST_EPISODE).origin;
    const r = await stoFetch(base + '/account', { headers: { 'User-Agent': UA } });
    const body = await r.text();
    st.login = /\/login\b/.test(new URL(r.url || base).pathname) || !/Abmelden|logout/i.test(body) ? 'expired' : 'ok';
    st.loginChecked = Date.now();
    return st.login;
}

// ---------- the request itself ----------
function fromCache(c, url) {
    const out = new Response(c.body, { status: c.status, headers: { 'content-type': c.type || 'text/html' } });
    Object.defineProperty(out, 'url', { value: c.url || url });
    return out;
}
const skipped = url => { const out = new Response('s.to check active', { status: 200, headers: { 'x-sto': 'paused' } }); Object.defineProperty(out, 'url', { value: url }); return out; };

async function stoFetch(url, opts = {}) {
    const d = deps;
    tryBack().catch(() => {});
    url = onActive(url);
    if (opts.headers) {
        const h = d.plainHeaders(opts.headers);
        for (const k of Object.keys(h)) if (k.toLowerCase() === 'referer' && h[k]) { try { h[k] = onActive(h[k]); } catch (e) {} }
        opts = Object.assign({}, opts, { headers: h });
    }
    const u = new URL(url);
    const kind = kindOf(u);
    const method = String(opts.method || 'GET').toUpperCase();
    const probing = !!opts._stoProbe;

    if (kind === 'play' && !probing) {
        // 1. this link was answered before: go straight to the hoster page
        const known = links.get(keyOf(url));
        if (known && known.until > Date.now()) {
            st.served.linkMemory++;
            d.trace({ url, route: 'node+login', status: 302, ms: 0, snippet: `-> ${known.loc} (remembered)`.slice(0, 200) });
            const r = await d.smartFetch(known.loc, Object.assign({}, opts, { headers: noCookie(opts.headers, d), _hops: (opts._hops || 0) + 1 }));
            if (r.status !== 404 && r.status !== 410) return r;
            links.delete(keyOf(url));            // the hoster dropped the video: ask s.to for this link again
        }
        // 2. s.to shows its check: don't ask again, except now and then when someone actually wants to watch
        if (st.state !== 'ok') {
            const demandOk = Date.now() - st.lastAttempt >= DEMAND_PROBE_MS && priority.getStore() !== 'low';
            if (!demandOk) {
                st.served.skipped++;
                d.trace({ url, route: 'skip', status: 200, ms: 0, snippet: `s.to ${st.state}: not asking until ${new Date(st.nextProbe).toISOString()}` });
                return skipped(url);
            }
        }
    }
    if (method === 'GET' && PAGE_MS[kind] && !probing) {
        const c = pages.get(keyOf(url));
        if (c && c.until > Date.now()) { st.served.cache++; d.trace({ url, route: 'node+login', status: c.status, ms: 0, snippet: '(page remembered)' }); return fromCache(c, url); }
        if (inflight.has(keyOf(url))) { st.served.cache++; return fromCache(await inflight.get(keyOf(url)), url); }
        const job = send(url, opts, kind).then(async r => {
            const body = await r.text();
            const c = { at: Date.now(), until: Date.now() + PAGE_MS[kind], status: r.status, url: r.url, type: r.headers.get('content-type'), body };
            // only proper pages are reused (not errors, not a page without the login)
            if (r.status === 200 && body.length > 2000 && /Abmelden|logout/i.test(body)) {
                pages.set(keyOf(url), c);
                if (pages.size > 600) pages.delete(pages.keys().next().value);
            }
            return c;
        });
        inflight.set(keyOf(url), job);
        try { return fromCache(await job, url); } finally { inflight.delete(keyOf(url)); }
    }
    return send(url, opts, kind);
}

function noCookie(h, d) {
    const o = d.plainHeaders(h);
    for (const k of Object.keys(o)) if (k.toLowerCase() === 'cookie') delete o[k];
    return o;
}

async function send(url, opts, kind) {
    const d = deps;
    await slot();
    let r, t = Date.now();
    try {
        const hh = d.plainHeaders(opts.headers);
        // the login only ever travels over HTTPS
        const cookie = new URL(url).protocol === 'https:' || process.env.STO_TEST_HOST ? d.session.forHost(new URL(url).host) : '';
        const ck = Object.keys(hh).find(k => k.toLowerCase() === 'cookie');
        if (cookie) hh[ck || 'Cookie'] = ck && hh[ck] ? `${hh[ck]}; ${cookie}` : cookie;
        note(kind);
        st.served.network++;
        if (kind === 'play') st.lastAttempt = Date.now();
        r = await d.nativeFetch(url, Object.assign({}, opts, { headers: hh, redirect: 'manual', signal: opts.signal || AbortSignal.timeout(20000) }));
    } catch (e) {
        release();
        if (!opts._stoRetried && await domainFailed(url, e.message)) return send(onActive(url), Object.assign({}, opts, { _stoRetried: true }), kind);
        if (kind === 'play' || opts._stoProbe) markUnreachable(e.message);
        throw e;
    }
    release();
    if (r.status >= 500 || r.status === 429) {
        if (r.status !== 429 && !opts._stoRetried && await domainFailed(url, `HTTP ${r.status}`)) return send(onActive(url), Object.assign({}, opts, { _stoRetried: true }), kind);
    } else domainOk(url);
    try { d.session.update(typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean)); } catch (e) {}
    const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
    d.trace({ url, route: 'node+login', status: r.status, ms: Date.now() - t, snippet: loc ? `-> ${loc}`.slice(0, 200) : undefined });

    if (kind === 'play') {
        const target = loc && new URL(loc, url).href;
        if (target && !isStoHost(new URL(target).host)) {
            links.set(keyOf(url), { loc: target, at: Date.now(), until: Date.now() + LINK_MS });
            if (links.size > 20000) links.delete(links.keys().next().value);
            markOk();
            saveSoon();
        } else if (!loc && r.status === 200) {
            const text = await r.clone().text().catch(() => '');
            if (/frameBridge/.test(text)) markCheck(url);
        } else if (r.status >= 500 || r.status === 429) markUnreachable(`HTTP ${r.status}`);
    } else if (r.status >= 500 && opts._stoProbe) markUnreachable(`HTTP ${r.status}`);

    if (!loc) return r;
    const next = new URL(loc, url).href;
    const toGet = r.status === 303 || ((r.status === 301 || r.status === 302) && String(opts.method || 'GET').toUpperCase() === 'POST');
    const hop = Object.assign({}, opts, { headers: noCookie(opts.headers, d), _hops: (opts._hops || 0) + 1 });
    delete hop._stoProbe;
    if (toGet) { hop.method = 'GET'; delete hop.body; }
    if (hop._hops > 8) throw new Error('too many redirects');
    return d.smartFetch(next, hop);      // s.to again (with the login) or the hoster (without it)
}

// ---------- keeping the record across restarts ----------
let saveTimer = null;
function saveSoon() { if (!saveTimer) { saveTimer = setTimeout(() => { saveTimer = null; save(); }, 60000); saveTimer.unref(); } }
function save() {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        const keep = [...links].filter(([, v]) => v.until > Date.now());
        fs.writeFileSync(STATE_FILE, JSON.stringify({ v: 1, links: keep, events, lastGood: [...lastGood] }));
        st.saved = Date.now();
    } catch (e) {}
}
function load() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        for (const [k, v] of s.links || []) if (v.until > Date.now()) links.set(/^https?:/.test(k) ? keyOf(k) : k, v);   // older saves used full addresses
        for (const e of s.events || []) events.push(e);
        for (const [k, v] of s.lastGood || []) if (Date.now() - v.at < LAST_GOOD_MS) lastGood.set(k, v);
    } catch (e) {}
}

// ---------- last working SerienStream result per episode ----------
// When s.to can't be asked right now, an episode's previous SerienStream streams stand in (their video addresses
// are refreshed when played), instead of the episode losing SerienStream until the next lookup.
const lastGood = new Map();     // "tv:<tmdb>:<s>:<e>" -> { at, list }
const LAST_GOOD_MS = 7 * 24 * HOUR;
function rememberGood(key, list) {
    if (!list || !list.length) return;
    lastGood.delete(key);
    lastGood.set(key, { at: Date.now(), list });
    if (lastGood.size > 1500) lastGood.delete(lastGood.keys().next().value);
    saveSoon();
}
function standIn(key) {
    const g = lastGood.get(key);
    return g && Date.now() - g.at < LAST_GOOD_MS ? g.list : null;
}

function init(d) {
    deps = d;
    load();
    plan();
}

function availability(hours) {
    // share of the last n hours in which play links were answered normally, from the record
    const from = Date.now() - hours * HOUR;
    let bad = 0, open = null;
    const evs = events.filter(e => /check-started|unreachable|check-ended|reachable-again/.test(e.type)).map(e => [Date.parse(e.at), e.type]);
    for (const [t, type] of evs) {
        if (/started|unreachable/.test(type)) { if (open == null) open = t; }
        else if (open != null) { bad += Math.max(0, t - Math.max(open, from)); open = null; }
    }
    if (open != null) bad += Date.now() - Math.max(open, from);
    return Math.max(0, Math.round(1000 * (1 - bad / (hours * HOUR))) / 10);
}

function status() {
    const label = { ok: 'working', check: "s.to is showing its human check to the server (login fine) - paused, retrying", unreachable: 's.to not reachable - retrying' }[st.state];
    return {
        links: st.state, meaning: label, since: new Date(st.since).toISOString(),
        login: st.login, loginChecked: st.loginChecked ? new Date(st.loginChecked).toISOString() : null,
        nextRetry: st.state !== 'ok' && st.nextProbe ? new Date(st.nextProbe).toISOString() : null,
        lastWorkingLink: st.lastOk ? new Date(st.lastOk).toISOString() : null,
        lastCheckSeen: st.lastCheck ? new Date(st.lastCheck).toISOString() : null,
        availabilityPercent: { '24h': availability(24), '7d': availability(168) },
        sentToSto: { '5min': sentWithin(5), '60min': sentWithin(60), '24h': sentWithin(1440) },
        answeredWithoutAsking: st.served, remembered: { playLinks: links.size, pages: pages.size, episodes: lastGood.size },
        addresses: { inUse: DOMAINS[dom.active], list: dom.info.map(x => ({ address: x.origin, lastAnswered: x.lastOk ? new Date(x.lastOk).toISOString() : null, lastFailed: x.lastFail ? new Date(x.lastFail).toISOString() : null, lastError: x.lastError })) },
        recentEvents: events.slice(-15),
    };
}

module.exports = { init, fetch: stoFetch, isStoHost, priority, status, state: () => st.state, onRecover: f => recoverHooks.push(f),
    checkLogin, probe, rememberGood, standIn, _save: save, _reset: () => { links.clear(); pages.clear(); events.length = 0; recent.length = 0; lastGood.clear(); Object.assign(st, { state: 'ok', since: Date.now(), lastOk: 0, lastCheck: 0, lastAttempt: 0, probeStep: 0, nextProbe: 0, probeUrl: null, peak: 0, served: { network: 0, cache: 0, linkMemory: 0, skipped: 0 } }); }, _sentWithin: sentWithin };
