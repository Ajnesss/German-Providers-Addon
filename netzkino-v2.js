// Netzkino (netzkino.de): free, ad-funded German films (about 4,000 titles), German versions.
// The old plugin used Netzkino's previous API (api.netzkino.de.simplecache.net), which no longer answers. The current
// site gets its catalogue from Netzkino's public data API (data.netzkino.de/netzkino/graphql), where every film
// carries its IMDb id, so films are matched exactly instead of by title.
// Only films the site itself plays as a plain MP4 are used: titles Netzkino protects with DRM (a DASH address under
// /DRM/) are left out, even when an older plain file still exists for them.
// The files come from Netzkino's German servers and go through the Frankfurt server (like the other German sources).
'use strict';

const API = process.env.NETZKINO_API || 'https://data.netzkino.de/netzkino/graphql';
const FILES = process.env.NETZKINO_FILES || 'https://pmd.netzkino-seite.netzkino.de/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const cache = new Map();

async function gql(query, variables) {
    const key = JSON.stringify([query, variables]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.v;
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA, Origin: 'https://www.netzkino.de', Referer: 'https://www.netzkino.de/' },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Netzkino API HTTP ${r.status}`);
    const d = await r.json();
    if (d.errors && d.errors.length) throw new Error(`Netzkino API: ${d.errors[0].message}`);
    cache.set(key, { t: Date.now(), v: d.data });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return d.data;
}

const FIELDS = 'title slug imdbIdentifier productionYear isStreamable activeLicenseOnPlatform videoSource { pmdUrl dashUrl hlsUrl }';
const BY_IMDB = `query($id: String!) { allCmsMovies(first: 5, condition: { imdbIdentifier: $id }) { nodes { ${FIELDS} } } }`;
const BY_TITLE = `query($t: String!) { allCmsMovies(first: 10, filter: { title: { equalToInsensitive: $t } }) { nodes { ${FIELDS} } } }`;

// can this film be played here as a plain file, the way Netzkino's own site plays it?
function playable(m) {
    const v = m.videoSource || {};
    if (!m.isStreamable || !v.pmdUrl) return false;
    if (v.dashUrl && /\/DRM\//i.test(v.dashUrl)) return false;
    const lic = m.activeLicenseOnPlatform;
    return !Array.isArray(lic) || !lic.length || lic.some(x => /netzkino/i.test(x));
}
const fileUrl = p => FILES + String(p).split('/').map(encodeURIComponent).join('/');

async function tmdb(path) {
    const r = await fetch(`https://api.themoviedb.org/3/${path}${path.includes('?') ? '&' : '?'}api_key=${globalThis.TMDB_API_KEY}`);
    if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
    return r.json();
}

async function getStreams(tmdbId, type) {
    if (type !== 'movie') return [];
    try {
        const d = await tmdb(`movie/${tmdbId}?language=de-DE&append_to_response=external_ids`);
        const imdb = d.imdb_id || (d.external_ids || {}).imdb_id;
        let films = imdb ? (await gql(BY_IMDB, { id: imdb })).allCmsMovies.nodes : [];
        if (!films.length) {
            // no IMDb id on one side: the German title and the year have to match exactly
            const year = Number(String(d.release_date || '').slice(0, 4));
            for (const t of [d.title, d.original_title].filter((x, i, a) => x && a.indexOf(x) === i)) {
                films = (await gql(BY_TITLE, { t })).allCmsMovies.nodes.filter(m => !m.imdbIdentifier && year && Math.abs(Number(m.productionYear) - year) <= 1);
                if (films.length) break;
            }
        }
        return films.filter(playable).slice(0, 1).map(m => ({
            name: 'Netzkino · Deutsch · Netzkino',
            title: `${m.title}${m.productionYear ? ' (' + m.productionYear + ')' : ''}`,
            url: fileUrl(m.videoSource.pmdUrl),
            quality: 'auto',
            headers: { Referer: 'https://www.netzkino.de/' },
        }));
    } catch (e) {
        console.error(`[Netzkino] ${e.message}`);
        return [];
    }
}

module.exports = { getStreams, playable };
