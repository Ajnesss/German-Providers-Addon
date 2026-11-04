// German public broadcasters' Mediatheken (ZDF, ZDFneo, 3sat, KiKA, Phoenix, ARD channels, ...) through
// MediathekViewWeb, the open index behind MediathekView (public API: POST https://mediathekviewweb.de/api/query).
// Free and legal; ZDF alone carries many dubbed series and films (Inspector Barnaby, current feature films).
// Matching: series by show name + the episode's German title (or the broadcaster's "(S01/E05)"), films by title
// + length. Only the German main version: no audio description, sign language, original-language versions.
'use strict';

const API = process.env.MVW_API || 'https://mediathekviewweb.de/api/query';
const UA = 'Mozilla/5.0 (compatible; GermanProvidersAddon/1.7)';
// Austrian/Swiss broadcasters only play inside their country; arte's other-language channels aren't German
const SKIP_CHANNELS = /^(ORF|SRF|ARTE\.(FR|EN|ES|IT|PL))$/i;   // ORF: only its worldwide files, see geoOk
const NOT_MAIN = /audiodeskription|h(ö|oe)rfassung|geb(ä|ae)rdensprache|klare sprache|\(englisch\)|\(franz(ö|oe)sisch\)|\(originalversion\)|\(ov\)|\(omu\)|\bomu\b|trailer|vorschau|making-of|\(mit untertitel\)/i;

const cache = new Map();
async function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    cache.set(key, { t: Date.now(), v });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return v;
}
async function getJson(url) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}
async function query(queries, extra = {}) {
    const body = JSON.stringify(Object.assign({ queries, sortBy: 'timestamp', sortOrder: 'desc', future: false, offset: 0, size: 200 }, extra));
    return cached(body, 3 * 3600 * 1000, async () => {
        const r = await fetch(API, { method: 'POST', body, headers: { 'Content-Type': 'text/plain', 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`mediathekviewweb HTTP ${r.status}`);
        const d = await r.json();
        return (d.result && d.result.results) || [];
    });
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, ' ').trim();
// "Herzschmerzen (1) (S18/E08)" -> "Herzschmerzen (1)";  "Flieg Mörder, flieg - Nach Motiven von ..." -> "Flieg Mörder, flieg"
const cleanTitle = t => String(t || '').replace(/\(S\d+\/E\d+\)/gi, '').replace(/\s+-\s+(nach motiven|nach dem roman|nach einer).*$/i, '').replace(/\s+/g, ' ').trim();
const sxe = t => { const m = String(t || '').match(/\(S(\d+)\/E(\d+)\)/i) || String(t || '').match(/Staffel\s*(\d+),?\s*Folge\s*(\d+)/i); return m ? [Number(m[1]), Number(m[2])] : null; };
const generic = name => !name || /^(folge|episode|teil)\s*\d+$/i.test(name.trim());

function quality(url) {
    const k = Number((String(url).match(/_(\d{3,5})k_p\d+/) || [])[1]) || 0;
    if (/1080|fhd/i.test(url) || k >= 5000) return '1080p';
    if (/720|_hd\b/i.test(url) || k >= 2500) return '720p';
    return k ? '480p' : 'auto';
}
function toStreams(hit, title) {
    const files = [hit.url_video_hd, hit.url_video].filter((u, i, a) => u && a.indexOf(u) === i);
    const ch = String(hit.channel || 'Mediathek');
    return files.slice(0, 2).map(u => ({
        name: `${ch} · Deutsch · ${ch} Mediathek`,
        title: title || hit.title,
        url: u.replace(/^http:\/\//, 'https://'),
        quality: quality(u),
    }));
}
// ORF marks the files it may show abroad ("cms-worldwide"): those play from Germany too, the rest is Austria-only
const geoOk = h => !/^ORF$/i.test(h.channel || '') || /worldwide/i.test(h.url_video_hd || h.url_video || '');
const usable = h => h && (h.url_video_hd || h.url_video) && (!SKIP_CHANNELS.test(h.channel || '') || geoOk(h)) && geoOk(h) && !NOT_MAIN.test(h.title || '');

async function tmdb(path) {
    return getJson(`https://api.themoviedb.org/3/${path}${path.includes('?') ? '&' : '?'}api_key=${globalThis.TMDB_API_KEY}`);
}

async function episode(tmdbId, season, ep) {
    const show = await tmdb(`tv/${tmdbId}?language=de-DE`);
    const names = [show.name, show.original_name].filter((n, i, a) => n && a.indexOf(n) === i);
    const e = await tmdb(`tv/${tmdbId}/season/${season}/episode/${ep}?language=de-DE`).catch(() => null);
    const epName = e && !generic(e.name) ? cleanTitle(e.name) : null;
    for (const name of names) {
        const list = (await query([{ fields: ['topic'], query: name }])).filter(usable)
            .filter(h => { const t = norm(h.topic); return t === norm(name) || t === norm(name) + ' ' + norm('staffel ' + season); });
        if (!list.length) continue;
        let hits = epName ? list.filter(h => norm(cleanTitle(h.title)) === norm(epName)) : [];
        // the broadcaster's own numbering, if the German title didn't settle it
        if (!hits.length) hits = list.filter(h => { const n = sxe(h.title); return n && n[0] === Number(season) && n[1] === Number(ep); });
        if (hits.length) {
            const best = hits.sort((a, b) => (b.url_video_hd ? 1 : 0) - (a.url_video_hd ? 1 : 0))[0];
            return toStreams(best, `${cleanTitle(best.title)}`);
        }
    }
    return [];
}

async function movie(tmdbId) {
    const m = await tmdb(`movie/${tmdbId}?language=de-DE`);
    const titles = [m.title, m.original_title].filter((n, i, a) => n && a.indexOf(n) === i);
    const runtime = Number(m.runtime) || 0;
    for (const t of titles) {
        const list = (await query([{ fields: ['title'], query: t }], { duration_min: 50 * 60 })).filter(usable)
            .filter(h => norm(cleanTitle(h.title)) === norm(t))
            .filter(h => !runtime || Math.abs(h.duration / 60 - runtime) <= Math.max(15, runtime * 0.2));
        if (list.length) return toStreams(list.sort((a, b) => (b.url_video_hd ? 1 : 0) - (a.url_video_hd ? 1 : 0))[0], m.title);
    }
    return [];
}

// provider in the plugins' shape
async function getStreams(tmdbId, type, season, ep) {
    try {
        if (type === 'movie') return await movie(tmdbId);
        if (season && ep) return await episode(tmdbId, season, ep);
    } catch (e) {
        console.error(`[Mediathek] ${e.message}`);
    }
    return [];
}

module.exports = { getStreams, cleanTitle, sxe, norm, quality };
