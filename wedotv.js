// wedotv (wedotv.com, watch4 platform): free, ad-funded films and series, German versions in Germany.
// Every title has a page /de-de/<slug> with JSON-LD (name, year, length, inLanguage) and the video ids; the site's
// own player asks /api-v2/player_video.php?video_id=<id> for a plain HLS address (no DRM, up to 1080p).
// wedotv picks the version by the viewer's country: asked from the Frankfurt server it answers with the German
// version (content_language=de), and the video goes through that server, so it works for a viewer in the UK too.
'use strict';

const BASE = process.env.WEDOTV_BASE || 'https://www.wedotv.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const cache = new Map();
async function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    cache.set(key, { t: Date.now(), v });
    if (cache.size > 800) cache.delete(cache.keys().next().value);
    return v;
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, ' ').trim();
const slug = s => String(s || '').toLowerCase().replace(/['’`]/g, '').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const minutes = iso => { const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/); return m ? (+m[1] || 0) * 60 + (+m[2] || 0) : 0; };

async function page(path) {
    return cached(`p:${path}`, 6 * 3600 * 1000, async () => {
        const r = await fetch(`${BASE}/de-de/${path}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) return null;
        const html = await r.text();
        const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => { try { return JSON.parse(m[1]); } catch (e) { return null; } })
            .flatMap(j => (j && j['@graph']) || [j]).find(j => j && (j['@type'] === 'Movie' || j['@type'] === 'TVSeries'));
        return ld ? { html, ld, url: `${BASE}/de-de/${path}` } : null;
    });
}

// a title's page: try the slugs of its German, original and English titles
async function find(titles, type, year) {
    const tried = new Set();
    for (const t of titles) {
        for (const s of [slug(t), slug(t) + '_1']) {
            if (!s || tried.has(s)) continue;
            tried.add(s);
            const p = await page(s).catch(() => null);
            if (!p || p.ld['@type'] !== type) continue;
            if (!titles.some(x => norm(x) === norm(p.ld.name))) continue;
            const y = Number(String(p.ld.copyrightYear || p.ld.datePublished || '').slice(0, 4));
            if (type === 'Movie' && year && y && Math.abs(y - year) > 1) continue;
            return p;
        }
    }
    return null;
}

async function source(videoId, referer) {
    const r = await fetch(`${BASE}/api-v2/player_video.php?video_id=${encodeURIComponent(videoId)}&_cb=${Date.now()}`,
        { headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    const d = JSON.parse(text.slice(Math.max(0, text.indexOf('{'))));
    if (d.error || !d.video_source) return null;
    const lang = (String(d.vast_tag || '').match(/content_language=([a-z]{2})/) || [])[1] || 'de';
    return { url: d.video_source, lang, seconds: Number(d.duration) || 0, title: d.title };
}

async function tmdb(path) {
    const r = await fetch(`https://api.themoviedb.org/3/${path}${path.includes('?') ? '&' : '?'}api_key=${globalThis.TMDB_API_KEY}`);
    if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
    return r.json();
}
function titlesOf(d) {
    const tr = ((d.translations || {}).translations || []).find(x => x.iso_639_1 === 'en');
    const alts = ((d.alternative_titles || {}).titles || (d.alternative_titles || {}).results || [])
        .filter(a => a.iso_3166_1 === 'DE' || a.iso_3166_1 === 'AT').map(a => a.title);
    return [d.title || d.name, d.original_title || d.original_name, tr && tr.data && (tr.data.title || tr.data.name)].concat(alts)
        .filter((t, i, a) => t && a.indexOf(t) === i);
}
const LANG = { de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch' };

async function getStreams(tmdbId, type, season, episode) {
    try {
        if (type === 'movie') {
            const d = await tmdb(`movie/${tmdbId}?language=de-DE&append_to_response=translations,alternative_titles`);
            const p = await find(titlesOf(d), 'Movie', Number(String(d.release_date || '').slice(0, 4)));
            if (!p) return [];
            const runtime = Number(d.runtime) || 0, len = minutes(p.ld.duration);
            if (runtime && len && Math.abs(runtime - len) > Math.max(15, runtime * 0.3)) return [];
            const id = (p.html.match(/id="start-player-button"[^>]*data-video-id="(\d+)"/) || p.html.match(/data-video-id="(\d+)"[^>]*id="start-player-button"/) || [])[1];
            const s = id && await source(id, p.url);
            return s ? [{ name: `wedotv · ${LANG[s.lang] || s.lang} · wedotv`, title: p.ld.name, url: s.url, quality: 'auto' }] : [];
        }
        if (!season || !episode) return [];
        const d = await tmdb(`tv/${tmdbId}?language=de-DE&append_to_response=translations,alternative_titles`);
        const p = await find(titlesOf(d), 'TVSeries');
        if (!p) return [];
        // episode cards: data-season="1" data-episode="3" ... class="episode-card" ... data-video-id="12345"
        const re = new RegExp(`data-season="${Number(season)}" data-episode="${Number(episode)}"[^>]*class="episode-card`);
        const at = p.html.search(re);
        if (at < 0) return [];
        const id = (p.html.slice(at, at + 4000).match(/data-video-id="(\d+)"/) || [])[1];
        const s = id && await source(id, p.url);
        return s ? [{ name: `wedotv · ${LANG[s.lang] || s.lang} · wedotv`, title: `${p.ld.name} S${season}E${episode}`, url: s.url, quality: 'auto' }] : [];
    } catch (e) {
        console.error(`[wedotv] ${e.message}`);
        return [];
    }
}

module.exports = { getStreams, slug, norm };
