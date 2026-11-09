// Plex free films and shows (with your linked Plex account, see plex.js), as a stream source.
// Checked 9 Nov 2026 from the Frankfurt server: Plex's free catalogue in Germany ("Kostenloses Streaming") lists
// each title's files with their protection and audio tracks, e.g. "Leon muss sterben" (2017): HLS, drm:false,
// 1080p, audio "German (Stereo)".
// Rules:
//   - a title counts only if Plex's own record carries the same IMDb or TMDB id (no matching by name alone)
//   - only files without copy protection (drm:false), as HLS
//   - only files whose audio list contains a German track
// The address handed out is Plex's playlist without the token; the Frankfurt server adds the token when it fetches
// it (stream.js), so the token never reaches the player, and the video comes from Germany as Plex requires.
'use strict';

const plex = require('./plex.js');
const VOD = 'https://vod.provider.plex.tv';
const DISCOVER = 'https://discover.provider.plex.tv';
const cache = new Map();

async function get(url, ttl = 6 * 3600e3) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const r = await require('./net.js').nativeFetch(url, { headers: plex.headers(), signal: AbortSignal.timeout(12000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Plex HTTP ${r.status}`);
    const v = JSON.parse(await r.text()).MediaContainer || {};
    cache.set(url, { t: Date.now(), v });
    if (cache.size > 3000) cache.delete(cache.keys().next().value);
    return v;
}
async function tmdb(path) {
    const r = await fetch(`https://api.themoviedb.org/3/${path}${path.includes('?') ? '&' : '?'}api_key=${globalThis.TMDB_API_KEY}`);
    if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
    return r.json();
}

const germanAudio = media => ((media.Part || [])[0] || {}).Stream || [];
function playable(meta) {
    for (const m of meta.Media || []) {
        if (m.protocol !== 'hls' || m.drm !== false) continue;
        const part = (m.Part || [])[0];
        if (!part || !part.key) continue;
        const audio = germanAudio(m).filter(s => s.streamType === 2);
        if (!audio.some(s => /^(de|deu|ger)$/i.test(s.languageCode || '') || /^german|deutsch/i.test(s.language || ''))) continue;
        return { url: VOD + part.key, height: Number(m.height) || 0, audio: audio.map(s => s.languageCode).join('+') };
    }
    return null;
}
const sameIds = (meta, imdb, tmdbId) => (meta.Guid || []).some(g => (imdb && g.id === `imdb://${imdb}`) || g.id === `tmdb://${tmdbId}`);

// the free (vod) titles Plex finds for these names, of the given type
async function candidates(titles, type) {
    const out = new Map();
    for (const q of titles) {
        const u = `${DISCOVER}/library/search?query=${encodeURIComponent(q)}&limit=20&searchTypes=${type === 'movie' ? 'movies' : 'tv'}&searchProviders=discover,plexAVOD&includeMetadata=1`;
        const d = await get(u);
        for (const g of (d && d.SearchResults) || []) for (const x of g.SearchResult || []) {
            const m = x.Metadata || {};
            if (String(m.playableKey || '').startsWith('provider://tv.plex.provider.vod') && m.type === (type === 'movie' ? 'movie' : 'show')) out.set(m.ratingKey, m);
        }
        if (out.size) break;
    }
    return [...out.values()];
}

async function getStreams(tmdbId, type, season, episode) {
    if (!plex.token()) return [];
    const tv = type === 'tv';
    const d = await tmdb(`${tv ? 'tv' : 'movie'}/${tmdbId}?language=de-DE&append_to_response=external_ids`);
    const imdb = d.imdb_id || (d.external_ids || {}).imdb_id;
    const year = Number(String(d.release_date || d.first_air_date || '').slice(0, 4));
    const titles = [d.title || d.name, d.original_title || d.original_name].filter((t, i, a) => t && a.indexOf(t) === i);
    const list = (await candidates(titles, type)).filter(m => !year || !m.year || Math.abs(m.year - year) <= 1).slice(0, 4);
    for (const c of list) {
        const meta = ((await get(`${VOD}/library/metadata/${c.ratingKey}`)) || {}).Metadata;
        const item = meta && meta[0];
        if (!item || !sameIds(item, imdb, tmdbId)) continue;
        let target = item;
        if (tv) {
            const seasons = ((await get(`${VOD}/library/metadata/${c.ratingKey}/children`)) || {}).Metadata || [];
            const s = seasons.find(x => Number(x.index) === Number(season));
            if (!s) return [];
            const eps = ((await get(`${VOD}/library/metadata/${s.ratingKey}/children`)) || {}).Metadata || [];
            target = eps.find(x => Number(x.index) === Number(episode));
            if (!target) return [];
            if (!target.Media) target = (((await get(`${VOD}/library/metadata/${target.ratingKey}`)) || {}).Metadata || [])[0] || target;
        }
        const p = playable(target);
        if (!p) return [];
        return [{
            name: 'Plex · Deutsch · Plex',
            title: `${item.title}${item.year ? ' (' + item.year + ')' : ''}`,
            url: p.url,
            quality: p.height >= 1080 ? '1080p' : p.height >= 720 ? '720p' : p.height ? `${p.height}p` : 'auto',
        }];
    }
    return [];
}

module.exports = { getStreams, playable, sameIds };
