// Stream pass-through for video hosts that tie their links to the connection that found them (VOE & co.).
// The player loads  /p/<sig>/<data>/<name>  from this server; the server fetches the real URL with the stored
// headers (from the same server that found it) and passes it on. HLS playlists are rewritten so every segment,
// key and sub-playlist also goes through here. Everything else (ARD, Moflix, MP4s …) still plays directly.
'use strict';

const crypto = require('crypto');
const net = require('./net.js');

const MODE = (process.env.STREAM_PROXY || 'auto').toLowerCase();      // auto | all | off
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

// Are the video pieces tied to the IP too, or only the playlist? Fetch one piece through WARP (a different IP):
// if that works, the player can load pieces straight from the video host and only playlists go through here.
const segDecision = new Map();   // host -> { direct, until }
async function segmentsDirect(segUrl, headers) {
    let host;
    try { host = new URL(segUrl).host; } catch (e) { return false; }
    const known = segDecision.get(host);
    if (known && known.until > Date.now()) return known.direct;
    let direct = false;
    if (overCap()) direct = true;
    else if (net.warpOn()) {
        try {
            const r = await net.probe('warp', segUrl, { headers: Object.assign({}, headers, { Range: 'bytes=0-2047' }) });
            direct = (r.status === 200 || r.status === 206) && !/html|json/i.test(r.headers.get('content-type') || '');
        } catch (e) { direct = false; }
    }
    segDecision.set(host, { direct, until: Date.now() + 6 * 3600000 });
    return direct;
}

const b64 = s => Buffer.from(s).toString('base64url');
const unb64 = s => Buffer.from(s, 'base64url').toString('utf8');
const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url').slice(0, 16);

function wanted(stream, label) {
    if (MODE === 'off' || !/^https?:/.test(stream.url || '')) return false;
    if (MODE === 'all') return true;
    const text = `${label || ''} ${stream.name || ''} ${stream.title || ''} ${stream.url}`.toLowerCase();
    return HOSTS.some(h => text.includes(h));
}

function proxyUrl(base, url, headers) {
    const data = b64(JSON.stringify({ u: url, h: headers || {} }));
    const name = /\.m3u8(\?|$)/i.test(url) ? 'index.m3u8' : (url.split('?')[0].split('/').pop() || 'file').replace(/[^\w.-]/g, '').slice(-40) || 'file';
    return `${base}/p/${sign(data)}/${data}/${name}`;
}

const isPlaylist = (url, type, head) => /mpegurl/i.test(type || '') || /\.m3u8(\?|$)/i.test(url) || /^#EXTM3U/.test(head || '');

async function rewritePlaylist(text, baseUrl, base, headers) {
    const abs = u => new URL(u, baseUrl).toString();
    const lines = text.split(/\r?\n/);
    const media = /#EXTINF/.test(text);     // a playlist of video pieces (not a list of qualities)
    let direct = false;
    if (media) {
        const first = lines.find(l => l.trim() && !l.trim().startsWith('#'));
        direct = first ? await segmentsDirect(abs(first.trim()), headers) : false;
    }
    usage.playlists++;
    return lines.map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${proxyUrl(base, abs(u), headers)}"`);
        if (media && direct) { usage.segmentsDirect++; return abs(t); }
        if (media) usage.segmentsProxied++;
        return proxyUrl(base, abs(t), headers);
    }).join('\n');
}

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

// GET /p/<sig>/<data>/<name>
async function handle(req, res, base) {
    const m = (req.url || '').split('?')[0].match(/^\/p\/([\w-]+)\/([\w-]+)\//);
    if (!m || sign(m[2]) !== m[1]) { res.writeHead(403); return res.end('bad link'); }
    let job;
    try { job = JSON.parse(unb64(m[2])); } catch (e) { res.writeHead(400); return res.end('bad link'); }
    const headers = Object.assign({}, job.h);
    if (req.headers.range) headers.Range = req.headers.range;
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'user-agent')) {
        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    }
    let up;
    try {
        // plain streaming fetch first (no buffering of big files) ...
        up = await net.nativeFetch(job.u, { headers, signal: AbortSignal.timeout(30000) });
        // ... and the full fallback chain (Chrome-like / WARP) if the host refuses it
        if (up.status === 403 || up.status === 429 || up.status === 503) up = await net.smartFetch(job.u, { headers });
    } catch (e) {
        res.writeHead(502); return res.end('upstream failed: ' + e.message);
    }
    const type = up.headers.get('content-type') || '';
    if (isPlaylist(job.u, type)) {
        const text = await up.text();
        if (isPlaylist(job.u, type, text) && /^#EXTM3U/.test(text.trim())) {
            const body = await rewritePlaylist(text, up.url || job.u, base, job.h);
            res.writeHead(up.status, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
            return res.end(body);
        }
        res.writeHead(up.status, { 'Content-Type': type || 'text/plain' });
        return res.end(text);
    }
    if (overCap()) { res.writeHead(302, { Location: job.u }); return res.end(); }
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

module.exports = { usage: () => Object.assign({}, usage, { capGB: CAP_BYTES / 1024 ** 3, usedMB: Math.round(usage.bytes / 1048576), segmentHosts: Object.fromEntries([...segDecision].map(([h, d]) => [h, d.direct ? 'direct' : 'through server'])) }), wanted, proxyUrl, handle, rewritePlaylist, mode: MODE, hosts: HOSTS };
