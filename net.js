// Connection layer for the scrapers.
// Many German sites and video hosts (VOE, AniWorld, s.to …) sit behind Cloudflare/DDoS-Guard and refuse plain
// Node.js requests from servers. Every scraper request goes through smartFetch(), which tries, per site:
//   1. "direct": a connection that looks exactly like Chrome (impit: same TLS/HTTP2 fingerprint and headers)
//   2. "warp":   the same, routed through Cloudflare WARP (free; started by start.sh as a local SOCKS5 proxy)
//   3. "proxy":  the same, through PROXY_URL if you set one (e.g. a residential proxy)
// and remembers which route worked for each site, so later requests go straight there.
'use strict';

const { Impit } = require('impit');

const nativeFetch = globalThis.fetch.bind(globalThis);
const WARP_PROXY = process.env.WARP_PROXY || 'socks5://127.0.0.1:40000';
const PROXY_URL = (process.env.PROXY_URL || '').trim();
const TIMEOUT = Number(process.env.NET_TIMEOUT_MS) || 20000;
// sites known to need longer per page (KinoKing: 12-20 s)
const SLOW = new RegExp(process.env.SLOW_HOSTS || 'kinoking', 'i');
const timeoutFor = url => (SLOW.test(url) ? Math.max(TIMEOUT, 40000) : TIMEOUT);
const REMEMBER_MS = 30 * 60000;

const { AsyncLocalStorage } = require('async_hooks');
const traceStore = new AsyncLocalStorage();
function trace(entry) {
    const t = traceStore.getStore();
    if (t && t.length < 400) t.push(Object.assign({}, entry, { url: entry.url && entry.url.slice(0, 160) }));
}
// console.error lines (the scrapers' own error messages) also land in the active trace
const origError = console.error.bind(console);
console.error = (...a) => { trace({ log: a.map(String).join(' ').slice(0, 200) }); origError(...a); };

const clients = new Map();
function client(route, browser) {
    const key = route + ':' + browser;
    if (!clients.has(key)) {
        const opts = { timeout: TIMEOUT };
        if (browser) opts.browser = 'chrome';
        if (route === 'warp') opts.proxyUrl = WARP_PROXY;
        if (route === 'proxy') opts.proxyUrl = PROXY_URL;
        clients.set(key, new Impit(opts));
    }
    return clients.get(key);
}

// ---------- WARP status ----------
let warpUp = false, warpCheckedAt = 0;
async function checkWarp() {
    warpCheckedAt = Date.now();
    try {
        const r = await new Impit({ proxyUrl: WARP_PROXY, timeout: 8000 }).fetch('https://www.cloudflare.com/cdn-cgi/trace');
        warpUp = /warp=(on|plus)/.test(await r.text());
    } catch (e) {
        warpUp = false;
    }
    return warpUp;
}
function startWarpWatch() {
    if (process.env.WARP === '0') return;
    const loop = async () => { await checkWarp(); setTimeout(loop, warpUp ? 10 * 60000 : 30000).unref(); };
    loop();
}

// 'node': plain request exactly like before (keeps every site that already worked unchanged)
// 'direct': Chrome-like connection, 'warp': Chrome-like through WARP, 'proxy': Chrome-like through PROXY_URL
const routes = browserLike => ['node'].concat(browserLike ? ['direct'] : [], warpUp ? ['warp'] : [], PROXY_URL ? ['proxy'] : []);

// ---------- block detection ----------
const BLOCK_STATUS = new Set([403, 429, 503]);
const CHALLENGE = /Just a moment\.\.\.|cf-chl|_cf_chl_opt|challenge-platform|Attention Required! \| Cloudflare|DDoS-Guard|ddos-guard\/js|Checking your browser/i;
// small pages that are only a captcha (s.to/AniWorld show one instead of redirecting after ~10 links per IP)
const CAPTCHA = /captcha|turnstile|cf-turnstile|h-captcha|g-recaptcha/i;
function isBlocked(status, type, buf) {
    if (BLOCK_STATUS.has(status)) return true;
    if (status >= 400 || !/html/i.test(type || '') || buf.byteLength > 60000) return false;
    const head = Buffer.from(buf).toString('utf8', 0, Math.min(buf.byteLength, 6000));
    return CHALLENGE.test(head);
}
const snippet = (type, buf) => buf.byteLength && buf.byteLength < 4000 && /html|text|json/i.test(type || '')
    ? Buffer.from(buf).toString('utf8').replace(/\s+/g, ' ').slice(0, 300) : undefined;
