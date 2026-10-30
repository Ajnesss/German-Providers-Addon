// Stream pass-through for video hosts that tie their links to the connection that found them (VOE & co.).
// The player loads  /p/<sig>/<data>/<name>  from this server; the server fetches the real URL with the stored
// headers (from the same server that found it) and passes it on. HLS playlists are rewritten so every segment,
// key and sub-playlist also goes through here. Everything else (ARD, Moflix, MP4s …) still plays directly.
'use strict';

const crypto = require('crypto');
const net = require('./net.js');

const MODE = (process.env.STREAM_PROXY || 'auto').toLowerCase();      // auto | all | off
// official broadcasters (public HLS, not tied to an IP) always play directly; set STREAM_PROXY=hosts to only pass
// through the hosts in STREAM_PROXY_HOSTS, or =all / =off
const DIRECT_PROVIDERS = (process.env.DIRECT_PROVIDERS || 'ard,arte,plutotv,dmax,tele5,tlc,southpark,netzkino')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const HOSTS = (process.env.STREAM_PROXY_HOSTS || 'voe,vidmoly,filemoon,streamwish,byse,bysezejataos,derricknationtop,cloudwindow-route')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SECRET = process.env.STREAM_SECRET || process.env.TMDB_API_KEY || 'german-providers';
// Render's free plan has 5 GB outbound per month (services pause when it runs out): cap video pass-through below that
const CAP_BYTES = (Number(process.env.PASSTHROUGH_GB) || 3.5) * 1024 ** 3;
const usage = { month: new Date().toISOString().slice(0, 7), bytes: 0, playlists: 0, segmentsDirect: 0, segmentsProxied: 0 };
function track(bytes) {
    const m = new Date().toISOString().slice(0, 7);
    if (m !== usage.month) Object.assign(usage, { month: m, bytes: 0 });
    usage.bytes += bytes;
}
const overCap = () => usage.bytes >= CAP_BYTES;

