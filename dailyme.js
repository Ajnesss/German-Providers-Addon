// dailyme TV (dailyme.de): the parts of its free catalogue that it publishes openly, with plain HLS (no DRM, no login):
//   /fast/western.json  - classic western films, German versions  -> https://mini-cms.daygent.de/film/play/<id>.m3u8
//   /fast/ddr.json      - the "DDR TV-Archiv": East German TV series and films, original German
//                         -> https://mini-cms.daygent.de/ddr/play/<id>.m3u8
// Its other films need dailyme's app login ("Authentifizierung erforderlich"), so they are left out.
// The play addresses forward to short-lived CDN links; they go through the Frankfurt server.
'use strict';

const BASE = process.env.DAILYME_BASE || 'https://www.dailyme.de';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let lists = null;   // { time, western: [...], ddr: [...] }

async function json(path) {
    const r = await fetch(BASE + path, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
    return r.json();
}
async function catalogue() {
    if (lists && Date.now() - lists.time < 6 * 3600 * 1000) return lists;
    const [w, d] = await Promise.all([json('/fast/western.json').catch(() => ({})), json('/fast/ddr.json').catch(() => ({}))]);
    lists = { time: Date.now(), western: w.filme || [], ddr: d.serien || [] };
    return lists;
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, ' ').trim();

async function tmdb(path) {
    const r = await fetch(`https://api.themoviedb.org/3/${path}${path.includes('?') ? '&' : '?'}api_key=${globalThis.TMDB_API_KEY}`);
    if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
    return r.json();
}
function titlesOf(d) {
    const alts = ((d.alternative_titles || {}).titles || (d.alternative_titles || {}).results || [])
        .filter(a => a.iso_3166_1 === 'DE' || a.iso_3166_1 === 'DD' || a.iso_3166_1 === 'AT').map(a => a.title);
    return [d.title || d.name, d.original_title || d.original_name].concat(alts).filter((t, i, a) => t && a.indexOf(t) === i).map(norm);
}

async function getStreams(tmdbId, type, season, episode) {
    try {
        const cat = await catalogue();
        if (type === 'movie') {
            const d = await tmdb(`movie/${tmdbId}?language=de-DE&append_to_response=alternative_titles`);
            const names = titlesOf(d);
            const year = Number(String(d.release_date || '').slice(0, 4));
            const runtime = Number(d.runtime) || 0;
            // a western whose German title matches, from the same year, of about the same length
            const main = t => norm(String(t || '').split(/\s[-–]\s/)[0]);   // "Johnny Guitar - Gejagt, gehaßt, gefürchtet" -> "johnny guitar"
            const f = cat.western.find(x => (names.includes(norm(x.t)) || names.includes(main(x.t)) || names.map(main).includes(main(x.t))) && (!year || !x.j || Math.abs(Number(x.j) - year) <= 1)
                && (!runtime || !x.m || Math.abs(runtime - x.m) <= Math.max(12, runtime * 0.25)));
            if (f) return [{ name: 'dailyme · Deutsch · Western', title: `${f.t} (${f.j || ''})`, url: `https://mini-cms.daygent.de/film/play/${encodeURIComponent(f.id)}.m3u8`, quality: 'auto' }];
            // single DDR TV films are listed as a "series" with one part
            const one = cat.ddr.find(x => names.includes(norm(x.t)) && (x.folgen || []).length === 1);
            if (one) return [{ name: 'dailyme · Deutsch · DDR TV-Archiv', title: one.t, url: one.folgen[0].v, quality: 'auto' }];
            return [];
        }
        if (!season || !episode) return [];
        const d = await tmdb(`tv/${tmdbId}?language=de-DE&append_to_response=alternative_titles`);
        const names = titlesOf(d);
        const s = cat.ddr.find(x => names.includes(norm(x.t)));
        if (!s) return [];
        const ep = (s.folgen || []).find(f => Number(f.s || 1) === Number(season) && Number(f.f) === Number(episode));
        return ep && ep.v ? [{ name: 'dailyme · Deutsch · DDR TV-Archiv', title: `${s.t} · ${ep.t || 'Folge ' + ep.f}`, url: ep.v, quality: 'auto' }] : [];
    } catch (e) {
        console.error(`[dailyme] ${e.message}`);
        return [];
    }
}

module.exports = { getStreams, norm };