const isTimeout = e => /timeout|timed out|aborted/i.test(String(e && (e.message || e.name) || e));

// ---------- per-site memory and stats ----------
const memory = new Map();   // host -> { route, until }
const stats = {};           // host -> { route: { ok, blocked, error } }
const hostOf = url => { try { return new URL(url).host.replace(/^www\./, ''); } catch (e) { return '?'; } };
function count(host, route, what) {
    const h = stats[host] || (stats[host] = {});
    const r = h[route] || (h[route] = { ok: 0, blocked: 0, error: 0 });
    r[what]++;
}

function plainHeaders(h) {
    if (!h) return {};
    if (typeof h.forEach === 'function' && !Array.isArray(h)) { const o = {}; h.forEach((v, k) => { o[k] = v; }); return o; }
    return Object.assign({}, h);
}

async function once(route, url, opts, browserLike) {
    const headers = plainHeaders(opts.headers);
    const ua = Object.keys(headers).find(k => k.toLowerCase() === 'user-agent');
    // let the Chrome emulation send its own matching User-Agent; keep special ones like "MediaUrl/2"
    if (route !== 'node' && browserLike && ua) delete headers[ua];
    const init = { method: opts.method || 'GET', headers, timeout: timeoutFor(url) };
    if (opts.body != null) init.body = opts.body;
    let res;
    if (route === 'node') res = await nativeFetch(url, Object.assign({}, opts, { signal: opts.signal || AbortSignal.timeout(timeoutFor(url)) }));
    else res = await client(route, browserLike).fetch(url, init);
    const buf = res.status === 204 || res.status === 304 ? new ArrayBuffer(0) : await res.arrayBuffer();
    const outHeaders = new Headers();
    res.headers.forEach((v, k) => { try { outHeaders.append(k, v); } catch (e) {} });
    return { status: res.status, statusText: res.statusText || '', url: res.url || url, headers: outHeaders, buf };
}

function toResponse(r) {
    const nullBody = r.status === 204 || r.status === 304 || r.status < 200;
    const out = new Response(nullBody ? null : r.buf, { status: r.status < 200 ? 200 : r.status, statusText: r.statusText, headers: r.headers });
    Object.defineProperty(out, 'url', { value: r.url });
    Object.defineProperty(out, 'redirected', { value: r.url !== r.requested });
    return out;
}

async function smartFetch(input, opts = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!/^https?:/i.test(url)) return nativeFetch(input, opts);
    const host = hostOf(url);
    const h = plainHeaders(opts.headers);
    const uaKey = Object.keys(h).find(k => k.toLowerCase() === 'user-agent');
    const browserLike = !uaKey || /Mozilla/i.test(h[uaKey]);

    const all = routes(browserLike);
    const mem = memory.get(host);
    const order = mem && mem.until > Date.now() && all.includes(mem.route) ? [mem.route].concat(all.filter(r => r !== mem.route)) : all;

    let last = null, lastErr = null, candidate = null, sawBlock = false;
    for (const route of order) {
        const t = Date.now();
        try {
            const r = await once(route, url, opts, browserLike);
            r.requested = url;
            const blocked = isBlocked(r.status, r.headers.get('content-type'), r.buf);
            trace({ url, route, status: r.status, blocked, bytes: r.buf.byteLength, ms: Date.now() - t, snippet: snippet(r.headers.get('content-type'), r.buf) });
            if (blocked) { count(host, route, 'blocked'); sawBlock = true; last = r; continue; }
            // after a block, a 404 is often a fake "not found" for servers: try the remaining routes too
            if (r.status === 404 && sawBlock) { count(host, route, 'blocked'); candidate = candidate || r; continue; }
            count(host, route, 'ok');
            if (route !== 'node') memory.set(host, { route, until: Date.now() + REMEMBER_MS });
            else if (mem) memory.delete(host);
            return toResponse(r);
        } catch (e) {
            trace({ url, route, error: String(e.message || e).slice(0, 120), ms: Date.now() - t });
            count(host, route, 'error');
            lastErr = e;
            // a slow site stays slow on every route: don't spend another 20 s per route on it
            if (isTimeout(e) && !sawBlock) break;
        }
    }
    if (candidate) return toResponse(candidate);
    if (last) return toResponse(last);
    throw lastErr || new Error(`fetch failed for ${url}`);
}

