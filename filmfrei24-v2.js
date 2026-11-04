// FilmFrei24 rebuilt its site: the film list is no longer inside the page ("const ALL_FILMS"), so the plugin found
// nothing. The site's own app now uses two plain JSON calls (no login):
//   /beta/api.php?q=catalog&part=core                         -> { films: [{ id, title, year, min, lang }], series: [...] }
//   /beta/api.php?q=play&type=f|s&id=<id>[&season=&ep=]       -> { ok, src }   (HLS playlist or MP4)
// Titles are matched against TMDB (German + original title, year).
'use strict';

const BASE = process.env.FF24_BASE || 'https://filmfrei24.com';
const API = `${BASE}/beta/api.php`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Accept: 'application/json', Referer: BASE + '/' };

let catalog = null;   // { time, value }
async function getCatalog() {
    if (catalog && Date.now() - catalog.time < 3 * 3600 * 1000) return catalog.value;
    const r = await fetch(`${API}?q=catalog&part=core`, { headers: H, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`catalog HTTP ${r.status}`);
    const value = await r.json();
    if (!Array.isArray(value.films) && !Array.isArray(value.series)) throw new Error('catalog without films/series');
    catalog = { time: Date.now(), value };
    return value;
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, ' ').trim();

async function tmdbMeta(tmdbId, tv) {
    const r = await fetch(`https://api.themoviedb.org/3/${tv ? 'tv' : 'movie'}/${tmdbId}?api_key=${globalThis.TMDB_API_KEY}&language=de-DE&append_to_response=alternative_titles`);
    if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
    const d = await r.json();
    const alts = ((d.alternative_titles || {}).titles || (d.alternative_titles || {}).results || [])
        .filter(a => a.iso_3166_1 === 'DE' || a.iso_3166_1 === 'AT').map(a => a.title);
    const date = d.release_date || d.first_air_date || '';
    return { titles: [d.title || d.name, d.original_title || d.original_name].concat(alts).filter((t, i, a) => t && a.indexOf(t) === i), year: Number(date.slice(0, 4)) || 0 };
}

function pick(list, meta) {
    const names = meta.titles.map(norm);
    const hits = list.filter(it => !it.soon && names.includes(norm(it.title)));
    if (!hits.length) return null;
    // same name, several years (remakes): the one closest to TMDB's year, at most 1 year off
    const scored = hits.map(it => ({ it, off: meta.year && Number(it.year) ? Math.abs(Number(it.year) - meta.year) : 0 }))
        .filter(x => x.off <= 1).sort((a, b) => a.off - b.off);
    return scored.length ? scored[0].it : null;
}

async function getStreams(tmdbId, type, season, episode) {
    try {
        const tv = type === 'tv';
        if (tv && (!season || !episode)) return [];
        const cat = await getCatalog();
        const hit = pick((tv ? cat.series : cat.films) || [], await tmdbMeta(tmdbId, tv));
        if (!hit) return [];
        const q = `${API}?q=play&type=${tv ? 's' : 'f'}&id=${encodeURIComponent(hit.id)}${tv ? `&season=${season}&ep=${episode}` : ''}`;
        const r = await fetch(q, { headers: H, signal: AbortSignal.timeout(15000) });
        if (!r.ok) return [];
        const d = await r.json();
        if (!d || !d.ok || !d.src || d.ready === false) return [];
        const src = new URL(d.src, BASE + '/').toString();
        const lang = !hit.lang || /deutsch|german|^de$/i.test(hit.lang) ? 'Deutsch' : hit.lang;
        return [{
            name: `FilmFrei24 · ${lang} · filmfrei24`,
            title: d.sub ? `${d.title} · ${d.sub}` : d.title,
            url: src,
            quality: /1080|fhd/i.test(String(hit.quality)) ? '1080p' : 'auto',
            headers: { Referer: BASE + '/', 'User-Agent': UA },
        }];
    } catch (e) {
        console.error(`[FilmFrei24] ${e.message}`);
        return [];
    }
}

module.exports = { getStreams, pick, norm };
