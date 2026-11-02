// veev.to (also veev.pro / poophq.com / doods.to) — ported from ResolveURL's veev plugin (GPL, mrdini123 & gujal).
// The page carries an LZW-packed key ("fc"); with it the player API (/dl?op=player_api&cmd=gi) returns the file,
// whose address is hex-encoded (and sometimes reversed) a few times over.
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function veevDecode(etext) {
    const chars = Array.from(etext);
    const lut = {};
    let n = 256, c = chars[0];
    const out = [c];
    for (const ch of chars.slice(1)) {
        const code = ch.codePointAt(0);
        const nc = code < 256 ? ch : (lut[code] !== undefined ? lut[code] : c + c[0]);
        out.push(nc);
        lut[n++] = c + nc[0];
        c = nc;
    }
    return out.join('');
}
const jsInt = x => (/^\d$/.test(x) ? Number(x) : 0);
function buildArray(s) {
    const d = [], c = Array.from(s);
    let count = jsInt(c.shift());
    while (count) {
        const cur = [];
        for (let i = 0; i < count; i++) cur.unshift(jsInt(c.shift()));
        d.push(cur);
        count = jsInt(c.shift());
    }
    return d;
}
function decodeUrl(etext, tarray) {
    let ds = etext;
    for (const t of tarray) {
        if (t === 1) ds = Array.from(ds).reverse().join('');
        ds = Buffer.from(ds, 'hex').toString('utf8').replace(/dXRmOA==/g, '');
    }
    return ds;
}

async function extract(url, log = () => {}) {
    const headers = { 'User-Agent': UA, Referer: url };
    const res = await fetch(url, { headers });
    const page = await res.text();
    let code = url.split('/').filter(Boolean).pop().split(/[?#]/)[0];
    try { if (res.url && res.url !== url) code = res.url.split('/').filter(Boolean).pop(); } catch (e) {}
    const items = [...page.matchAll(/[.\s'](?:fc|_vvto\[[^\]]*)(?:['\]]*)?\s*[:=]\s*['"]([^'"]+)/g)].map(m => m[1]);
    log(`page ${res.status}, ${items.length} key candidate(s)`);
    if (!items.length) return [];
    for (const f of items.reverse()) {
        const ch = veevDecode(f);
        if (ch === f) continue;
        const api = new URL('/dl', res.url || url);
        api.search = new URLSearchParams({ op: 'player_api', cmd: 'gi', file_code: code, ch, ie: '1' }).toString();
        const j = JSON.parse(await (await fetch(api.toString(), { headers })).text());
        const file = j && j.file;
        log(`player api: ${file ? file.file_status : 'no file'}`);
        if (!file || file.file_status !== 'OK') return [];
        const src = decodeUrl(veevDecode(file.dv[0].s), buildArray(ch)[0] || []);
        return [{ url: src, quality: 'auto', headers: { Referer: url, 'User-Agent': UA } }];
    }
    return [];
}

// plugin-style extractor: (url, referer) -> [{ url, quality, headers }]
const forPlugins = url => extract(url);
module.exports = { extract, forPlugins, veevDecode, buildArray, decodeUrl };