// ---------- diagnostics: /diag ----------
const DIAG_URLS = ['https://voe.sx/', 'https://aniworld.to/', 'https://serienstream.to/', 'https://huhu.to/', 'https://supervideo.cc/',
    'https://luluvdo.com/', 'https://filmpalast.to/', 'https://moflix-stream.xyz/'];
async function diag() {
    const modes = ['node', 'direct'].concat(warpUp ? ['warp'] : [], PROXY_URL ? ['proxy'] : []);
    const urls = DIAG_URLS;
    const rows = await Promise.all(DIAG_URLS.map(async url => {
        const row = { url };
        await Promise.all(modes.map(async m => {
            const t = Date.now();
            try {
                const r = await once(m, url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } }, true);
                row[m] = `${r.status}${isBlocked(r.status, r.headers.get('content-type'), r.buf) ? ' BLOCKED' : ' ok'} ${Date.now() - t}ms`;
            } catch (e) {
                row[m] = `ERROR ${String(e.message || e).slice(0, 60)}`;
            }
        }));
        return row;
    }));
    return { warp: warpUp ? 'on' : 'off', proxy: PROXY_URL ? 'set' : 'not set', results: rows };
}

// small cookie jar for video hosts that expect the cookie from the playlist on the next requests
const jar = new Map();   // host -> { name: value }
function cookieHeader(url) {
    try { const c = jar.get(new URL(url).host); return c && Object.keys(c).length ? Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ') : null; } catch (e) { return null; }
}
function storeCookies(url, res) {
    try {
        const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
        if (!raw.length) return;
        const host = new URL(res.url || url).host;
        const c = jar.get(host) || {};
        for (const line of raw.join('\n').split(/\n|,(?=\s*[^;,=\s]+=)/)) { const m = line.trim().match(/^([^=;\s]+)=([^;]*)/); if (m) c[m[1]] = m[2]; }
        jar.set(host, c);
        if (jar.size > 300) jar.delete(jar.keys().next().value);
    } catch (e) { /* ignore */ }
}

// open a URL through one specific route without buffering (video pieces / files): status, headers, body stream
async function open(route, url, headers, signal) {
    const h = Object.assign({}, headers);
    const cookie = cookieHeader(url);
    if (cookie && !Object.keys(h).some(k => k.toLowerCase() === 'cookie')) h.Cookie = cookie;
    let res;
    if (route === 'node') res = await nativeFetch(url, { headers: h, signal });
    else {
        for (const k of Object.keys(h)) if (k.toLowerCase() === 'user-agent') delete h[k];
        res = await client(route, true).fetch(url, { headers: h, signal });
    }
    storeCookies(url, res);
    return res;
}

// fetch only the start of a (possibly huge) file through a route: status + type, then hang up
async function peek(route, url, headers) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
        const r = await open(route, url, headers, ac.signal);
        let first = 0, head = '', text = null;
        const type = r.headers.get('content-type') || '';
        if (r.body) {
            const rd = r.body.getReader();
            const { value } = await rd.read();
            if (value) { first = value.length; head = Buffer.from(value.subarray(0, 200)).toString('utf8'); }
            if (value && (/mpegurl/i.test(type) || /^#EXTM3U/.test(head.trim()))) {
                // a playlist: keep reading it (they are small), links in it may be single-use
                const parts = [Buffer.from(value)];
                let size = value.length;
                for (;;) { const c = await rd.read(); if (c.done) break; parts.push(Buffer.from(c.value)); size += c.value.length; if (size > 5e6) break; }
                text = Buffer.concat(parts).toString('utf8');
            }
            rd.cancel().catch(() => {});
        }
        return { status: r.status, type, first, head, text, url: r.url || url };
    } finally { clearTimeout(timer); ac.abort(); }
}

const availableRoutes = () => ['node'].concat(warpUp ? ['warp'] : [], PROXY_URL ? ['proxy'] : []);

module.exports = { hasCookie: url => !!cookieHeader(url), rememberedRoute: host => { const m = memory.get(host); return m && m.until > Date.now() ? m.route : null; }, open, availableRoutes, peek, probe: (route, url, opts) => once(route, url, opts || {}, true), warpOn: () => warpUp, traceStore, smartFetch, nativeFetch, startWarpWatch, checkWarp, diag, status: () => ({ warp: warpUp, proxy: !!PROXY_URL, remembered: Object.fromEntries([...memory].map(([h, m]) => [h, m.route])), stats }) };
