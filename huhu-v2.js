// Huhu moved to the open "mHub addon protocol v2" (spec: github.com/MediaHubMX/protocol). Its old endpoint
// (/mediaurl-source.json) is gone, so the plugin found nothing any more. This asks the new public endpoint
//   GET /vod/source/{video|series}/tmdb:<id>[:season:episode].json?language=de&region=DE
// and hands the links to the plugin in its old shape, so the plugin's own host readers (VOE, Dood, Filemoon, ...)
// keep working unchanged. Endpoints may answer with a "clientFetch" task (fetch this URL for me and send back the
// result); this server does that itself, as the protocol describes.
'use strict';

const BASE = (process.env.HUHU_BASE || 'https://huhu.to/vod').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_TASKS = 5;

async function readJson(res, what) {
    const text = await res.text();
    if (res.status === 404) return { sources: [] };                         // spec: 404 = no sources
    if (res.status === 401) throw new Error(`${what}: Huhu wants a signed app identity for this (identity_required)`);
    if (res.status === 429) throw new Error(`${what}: rate limited`);
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
    try { return JSON.parse(text); } catch (e) { throw new Error(`${what}: not JSON (${text.slice(0, 60).replace(/\s+/g, ' ')})`); }
}

// answer clientFetch tasks until the real response arrives
async function follow(data, what) {
    for (let i = 0; data && data.clientFetch && i < MAX_TASKS; i++) {
        const t = data.clientFetch;
        const r = await fetch(t.url, { method: t.method || 'GET', headers: Object.assign({ 'User-Agent': UA }, t.headers || {}), body: t.body });
        const buf = Buffer.from(await r.arrayBuffer());
        const textual = /json|text|xml|javascript|html/i.test(r.headers.get('content-type') || '') || !buf.includes(0);
        const headers = {};
        r.headers.forEach((v, k) => { headers[k] = v; });
        data = await readJson(await fetch(`${BASE}/client-fetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
            body: JSON.stringify({ id: t.id, status: r.status, headers, body: textual ? buf.toString('utf8') : buf.toString('base64'), encoding: textual ? 'utf-8' : 'base64' }),
        }), `${what} (task ${i + 1})`);
    }
    if (data && data.clientFetch) throw new Error(`${what}: too many fetch tasks`);
    return data;
}

// meta: the plugin's { type: 'movie'|'tv', tmdbId, imdbId } -> [{ type: 'url', url, languages, tag }]
async function sources(meta, season, episode) {
    const tv = meta.type === 'tv';
    const ids = [`tmdb:${meta.tmdbId}`].concat(meta.imdbId ? [`imdb:${meta.imdbId}`] : []);
    let list = [];
    for (const id of ids) {
        const full = tv ? `${id}:${season}:${episode}` : id;
        const url = `${BASE}/source/${tv ? 'series' : 'video'}/${full}.json?language=de&region=DE`;
        const data = await follow(await readJson(await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }), 'huhu source'), 'huhu source');
        list = (data && data.sources) || [];
        if (list.length) break;                                             // tmdb answered; imdb only as a second try
    }
    return list
        .filter(s => s && s.url && s.kind !== 'website')
        .map(s => ({ type: 'url', url: s.url, languages: Array.isArray(s.languages) && s.languages.length ? s.languages : ['de'], tag: [s.name, s.quality].filter(Boolean).join(' ') }));
}

// the plugin text gets this appended: its own sources() is replaced, everything else stays
const PATCH = `\n;sources = function (meta, season, episode) { return require(${JSON.stringify(__filename)}).sources(meta, season, episode); };\n`;

module.exports = { sources, follow, PATCH };
