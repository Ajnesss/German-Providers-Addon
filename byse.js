// Filemoon's new player ("Byse"): the page is an empty app shell, the video comes from an API as an AES-GCM encrypted
// "playback" object whose key travels with it. Two variants are in use:
//   simple:  GET  /api/videos/<code>                       -> { playback: { version, key_parts[], iv, payload } }
//   newer:   GET  /api/videos/<code>/embed/details         -> { embed_frame_url }   (the player's own host)
//            POST /api/videos/access/challenge             -> { challenge_id, nonce }
//            POST /api/videos/access/attest                -> { token }   (nonce signed with a key the player makes itself)
//            POST /api/videos/<code>/embed/playback         -> { sources[] } or { playback }
// Replaces the plugins' old filemoon extractor (iframe + packed script), which no longer finds anything.
'use strict';

const crypto = require('crypto');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const b64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const toB64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });   // one per server start, like the web player

function decrypt(pb) {
    const parts = pb.key_parts || [];
    const v = Number(pb.version);
    const keys = [];
    if (v >= 1 && parts.length >= Math.max(v, 31 - v)) keys.push(Buffer.concat([b64u(parts[v - 1]), b64u(parts[30 - v])]));
    if (parts.length >= 2) keys.push(Buffer.concat([b64u(parts[0]), b64u(parts[1])]));
    const iv = b64u(pb.iv), data = b64u(pb.payload);
    for (const key of keys) {
        if (![16, 24, 32].includes(key.length)) continue;
        try {
            const d = crypto.createDecipheriv(`aes-${key.length * 8}-gcm`, key, iv);
            d.setAuthTag(data.subarray(data.length - 16));
            return JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8'));
        } catch (e) { /* try the next key layout */ }
    }
    throw new Error('could not decrypt playback');
}

function pick(obj) {
    const list = (obj && obj.sources) || [];
    const hls = list.filter(s => /mpegurl/i.test(s.mime_type || s.type || '') || /\.m3u8/.test(s.url || s.file || ''));
    return (hls.length ? hls : list).map(s => ({ url: s.url || s.file, height: Number(s.height) || 0 })).filter(s => s.url)
        .sort((a, b) => b.height - a.height);
}

async function json(res, what) {
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 80).replace(/\s+/g, ' ')}`); }
}

// url: https://filemoon.to/e/<code>  (or /d/<code>, other Byse domains); site: the page that embeds it (e.g. https://huhu.to)
async function extract(url, site = 'https://huhu.to', log = () => {}) {
    const u = new URL(url);
    const code = u.pathname.split('/').filter(Boolean).pop();
    const host = u.host;
    const P = u.protocol + '//';   // https in real life
    const base = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' };
    let found = [];
    let embedHost = host;

    // simple variant
    try {
        const r = await fetch(`${P}${host}/api/videos/${code}`, { headers: Object.assign({ Referer: `${P}${host}/e/${code}` }, base) });
        const meta = await json(r, 'videos');
        log(`videos: ${r.status} ${Object.keys(meta).join(',')}`);
        if (meta.playback) found = pick(decrypt(meta.playback));
        else if (meta.sources) found = pick(meta);
    } catch (e) { log(`videos: ${e.message}`); }

    // newer variant (challenge / attest / playback)
    if (!found.length) {
        const details = await json(await fetch(`${P}${host}/api/videos/${code}/embed/details`, { headers: Object.assign({ Referer: `${site}/`, Origin: site }, base) }), 'details');
        const frame = details.embed_frame_url ? new URL(details.embed_frame_url) : null;
        embedHost = frame ? frame.host : host;
        const prefix = (frame && frame.pathname.split('/').filter(Boolean)[0]) || 'e';
        const embedRef = `${P}${embedHost}/${prefix}/${code}`;
        log(`details: frame ${embedHost}`);
        const h = Object.assign({ Referer: embedRef, Origin: `${P}${embedHost}`, 'Content-Type': 'application/json' }, base);
        const ch = await json(await fetch(`${P}${embedHost}/api/videos/access/challenge`, { method: 'POST', headers: h, body: '{}' }), 'challenge');
        const sig = crypto.sign('sha256', b64u(ch.nonce), { key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' });
        const jwk = keyPair.publicKey.export({ format: 'jwk' });
        const viewer = toB64u(crypto.randomBytes(16)), device = toB64u(crypto.randomBytes(16));
        const at = await json(await fetch(`${P}${embedHost}/api/videos/access/attest`, { method: 'POST', headers: h, body: JSON.stringify({
            viewer_id: viewer, device_id: device, challenge_id: ch.challenge_id, nonce: ch.nonce, signature: toB64u(sig),
            public_key: { crv: 'P-256', ext: true, key_ops: ['verify'], kty: 'EC', x: jwk.x, y: jwk.y },
        }) }), 'attest');
        if (!at.token) throw new Error('attest: no token');
        log('attest: token ok');
        const pb = await json(await fetch(`${P}${embedHost}/api/videos/${code}/embed/playback`, { method: 'POST', body: JSON.stringify({
            fingerprint: { token: at.token, viewer_id: viewer, device_id: device, confidence: at.confidence || 0.93 },
        }), headers: Object.assign({}, h, { 'X-Embed-Origin': new URL(site).host, 'X-Embed-Parent': `${P}${host}/${prefix}/${code}`, 'X-Embed-Referer': `${site}/` }) }), 'playback');
        found = pb.playback ? pick(decrypt(pb.playback)) : pick(pb);
        log(`playback: ${found.length} source(s)`);
    }
    return found.map(s => ({
        url: s.url,
        quality: s.height ? `${s.height}p` : 'auto',
        headers: { Referer: `${P}${embedHost}/`, Origin: `${P}${embedHost}` },
    }));
}

// same shape as the plugins' extractors: (url, referer) -> [{ url, quality, headers }]
function forPlugins(url, referer) {
    let site = 'https://huhu.to';
    try { if (referer) site = new URL(referer).origin; } catch (e) {}
    return extract(url, site);
}

module.exports = { extract, forPlugins, decrypt };
