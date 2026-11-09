// StreamOrigin (embedorigin.cc / streamorigin.cc): Moflix lists it for films. The player asks a plain JSON API
//   GET /app/v1/play/<code>?embed=1  -> { hls: ".../master.m3u8", mp4: "", duration, expires_at, ... }
// The HLS master names its audio tracks, so the language is checked here and not guessed: only files whose master
// lists a German audio track are returned (checked 9 Nov 2026: Oppenheimer = German default + English, original
// Blu-ray bitrate).
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// audio tracks named in an HLS master: [{ lang, name, default }]
function audioTracks(master) {
    return [...String(master).matchAll(/#EXT-X-MEDIA:([^\n]*TYPE=AUDIO[^\n]*)/g)].map(m => {
        const a = m[1];
        const get = k => (a.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
        return { lang: get('LANGUAGE').toLowerCase(), name: get('NAME'), default: /DEFAULT=YES/.test(a) };
    });
}
const isGerman = t => /^(de|deu|ger)(-|$)/.test(t.lang) || /deutsch|german/i.test(t.name);

async function extract(url) {
    const u = new URL(url);
    const code = u.pathname.split('/').filter(Boolean).pop();
    const headers = { 'User-Agent': UA, Referer: url, Accept: 'application/json' };
    const r = await fetch(`${u.origin}/app/v1/play/${encodeURIComponent(code)}?embed=1`, { headers });
    if (r.status === 404) throw new Error(`HTTP 404 ${url}`);
    const d = JSON.parse(await r.text());
    const src = d.hls || d.mp4;
    if (!src) return [];
    const out = { url: src, quality: 'auto', headers: { Referer: `${u.origin}/`, Origin: u.origin, 'User-Agent': UA } };
    if (d.hls) {
        try {
            const master = await (await fetch(d.hls, { headers: out.headers })).text();
            const tracks = audioTracks(master);
            // separate audio tracks listed and none of them German: not a German version
            if (tracks.length && !tracks.some(isGerman)) return [];
            const bw = Math.max(0, ...[...master.matchAll(/BANDWIDTH=(\d+)/g)].map(m => Number(m[1])));
            const res = (master.match(/RESOLUTION=\d+x(\d+)/) || [])[1];
            out.quality = res ? `${res}p` : bw >= 8e6 ? '1080p' : 'auto';
            if (tracks.length) out.audio = tracks.map(t => t.lang || t.name).join('+');
        } catch (e) { /* playlist not readable from here: keep the address */ }
    }
    return [out];
}

const forPlugins = url => extract(url);
module.exports = { extract, forPlugins, audioTracks, isGerman };
