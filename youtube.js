// Full episodes on the official German YouTube channels of a series (e.g. "Chuggington Deutsch - Offizieller Kanal
// von TOGGO"), through the YouTube Data API v3. The stream is handed to Nuvio as a YouTube id ("ytId"), which the
// app plays in its own player. Only channels whose name carries the series name AND "Deutsch"/"offiziell" count,
// and only videos whose title contains the episode's German title and whose length fits one episode (no clips,
// no hour-long compilations). Series only: free films on YouTube are too often unofficial uploads to trust.
//
// Quota (10,000 units a day, free): finding a show's channel costs ~100 once a week, its episode list a few units a
// day; matching an episode costs nothing extra.
'use strict';

// the key only works from this server's address (restricted to 158.180.36.87 in Google Cloud), so it is harmless
// in a public repository; YT_API_KEY overrides it
const KEY = (process.env.YT_API_KEY || 'AIzaSyBMufKaUnMoKQbd9j4Lj3DeEvLMe7caUBU').trim();
const API = process.env.YT_API || 'https://www.googleapis.com/youtube/v3';
const MAX_PAGES = Number(process.env.YT_MAX_PAGES) || 30;          // 50 videos per page
// Nuvio plays YouTube videos on the TV itself, so a video has to be allowed in the viewer's country. Many German
// channels (TOGGO, ...) only allow Germany/Austria/Switzerland: those are left out for a viewer elsewhere.
const REGION = (process.env.YT_REGION || 'GB').toUpperCase();
const OFFICIAL = /deutsch|offiziell|german|toggo|kika|super ?rtl|nick(elodeon)? (de|deutschland)|disney (junior|channel) (de|deutschland)/i;
const NOT_EPISODE = /trailer|teaser|clip|ausschnitt|#shorts|\bshorts\b|making.?of|best of|zusammenschnitt|compilation|marathon|\b\d+\s*(stunden?|std)\b|eine stunde|\b\d+\s*min(uten)?\b|folgen am st(ü|ue)ck/i;

const fetchJson = async url => {
    // straight from this server: the key is bound to its address
    const f = (() => { try { return require('./net.js').nativeFetch; } catch (e) { return fetch; } })();
    const r = await f(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`YouTube API ${r.status}: ${((d.error || {}).message || '').slice(0, 120)}`);
    return d;
};
const cache = new Map();
async function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    cache.set(key, { t: Date.now(), v });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return v;
}
const DAY = 24 * 3600 * 1000;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, ' ').trim();
const has = (hay, needle) => (' ' + norm(hay) + ' ').includes(' ' + norm(needle) + ' ');
const seconds = iso => { const m = String(iso || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || []; return ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0); };
const generic = name => !name || /^(folge|episode|teil)\s*\d+$/i.test(name.trim());

// the series' official German channel, or null (remembered for a week either way)
async function channelFor(names) {
    return cached(`ch:${names.map(norm).join('|')}`, 7 * DAY, async () => {
        for (const name of names) {
            const d = await fetchJson(`${API}/search?part=snippet&type=channel&maxResults=10&regionCode=DE&relevanceLanguage=de&q=${encodeURIComponent(name + ' Deutsch')}&key=${KEY}`);
            const hit = (d.items || []).map(i => ({ id: i.id && i.id.channelId, title: (i.snippet || {}).channelTitle || (i.snippet || {}).title || '' }))
                .find(c => c.id && has(c.title, name) && OFFICIAL.test(c.title));
            if (hit) return hit;
        }
        return null;
    });
}

// every upload of a channel with its length: [{ id, title, sec }]
async function uploads(channelId) {
    return cached(`up:${channelId}`, DAY, async () => {
        const list = [];
        let page = '';
        for (let i = 0; i < MAX_PAGES; i++) {
            const d = await fetchJson(`${API}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=UU${channelId.slice(2)}${page ? '&pageToken=' + page : ''}&key=${KEY}`);
            for (const it of d.items || []) list.push({ id: (it.contentDetails || {}).videoId, title: (it.snippet || {}).title || '' });
            page = d.nextPageToken;
            if (!page) break;
        }
        for (let i = 0; i < list.length; i += 50) {
            const part = list.slice(i, i + 50);
            const d = await fetchJson(`${API}/videos?part=contentDetails&id=${part.map(v => v.id).join(',')}&key=${KEY}`);
            const info = new Map((d.items || []).map(v => [v.id, v.contentDetails || {}]));
            part.forEach(v => {
                const c = info.get(v.id) || {};
                const r = c.regionRestriction || {};
                v.sec = seconds(c.duration);
                v.allowed = r.allowed || null;
                v.blocked = r.blocked || null;
            });
        }
        return list.filter(v => v.id && v.sec);
    });
}

async function tmdb(path) {
    const r = await fetch(`https://api.themoviedb.org/3/${path}${path.includes('?') ? '&' : '?'}api_key=${globalThis.TMDB_API_KEY}`);
    if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
    return r.json();
}

const playableHere = v => (!v.allowed || v.allowed.includes(REGION)) && !(v.blocked || []).includes(REGION);
function pick(videos, epName, runtimeMin) {
    const rt = (runtimeMin || 0) * 60;
    const fits = v => !rt || (v.sec >= rt * 0.6 && v.sec <= Math.max(rt * 2.5, 30 * 60));
    return videos.filter(v => has(v.title, epName) && !NOT_EPISODE.test(v.title) && fits(v) && playableHere(v))
        .sort((a, b) => a.sec - b.sec)[0] || null;
}

async function getStreams(tmdbId, type, season, episode) {
    if (!KEY || type !== 'tv' || !season || !episode) return [];
    try {
        const show = await tmdb(`tv/${tmdbId}?language=de-DE`);
        const ep = await tmdb(`tv/${tmdbId}/season/${season}/episode/${episode}?language=de-DE`).catch(() => null);
        if (!ep || generic(ep.name)) return [];
        const names = [show.name, show.original_name].filter((n, i, a) => n && a.indexOf(n) === i);
        const ch = await channelFor(names);
        if (!ch) return [];
        const runtime = ep.runtime || (show.episode_run_time || [])[0] || 0;
        const v = pick(await uploads(ch.id), ep.name, runtime);
        if (!v) return [];
        return [{ name: `YouTube · Deutsch · ${ch.title.split(/\s+[-|–]\s+/)[0]}`, title: v.title, ytId: v.id, quality: 'auto' }];
    } catch (e) {
        console.error(`[YouTube] ${e.message}`);
        return [];
    }
}

module.exports = { getStreams, pick, seconds, norm, has, playableHere };