// Which of the server's connections (plain / WARP / proxy) can load a URL? If more than one can, the link isn't tied
// to an IP and the player may load it straight from the host. If only one can, it's locked to that connection, so
// everything for this stream must go through the server on that same connection.
const isMedia = r => (r.status === 200 || r.status === 206) && r.first > 0 && !/html/i.test(r.type) && !/^\s*</.test(r.head);
async function reach(url, headers) {
    const routes = net.availableRoutes();
    const res = await Promise.all(routes.map(rt => net.peek(rt, url, Object.assign({}, headers, { Range: 'bytes=0-2047' }))
        .then(r => ({ rt, r }), () => ({ rt, r: null }))));
    const ok = res.filter(x => x.r && (isMedia(x.r) || /^#EXTM3U/.test((x.r.head || '').trim())));
    const first = (ok[0] || res.find(x => x.r) || {}).r || null;
    return { ok: ok.map(x => x.rt), all: routes, info: first };
}
// a link may go straight to the player only if it isn't tied to an IP (loads from at least two different IPs, and
// from every IP we have) AND a plain connection loads it: the TV's player isn't browser-like, so a host that only
// accepts browser-like connections must stay on the server even when it accepts them from every IP
function ipFree(okRoutes, allRoutes) {
    const ok = new Set(okRoutes.map(net.ipOf)), all = new Set(allRoutes.map(net.ipOf));
    return okRoutes.includes('node') && ok.size > 1 && ok.size === all.size;
}
const decisions = [];   // last decisions, for /net
function note(d) { decisions.unshift(Object.assign({ at: new Date().toISOString().slice(11, 19) }, d)); decisions.length = Math.min(decisions.length, 60); }

const b64 = s => Buffer.from(s).toString('base64url');
const unb64 = s => Buffer.from(s, 'base64url').toString('utf8');
const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url').slice(0, 16);

function wanted(stream, label, providerId) {
    if (MODE === 'off' || !/^https?:/.test(stream.url || '')) return false;
    if (MODE === 'all') return true;
    const text = `${label || ''} ${stream.name || ''} ${stream.title || ''} ${stream.url}`.toLowerCase();
    if (MODE === 'hosts') return HOSTS.some(h => text.includes(h));
    // auto: every hoster stream goes via here; whether the video itself does is tested per host (ipFree)
    return !DIRECT_PROVIDERS.includes(String(providerId || '').toLowerCase());
}

function proxyUrl(base, url, headers, route, source, re, fresh) {
    const job = { u: url, h: headers || {} };
    if (re) job.re = re;            // [type, id, provider, host]: lets an expired link be looked up again
    if (fresh) job.f = 1;           // already a refreshed link: don't refresh again
    if (route) job.r = route;
    if (source) job.s = source;     // the host whose page produced this link (e.g. supervideo.cc)
    const data = b64(JSON.stringify(job));
    const name = /\.m3u8(\?|$)/i.test(url) ? 'index.m3u8' : (url.split('?')[0].split('/').pop() || 'file').replace(/[^\w.-]/g, '').slice(-40) || 'file';
    return `${base}/p/${sign(data)}/${data}/${name}`;
}

const isPlaylist = (url, type, head) => /mpegurl/i.test(type || '') || /\.m3u8(\?|$)/i.test(url) || /^#EXTM3U/.test(head || '');

async function rewritePlaylist(text, baseUrl, base, headers, route) {
    const abs = u => new URL(u, baseUrl).toString();
    const lines = text.split(/\r?\n/);
    const media = /#EXTINF/.test(text);     // a playlist of video pieces (not a list of qualities)
    let direct = false, segRoute = route;
    if (media) {
        const first = lines.find(l => l.trim() && !l.trim().startsWith('#'));
        if (first) {
            const seg = await reach(abs(first.trim()), headers);
            // pieces go straight to the player only if every connection can load them and no session cookie is involved
            direct = overCap() || (ipFree(seg.ok, seg.all) && !net.hasCookie(abs(first.trim())));
            if (!direct && seg.ok.length) segRoute = seg.ok.includes(route) ? route : seg.ok[0];
            note({ pieces: new URL(abs(first.trim())).host, works: seg.ok.join('+') || 'none', via: direct ? 'player direct' : 'server/' + segRoute });
        }
    }
    usage.playlists++;
    return lines.map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${proxyUrl(base, abs(u), headers, route)}"`);
        if (media && direct) { usage.segmentsDirect++; return abs(t); }
        if (media) usage.segmentsProxied++;
        return proxyUrl(base, abs(t), headers, media ? segRoute : route);
    }).join('\n');
}

// links from the player's cache (Nuvio keeps them for days) expire at the host after a few hours. When the first
// request of such a link fails, the server looks the episode up again and sends the player to the fresh link.
let refresher = null;
async function tryRefresh(job, res) {
    if (!refresher || !job.re || job.f) return false;
    const fresh = await refresher(job.re).catch(() => null);
    note({ refresh: job.re.slice(0, 4).join(' '), result: fresh ? 'new link' : 'none found' });
    if (!fresh) return false;
    res.writeHead(302, { Location: fresh, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    res.end();
    return true;
}

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchText(route, url, headers) {
    const r = await net.open(route, url, headers, AbortSignal.timeout(20000));
    return { status: r.status, url: r.url || url, text: await r.text() };
}

async function pipe(req, res, up) {
    const out = { 'Access-Control-Allow-Origin': '*' };
    for (const k of PASS) { const v = up.headers.get(k); if (v) out[k] = v; }
    res.writeHead(up.status, out);
    if (!up.body || req.method === 'HEAD') return res.end();
    const reader = up.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            track(value.byteLength);
            if (!res.write(value)) await new Promise(r => res.once('drain', r));
        }
    } catch (e) { /* player went away */ }
    res.end();
}

