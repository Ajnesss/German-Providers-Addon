// ARD daily soaps ("Sturm der Liebe", "Rote Rosen" …). ARD lists them on an "editorial" page and numbers them straight
// through ("Folge 4664"), so the regular ARD provider never finds them. This provider matches an episode by its
// first broadcast date: TMDB's air date for SxEy  ==  the day ARD broadcast that "Folge".
'use strict';

const API = process.env.ARD_API || 'https://api.ardmediathek.de';
const TTL = 3 * 3600 * 1000;
const cache = new Map();   // key -> { time, value }
async function cached(key, fn, ttl = TTL) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < ttl) return hit.value;
    const value = await fn();
    cache.set(key, { time: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
}
async function getJson(url) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}
const title = t => (t.shortTitle || t.longTitle || t.title || '').trim();
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const ACCESSIBLE = /Audiodeskription|Gebärdensprache|Klare Sprache|\(AD\)|\(DGS\)/i;
// broadcast day in German time (soaps air in the afternoon, so the UTC date is the same day anyway)
const berlinDay = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

async function allTeasers(widget) {
    let teasers = widget.teasers || [];
    const self = ((widget.links || {}).self || {}).href;
    const total = (widget.pagination || {}).totalElements || 0;
    if (self && total > teasers.length) {
        teasers = [];
        for (let p = 0; teasers.length < Math.min(total, 1000); p++) {
            const next = (await getJson(self.replace(/pageNumber=\d+/, `pageNumber=${p}`).replace(/pageSize=\d+/, 'pageSize=200'))).teasers || [];
            if (!next.length) break;
            teasers = teasers.concat(next);
        }
    }
    return teasers;
}

// show name -> { day: teaser } of its full episodes (only the soap's own "Ganze Folgen" lists: reruns on ONE carry
// the rerun date, not the original one)
async function soapEpisodes(name) {
    return cached(`soap:${norm(name)}`, async () => {
        const d = await getJson(`${API}/search-system/search/shows/ard?query=${encodeURIComponent(name)}&pageSize=30&platform=MEDIA_THEK&sortingCriteria=SCORE_DESC`);
        const hit = (d.teasers || []).find(t => t.type === 'editorialPage' && norm(title(t)) === norm(name));
        if (!hit) return null;
        const target = (hit.links || {}).target || {};
        const page = await getJson(`${API}/page-gateway/pages/ard/editorial/${encodeURIComponent(target.urlId || target.id)}?embedded=true`);
        const byDay = {};
        for (const w of (page.widgets || []).filter(w => w.compilationType === 'filter' && !/\bONE\b/.test(w.title || ''))) {
            for (const t of await allTeasers(w)) {
                if (t.coreAssetType !== 'EPISODE' || !t.broadcastedOn || ACCESSIBLE.test(title(t)) || !/Folge\s*\d+/i.test(title(t))) continue;
                const day = berlinDay(t.broadcastedOn);
                if (!byDay[day]) byDay[day] = t;
            }
        }
        return byDay;
    });
}

// one ARD video -> playable files (standard audio only, not audio description / speech-optimised)
async function media(itemId) {
    return cached(`item:${itemId}`, async () => {
        const item = await getJson(`${API}/page-gateway/pages/ard/item/${encodeURIComponent(itemId)}?embedded=true&mcV6=true`);
        const player = (item.widgets || []).find(w => /^player/.test(w.type || ''));
        const embedded = player && player.mediaCollection && player.mediaCollection.embedded;
        if (!embedded) return [];
        let list = [].concat(...(embedded.streams || []).map(s => s.media || []));
        const standard = list.filter(m => !(m.audios || []).some(a => a.kind === 'audio-description' || a.kind === 'speech-optimized'));
        if (standard.length) list = standard;
        return list.filter(m => m.url).map(m => ({
            url: m.url.startsWith('//') ? 'https:' + m.url : m.url,
            hls: /mpegurl/i.test(m.mimeType || '') || /\.m3u8/.test(m.url),
            res: m.maxVResolutionPx || 0,
        }));
    }, 30 * 60000);
}

// provider in the same shape as the plugins: getStreams(tmdbId, type, season, episode)
async function getStreams(tmdbId, type, season, episode) {
    if (type !== 'tv' || !season || !episode) return [];
    const key = globalThis.TMDB_API_KEY;
    const show = await getJson(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${key}&language=de-DE`);
    // only German soaps are worth an ARD look
    if (!(show.origin_country || []).includes('DE') && show.original_language !== 'de') return [];
    const ep = await getJson(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${episode}?api_key=${key}&language=de-DE`).catch(() => null);
    if (!ep || !ep.air_date) return [];
    let byDay = null;
    for (const name of [show.name, show.original_name].filter((n, i, a) => n && a.indexOf(n) === i)) {
        byDay = await soapEpisodes(name).catch(() => null);
        if (byDay) break;
    }
    const t = byDay && byDay[ep.air_date];
    if (!t) return [];
    const files = (await media(((t.links || {}).target || {}).id || t.id))
        .sort((a, b) => (b.hls - a.hls) || b.res - a.res).slice(0, 2);
    return files.map(f => ({
        name: 'ARD · Deutsch · ARD Mediathek',
        title: title(t),
        url: f.url,
        quality: f.res ? `${f.res}p` : 'auto',
    }));
}

module.exports = { getStreams, media, soapEpisodes };
