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
const TIMEOUT = Number(process.env.NET_TIMEOUT_MS) || 12000;
const REMEMBER_MS = 30 * 60000;

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

const routes = () => ['direct'].concat(warpUp ? ['warp'] : [], PROXY_URL ? ['proxy'] : []);

// ---------- block detection ----------
const BLOCK_STATUS = new Set([403, 429, 503, 520, 521, 522, 523, 524, 525, 526]);
const CHALLENGE = /Just a moment\.\.\.|cf-chl|_cf_chl_opt|challenge-platform|Attention Required! \| Cloudflare|DDoS-Guard|ddos-guard\/js|Checking your browser/i;
function isBlocked(status, type, buf) {
    if (BLOCK_STATUS.has(status)) return true;
    if (status >= 400 || !/html/i.test(type || '') || buf.byteLength > 60000) return false;
    return CHALLENGE.test(Buffer.from(buf).toString('utf8', 0, Math.min(buf.byteLength, 6000)));
}

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
    if (browserLike && ua) delete headers[ua];
    const init = { method: opts.method || 'GET', headers };
    if (opts.body != null) init.body = opts.body;
    let res;
    if (route === 'direct' && !browserLike) res = await nativeFetch(url, Object.assign({}, opts, { signal: opts.signal || AbortSignal.timeout(TIMEOUT) }));
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

    const all = routes();
    const mem = memory.get(host);
    const order = mem && mem.until > Date.now() && all.includes(mem.route) ? [mem.route].concat(all.filter(r => r !== mem.route)) : all;

    let last = null, lastErr = null;
    for (const route of order) {
        try {
            const r = await once(route, url, opts, browserLike);
            r.requested = url;
            if (!isBlocked(r.status, r.headers.get('content-type'), r.buf)) {
                count(host, route, 'ok');
                if (route !== 'direct') memory.set(host, { route, until: Date.now() + REMEMBER_MS });
                else if (mem) memory.delete(host);
                return toResponse(r);
            }
            count(host, route, 'blocked');
            last = r;
        } catch (e) {
            count(host, route, 'error');
            lastErr = e;
        }
    }
    if (last) return toResponse(last);
    throw lastErr || new Error(`fetch failed for ${url}`);
}

// ---------- diagnostics: /diag ----------
const DIAG_URLS = ['https://voe.sx/', 'https://aniworld.to/', 'https://s.to/', 'https://huhu.to/', 'https://supervideo.cc/',
    'https://luluvdo.com/', 'https://filmpalast.to/', 'https://moflix-stream.xyz/'];
async function diag() {
    const modes = ['node', 'direct'].concat(warpUp ? ['warp'] : [], PROXY_URL ? ['proxy'] : []);
    const rows = await Promise.all(DIAG_URLS.map(async url => {
        const row = { url };
        await Promise.all(modes.map(async m => {
            const t = Date.now();
            try {
                const r = m === 'node'
                    ? await (async () => { const x = await nativeFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(TIMEOUT) }); return { status: x.status, headers: x.headers, buf: await x.arrayBuffer() }; })()
                    : await once(m, url, {}, true);
                row[m] = `${r.status}${isBlocked(r.status, r.headers.get('content-type'), r.buf) ? ' BLOCKED' : ' ok'} ${Date.now() - t}ms`;
            } catch (e) {
                row[m] = `ERROR ${String(e.message || e).slice(0, 60)}`;
            }
        }));
        return row;
    }));
    return { warp: warpUp ? 'on' : 'off', proxy: PROXY_URL ? 'set' : 'not set', results: rows };
}

module.exports = { smartFetch, nativeFetch, startWarpWatch, checkWarp, diag, status: () => ({ warp: warpUp, proxy: !!PROXY_URL, remembered: Object.fromEntries([...memory].map(([h, m]) => [h, m.route])), stats }) };