// GET /p/<sig>/<data>/<name>
async function handle(req, res, base) {
    const m = (req.url || '').split('?')[0].match(/^\/p\/([\w-]+)\/([\w-]+)\//);
    if (!m || sign(m[2]) !== m[1]) { res.writeHead(403); return res.end('bad link'); }
    let job;
    try { job = JSON.parse(unb64(m[2])); } catch (e) { res.writeHead(400); return res.end('bad link'); }
    const headers = Object.assign({}, job.h);
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = UA;
    try {
        let route = job.r;
        let playlist = /\.m3u8(\?|$)/i.test(job.u);
        let text = null, finalUrl = job.u;
        if (!route) {
            // first request of a stream. Links can be single-use, so try one connection at a time, starting with the one
            // that opened the page this link came from, and keep the playlist we get instead of loading it twice.
            const routes = net.availableRoutes();
            const pref = job.s && net.rememberedRoute(job.s);
            const order = [pref, 'node'].concat(routes).filter((r, i, a) => r && routes.includes(r) && a.indexOf(r) === i);
            let info = null, last = null;
            const tried = [];
            for (const rt of order) {
                const r = await net.peek(rt, job.u, Object.assign({}, headers, playlist ? {} : { Range: 'bytes=0-2047' })).catch(e => ({ error: e.message }));
                last = r;
                tried.push(`${rt}:${r.error ? 'error ' + r.error.slice(0, 40) : r.status + ' ' + (r.type || '').split(';')[0] + ' ' + (r.head || '').replace(/\s+/g, ' ').slice(0, 60)}`);
                if (r.text && /^#EXTM3U/.test(r.text.trim()) && r.status < 400) { route = rt; info = r; break; }
                if (!r.error && isMedia(r)) { route = rt; info = r; break; }
            }
            if (!route) {
                note({ start: new URL(job.u).host, tried: tried.join(' | ') });
                if (await tryRefresh(job, res)) return;
                res.writeHead(502); return res.end('refused: ' + tried.join(' | '));
            }
            if (info.text) { playlist = true; text = info.text; finalUrl = info.url; }
            else {
                playlist = false;
                // a whole file: free if the other connections can load it as well
                const others = routes.filter(r => r !== route);
                const okOthers = await Promise.all(others.map(rt => net.peek(rt, job.u, Object.assign({}, headers, { Range: 'bytes=0-2047' })).then(isMedia, () => false)));
                const free = overCap() || ipFree([route].concat(others.filter((r, i) => okOthers[i])), routes);
                note({ file: new URL(job.u).host, works: [route].concat(others.filter((r, i) => okOthers[i])).join('+'), via: free ? 'player direct' : 'server/' + route });
                if (free) { res.writeHead(302, { Location: job.u, 'Access-Control-Allow-Origin': '*' }); return res.end(); }
            }
        }
        if (playlist) {
            const p = text ? { status: 200, url: finalUrl, text } : await fetchText(route, job.u, headers);
            if (p.status < 400 && /^#EXTM3U/.test(p.text.trim())) {
                const body = await rewritePlaylist(p.text, p.url, base, job.h, route);
                res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
                return res.end(body);
            }
            if (!job.r && await tryRefresh(job, res)) return;
            res.writeHead(p.status >= 400 ? p.status : 502); return res.end('not a playlist');
        }
        if (overCap()) { res.writeHead(302, { Location: job.u }); return res.end(); }
        const h = Object.assign({}, headers);
        if (req.headers.range) h.Range = req.headers.range;
        const up = await net.open(route, job.u, h, AbortSignal.timeout(60000));
        return pipe(req, res, up);
    } catch (e) {
        if (!res.headersSent) { res.writeHead(502); res.end('upstream failed: ' + e.message); } else res.end();
    }
}

// read / re-sign a /p/ link
function jobOf(link) {
    const m = String(link || '').match(/\/p\/([\w-]+)\/([\w-]+)\//);
    if (!m || sign(m[2]) !== m[1]) return null;
    try { return JSON.parse(unb64(m[2])); } catch (e) { return null; }
}
function markFresh(link) {
    const job = jobOf(link);
    if (!job) return link;
    const base = link.slice(0, link.indexOf('/p/'));
    return proxyUrl(base, job.u, job.h, job.r, job.s, job.re, true);
}

module.exports = { jobOf, markFresh, setRefresher: fn => { refresher = fn; }, usage: () => Object.assign({}, usage, { capGB: CAP_BYTES / 1024 ** 3, usedMB: Math.round(usage.bytes / 1048576), decisions }), wanted, proxyUrl, handle, rewritePlaylist, mode: MODE, hosts: HOSTS };
