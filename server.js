#!/usr/bin/env node
// German Providers as a Stremio/Nuvio/AIOStreams addon.
// Wraps the Nuvio plugins from InvalidPandaa/nuvio-german-providers (GPL-3.0) in a normal addon server,
// and tags every stream with a binge group so "next episode" stays on the German source.
'use strict';

const http = require('http');
const net = require('./net.js');
const passthrough = require('./stream.js');
const ard = require('./mediathek.js');
let publicBase = (process.env.PUBLIC_URL || '').replace(/\/$/, '');   // learnt from the first request if not set
// the scrapers call the global fetch(): route it through the Chrome-like / WARP connection layer
globalThis.fetch = net.smartFetch;
const fetch = net.nativeFetch;   // this file's own calls (TMDB lookup, updates, relay) stay plain
const fs = require('fs');
const path = require('path');

// ---------- settings (environment variables) ----------
const PORT = Number(process.env.PORT) || 7000;
let TMDB_API_KEY = (process.env.TMDB_API_KEY || '').trim();
// a copy on another server (e.g. Oracle) can get the key from the main one (Render) with the relay password
const KEY_SOURCE = (process.env.KEY_SOURCE || 'https://german-providers-addon.onrender.com').replace(/\/$/, '');
const KEY_FILE = process.env.KEY_FILE || require('path').join(__dirname, '.tmdb-key');
let keyStatus = TMDB_API_KEY ? 'from settings' : 'missing';
function setKey(k, how) { TMDB_API_KEY = k; globalThis.TMDB_API_KEY = k; keyStatus = how; try { require('fs').writeFileSync(KEY_FILE, k); } catch (e) {} }
if (!TMDB_API_KEY) { try { const k = require('fs').readFileSync(KEY_FILE, 'utf8').trim(); if (k) { TMDB_API_KEY = k; keyStatus = 'saved earlier'; } } catch (e) {} }
// tmdb-key.enc (in the repo, encrypted with RELAY_TOKEN): the key survives every rebuild without Render
function keyFromRepo() {
    try {
        const c = require('crypto');
        const e = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'tmdb-key.enc'), 'utf8'));
        const k = c.scryptSync((process.env.RELAY_TOKEN || '').trim(), Buffer.from(e.salt, 'base64'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        const d = c.createDecipheriv('aes-256-gcm', k, Buffer.from(e.iv, 'base64'));
        d.setAuthTag(Buffer.from(e.tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8').trim();
    } catch (err) { return ''; }
}
const RELAY_TOKEN = (process.env.RELAY_TOKEN || '').trim();   // password for /relay/config and /setkey; also unlocks tmdb-key.enc
// Admin pages (debug fetch, set key, relay config) take their own password. Only its SHA-256 fingerprint is stored
// here, so the public repo never contains it. (RELAY_TOKEN above still unlocks tmdb-key.enc, nothing else.)
const ADMIN_HASH = (process.env.ADMIN_HASH || '93bd5e64a618aaf5f397cd631cd61dc06021e956b16a317f0ec750c93eaf47fd').trim().toLowerCase();
const adminOk = q => {
    const t = String((q && q.get('token')) || '');
    return !!t && require('crypto').createHash('sha256').update(t).digest('hex') === ADMIN_HASH;
};
if (!TMDB_API_KEY && process.env.RELAY_TOKEN) { const k = keyFromRepo(); if (k) { TMDB_API_KEY = k; keyStatus = 'from encrypted file'; } }
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 15000;       // how long the addon waits before answering
const CACHE_MIN = Number(process.env.CACHE_MINUTES) || 1440;      // reuse results; expired links refresh themselves on play
const SOFT_MS = process.env.SOFT_MS === undefined ? 6000 : Number(process.env.SOFT_MS);   // answer once German streams are in after this, don't wait for slow sites
const ONLY = (process.env.PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean);   // e.g. "serienstream,aniworld,ard"
const SKIP = (process.env.SKIP_PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean);
const AUTO_UPDATE = process.env.AUTO_UPDATE !== '0';               // pull the latest provider files from his repo
const UPDATE_URL = process.env.UPDATE_URL || 'https://invalidpandaa.github.io/nuvio-german-providers/';
const UPDATE_HOURS = Number(process.env.UPDATE_HOURS) || 12;
const PREFETCH = process.env.PREFETCH !== '0';                    // look up the next episode in advance
const PREFETCH_MIN = Number(process.env.PREFETCH_MINUTES) || 1440;  // how long a prefetched result is kept
let warpDownSince = 0;
setInterval(() => { if (net.warpOn()) warpDownSince = 0; else if (!warpDownSince) warpDownSince = Date.now(); }, 60000).unref();

globalThis.TMDB_API_KEY = TMDB_API_KEY;   // the plugins read the key from here, like inside Nuvio

// the plugin files normally live in ./providers; a GitHub web upload can flatten them into the main folder
const BUNDLED_DIR = fs.existsSync(path.join(__dirname, 'providers', 'manifest.json')) ? path.join(__dirname, 'providers') : __dirname;
const CACHE_DIR = process.env.DATA_DIR || path.join(__dirname, '.provider-cache');   // inside the project so require('cheerio') resolves

const log = (...a) => console.log(new Date().toISOString(), ...a.map(x => typeof x === 'string' ? x.replace(/(api_key=)[^&"\s]+/g, '$1***') : x));

// ---------- loading the plugins ----------
let providers = [];   // [{ id, name, types, mod, lock }]
let pluginVersion = '?';

// The plugins skip DoodStream on purpose (it answers plain requests with a Cloudflare check). This addon's
// connection layer gets past such checks, so the skip list is switched off while loading (ALLOW_DOOD=0 keeps it).
const Module = require('module');
function loadPlugin(file) {
    let code = fs.readFileSync(file, 'utf8');
    if (process.env.ALLOW_DOOD !== '0') {
        code = code.replace(/var BLOCKED = \[[^\]]*\];/, 'var BLOCKED = [];');
        // send Dood links to the plugin's own Dood extractor (player page /e/ with the video link), not the generic sniffer
        if (/^function dood\(/m.test(code)) code = code.replace(/^var HOSTS = \[/m, 'var HOSTS = [\n  [dood, ["dood", "d000d.com", "d0000d.com", "ds2play.com", "doodstream.com", "dooodster.com", "vide0.net", "dsvplay.com", "do7go.com", "playmogo.com", "doods.pro"]],');
    }
    // veev.to: no reader in the plugins (Moflix lists it for many episodes)
    if (process.env.VEEV !== '0' && /^var HOSTS = \[/m.test(code) && !code.includes('veev.to'))
        code = `var __veev = require(${JSON.stringify(path.join(__dirname, 'veev.js'))});\n` + code.replace(/^var HOSTS = \[/m, 'var HOSTS = [\n  [__veev.forPlugins, ["veev.to", "veev.pro", "poophq.com", "doods.to"]],');
    // vids.st: Moflix lists it for many films (1080p MP4s with German audio); no reader in the plugins
    if (process.env.VIDSST !== '0' && /^var HOSTS = \[/m.test(code) && !code.includes('vids.st'))
        code = `var __vidsst = require(${JSON.stringify(path.join(__dirname, 'vidsst.js'))});\n` + code.replace(/^var HOSTS = \[/m, 'var HOSTS = [\n  [__vidsst.forPlugins, ["vids.st"]],');
    // StreamOrigin (embedorigin.cc): Moflix lists it for films; a plain JSON player API, German audio checked in the playlist
    if (process.env.STREAMORIGIN !== '0' && /^var HOSTS = \[/m.test(code) && !code.includes('embedorigin'))
        code = `var __sorigin = require(${JSON.stringify(path.join(__dirname, 'streamorigin.js'))});\n` + code.replace(/^var HOSTS = \[/m, 'var HOSTS = [\n  [__sorigin.forPlugins, ["embedorigin.cc", "streamorigin.cc", "streamorigin.to"]],');
    // Filemoon moved to a new player ("Byse"); the plugins' old reader finds nothing there any more
    if (process.env.BYSE !== '0' && code.includes('[filemoon, ["filemoon"]]'))
        code = `var __byse = require(${JSON.stringify(path.join(__dirname, 'byse.js'))});\n` + code.replace('[filemoon, ["filemoon"]]', '[__byse.forPlugins, ["filemoon", "byse", "bysekoze"]]');
    // Huhu moved to the open mHub v2 protocol: its old endpoint is gone, the plugin asks the new one instead
    if (process.env.HUHU_V2 !== '0' && code.includes('mediaurl-source.json') && /^function sources\(/m.test(code))
        code += require('./huhu-v2.js').PATCH;
    // AniWorld films: stricter matching (no film of another series because of a generic word)
    // AniWorld/SerienStream: walking on through the site's seasons also checks whether the site splits its seasons
    // like IMDb (then IMDb's season/episode is used directly)
    if (process.env.NUMBERING_WALK !== '0' && /^function splitSeasonPath\(/m.test(code))
        code += require('./numbering-walk.js').PATCH;
    if (process.env.AW_FILMS !== '0' && code.includes('var BASE = "https://aniworld.to"') && /^function findMovie\(/m.test(code))
        code += require('./aniworld-films.js').PATCH;
    // let the SerienStream hand-off use the plugins' host readers (VOE, Dood, Filemoon, ...)
    if (/^function resolveEmbed\(/m.test(code)) code += '\n;try { module.exports.__resolveEmbed = resolveEmbed; } catch (e) {}\n';
    const m = new Module(file, module);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(code, file);
    return m.exports;
}

function loadFrom(dir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const list = [];
    for (const s of manifest.scrapers) {
        if (ONLY.length && !ONLY.includes(s.id)) continue;
        if (SKIP.includes(s.id)) continue;
        const file = path.resolve(dir, s.filename.replace(/^providers\//, ''));
        try {
            let mod = loadPlugin(file);
            // FilmFrei24 rebuilt its site; while the plugin still reads the old page, use the new site API instead
            if (s.id === 'filmfrei24' && process.env.FF24_V2 !== '0' && fs.readFileSync(file, 'utf8').includes('ALL_FILMS'))
                mod = require('./filmfrei24-v2.js');
            // Netzkino: its old API is gone; the current one (with IMDb ids) is used instead
            if (s.id === 'netzkino' && process.env.NETZKINO_V2 !== '0') mod = require('./netzkino-v2.js');
            if (typeof mod.getStreams !== 'function') throw new Error('no getStreams');
            list.push({ id: s.id, name: s.name, types: s.supportedTypes || [], mod, lock: Promise.resolve() });
        } catch (e) {
            log(`provider ${s.id} failed to load: ${e.message}`);
        }
    }
    // built in (not one of the plugins): ARD daily soaps such as "Sturm der Liebe", matched by broadcast date
    if (!SKIP.includes('ardsoap') && (!ONLY.length || ONLY.includes('ardsoap')))
        list.push({ id: 'ardsoap', name: 'ARD', types: ['tv'], mod: ard, lock: Promise.resolve() });
    // built in: SerienStream episodes opened in the TV's browser (the viewer passes s.to's check there)
    if (process.env.STO_BROWSER === '1' && !SKIP.includes('stobrowser') && (!ONLY.length || ONLY.includes('stobrowser')))
        list.push({ id: 'stobrowser', name: 'SerienStream', types: ['tv'], mod: require('./sto-browser.js'), lock: Promise.resolve() });
    // built in: wedotv (free films & series, German versions) and dailyme TV's open catalogue (westerns, DDR TV archive)
    if (!SKIP.includes('wedotv') && (!ONLY.length || ONLY.includes('wedotv')))
        list.push({ id: 'wedotv', name: 'wedotv', types: ['movie', 'tv'], mod: require('./wedotv.js'), lock: Promise.resolve() });
    if (!SKIP.includes('dailyme') && (!ONLY.length || ONLY.includes('dailyme')))
        list.push({ id: 'dailyme', name: 'dailyme', types: ['movie', 'tv'], mod: require('./dailyme.js'), lock: Promise.resolve() });
    // built in: full episodes on a series' official German YouTube channel (played by Nuvio's own YouTube player)
    if (!SKIP.includes('youtube') && (!ONLY.length || ONLY.includes('youtube')))
        list.push({ id: 'youtube', name: 'YouTube', types: ['tv', 'movie'], mod: require('./youtube.js'), lock: Promise.resolve() });
    // built in: ZDF, 3sat, KiKA & the other public broadcasters' Mediatheken (films and series), via MediathekViewWeb
    if (!SKIP.includes('mediathek') && (!ONLY.length || ONLY.includes('mediathek')))
        list.push({ id: 'mediathek', name: 'Mediathek', types: ['movie', 'tv'], mod: require('./mvw.js'), lock: Promise.resolve() });
    if (!list.length) throw new Error(`no providers loaded from ${dir}`);
    providers = list;
    pluginVersion = manifest.version;
    log(`loaded ${list.length} providers v${manifest.version} from ${dir === BUNDLED_DIR ? 'bundled copy' : 'update cache'}: ${list.map(p => p.id).join(', ')}`);
}

const UPDATE_TEST_TMDB = process.env.UPDATE_TEST_TMDB || '603';   // The Matrix: on almost every site
async function update() {
    try {
        const manifest = await (await fetch(UPDATE_URL + 'manifest.json')).json();
        if (manifest.version === pluginVersion) return;
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        for (const s of manifest.scrapers) {
            const res = await fetch(UPDATE_URL + s.filename);
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${s.filename}`);
            fs.writeFileSync(path.join(CACHE_DIR, s.filename.replace(/^providers\//, '')), await res.text());
        }
        fs.writeFileSync(path.join(CACHE_DIR, 'manifest.json'), JSON.stringify(manifest));
        // try the new version on a sample film before switching; keep the old one if it does clearly worse
        const before = { list: providers, version: pluginVersion };
        const sample = async () => (await Promise.all(providers.filter(p => p.types.includes('movie'))
            .map(p => runProvider(p, UPDATE_TEST_TMDB, 'movie', null, null).then(l => (l || []).length, () => 0)))).reduce((a, b) => a + b, 0);
        const oldScore = await sample();
        loadFrom(CACHE_DIR);
        const newScore = await sample();
        if (newScore < Math.max(1, Math.floor(oldScore / 2))) {
            providers = before.list; pluginVersion = before.version;
            log(`plugin update v${manifest.version} looked broken (${newScore} vs ${oldScore} test streams), keeping v${before.version}`);
            return;
        }
        log(`plugin update v${manifest.version} passed its test (${newScore} vs ${oldScore} test streams)`);
        cache.clear();
    } catch (e) {
        log(`update check failed, keeping v${pluginVersion}: ${e.message}`);
    }
}

// The plugins keep a little state per file (a deadline and a request counter), so one file must not run two
// searches at the same time. Each provider gets a queue; the cache below stops the same title being searched twice.
// a search that never finishes must not block the next ones: hard limit per search
const PROVIDER_LIMIT_MS = Number(process.env.PROVIDER_LIMIT_MS) || 45000;
function withLimit(promise, ms, what) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms); })])
        .finally(() => clearTimeout(timer));
}
// a site that fails 3 times in a row (errors / hangs) is paused for an hour, then tried again
const PAUSE_AFTER = 3, PAUSE_MS = 60 * 60000;
const numberingStore = new (require('async_hooks').AsyncLocalStorage)();
globalThis.__gpaNumbering = numberingStore;
function runProvider(p, tmdbId, type, season, episode, hint) {
    if (p.pausedUntil > Date.now()) return Promise.resolve([]);
    const call = () => p.mod.getStreams(tmdbId, type, season, episode);
    const job = p.lock.then(() => withLimit(Promise.resolve().then(() => hint ? numberingStore.run(hint, call) : call()), PROVIDER_LIMIT_MS, p.id));
    p.lock = job.catch(() => {});
    job.then(() => { p.fails = 0; }, err => {
        p.fails = (p.fails || 0) + 1;
        if (p.fails >= PAUSE_AFTER) { p.pausedUntil = Date.now() + PAUSE_MS; p.fails = 0; log(`${p.id} failed ${PAUSE_AFTER}x in a row (${err.message}), paused for an hour`); }
    });
    return job;
}

// ---------- IMDb id -> TMDB id ----------
const tmdbIds = new Map();
async function toTmdb(imdbId, type) {
    const key = `${type}:${imdbId}`;
    if (tmdbIds.has(key)) return tmdbIds.get(key);
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB find HTTP ${res.status}`);
    const d = await res.json();
    const hit = (type === 'movie' ? d.movie_results : d.tv_results)[0]
        || (d.tv_episode_results || [])[0] && { id: d.tv_episode_results[0].show_id };
    let id = hit ? String(hit.id) : null;
    // TMDB doesn't know this IMDb id (e.g. Dragon Ball Z's tt0214341): find the title by its name and year instead,
    // using the public Stremio catalogue that gave the player this id (exact name; see the year rule below).
    if (!id) id = await byNameAndYear(imdbId, type).catch(e => { log(`  ${imdbId}: name lookup failed: ${e.message}`); return null; });
    if (id) tmdbIds.set(key, id);
    return id;
}
const normTitle = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
async function byNameAndYear(imdbId, type) {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type === 'movie' ? 'movie' : 'series'}/${imdbId}.json`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const meta = (await r.json()).meta || {};
    const year = Number(String(meta.releaseInfo || meta.year || '').slice(0, 4));
    if (!meta.name || !year) return null;
    const kind = type === 'movie' ? 'movie' : 'tv';
    const d = await (await fetch(`https://api.themoviedb.org/3/search/${kind}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(meta.name)}`)).json();
    // same name; the same year (±1), or, if it is the only title with that exact name, a year within 8 (dubbed
    // versions often list the year they aired abroad: Dragon Ball Z 1989 in Japan, 1996 on IMDb)
    const same = (d.results || []).filter(x => [x.title, x.name, x.original_title, x.original_name].map(normTitle).includes(normTitle(meta.name)));
    const yearOf = x => Number(String(x.release_date || x.first_air_date || '').slice(0, 4));
    const hit = same.find(x => yearOf(x) && Math.abs(yearOf(x) - year) <= 1)
        || (same.length === 1 && yearOf(same[0]) && Math.abs(yearOf(same[0]) - year) <= 8 ? same[0] : null);
    if (hit) log(`  ${imdbId}: not linked on TMDB, matched "${meta.name}" (${year}) by name -> tmdb ${hit.id}`);
    return hit ? String(hit.id) : null;
}

// ---------- turning plugin streams into addon streams ----------
const LANG_KEY = lang => (lang === 'Deutsch' ? 'de' : /dt\. UT|OmU/.test(lang) ? 'de-sub' : 'other');
const RANK = { de: 0, 'de-sub': 1, other: 2 };

// ---------- display (same style as Fortune's AIOStreams "Select" template) ----------
const RES_LABEL = q => /2160|\b4k\b|uhd/i.test(q) ? '𝟰𝗞' : /1440/.test(q) ? '𝗤𝗛𝗗' : /1080/.test(q) ? '𝗙𝗛𝗗' : /720/.test(q) ? '𝗛𝗗'
    : /\b(480|360|240)p?\b|\bsd\b/i.test(q) ? '𝗦𝗗' : /auto|hls|m3u8/i.test(q) ? '𝗔𝘂𝘁𝗼' : '𝗦𝘁𝗿𝗲𝗮𝗺';
const LANG_EN = { Deutsch: 'German', Englisch: 'English', 'Französisch': 'French', Japanisch: 'Japanese', Spanisch: 'Spanish', Italienisch: 'Italian', 'Türkisch': 'Turkish', Russisch: 'Russian' };
function hostLabel(text) {
    const t = String(text || '').split('\n')[0].trim();
    const m = t.match(/^([a-z0-9-]+)\.[a-z0-9.-]+$/i);           // a bare domain like voe.sx -> VOE
    if (!m) return t;
    const w = m[1];
    if (w.includes('-')) return t.toLowerCase();                   // moflix-stream.fans: keep the whole name, the ending matters
    return w.length <= 4 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1);
}
const pad2 = n => String(n).padStart(2, '0');
const metaCache = new Map();   // "tv:123" -> { title, year }
// ---------- anime episode numbering ----------
// Catalogues like Xperience ask for anime with IMDb ids and IMDb's season split. IMDb splits long anime differently
// from TMDB and from the German sites (One Piece: IMDb season 1 = 8 episodes, AniWorld/TMDB season 1 = 61). The
// position of the episode in the whole series is the same everywhere, so: count it from IMDb's episode list (the
// public Stremio catalogue), then
//   - AniWorld and SerienStream get "season 1, episode <position>": their plugins walk on through the site's own
//     seasons when season 1 has fewer episodes (as the sites number them)
//   - every other site gets TMDB's season and episode (Huhu and others look episodes up by TMDB numbering)
// Only for Japanese animation asked for with an IMDb id; other series are unchanged.
const ABSOLUTE_SITES = ['aniworld', 'serienstream'];
const numberingCache = new Map();
async function cachedJson(url, ttl) {
    const hit = numberingCache.get(url);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.replace(/api_key=[^&]+/, 'api_key=***').slice(0, 80)}`);
    const v = await r.json();
    numberingCache.set(url, { t: Date.now(), v });
    if (numberingCache.size > 500) numberingCache.delete(numberingCache.keys().next().value);
    return v;
}
// One rule for every anime site, worked out once per request (stream lookups and /debug/start use the same):
//   - AniWorld and SerienStream: "season 1, episode <position in the whole series>"
//   - Huhu and every other site: TMDB's season and episode (Huhu numbers by TMDB for tmdb: and imdb: ids alike)
// When the episode can't be placed with certainty (IMDb's or TMDB's episode list couldn't be read, or the request
// points past what IMDb lists in a season that isn't the newest one), no site is asked for this request, rather than
// asked with numbers that might mean a different episode. That empty answer is kept for 2 minutes only.
async function animeNumbering(imdbId, tmdbId, season, episode) {
    if (!season || !episode) return null;
    const show = await cachedJson(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`, 12 * 3600 * 1000);
    const anime = (show.genres || []).some(g => g.id === 16) && (show.original_language === 'ja' || (show.origin_country || []).includes('JP'));
    if (!anime) return null;
    const unsure = why => ({ unsure: why });
    const tmdbSeasons = (show.seasons || []).filter(x => x.season_number > 0 && x.episode_count > 0).sort((a, b) => a.season_number - b.season_number);
    let meta;
    try { meta = (await cachedJson(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, 12 * 3600 * 1000)).meta || {}; }
    catch (e) { return season === 1 ? null : unsure(`IMDb episode list unavailable (${e.message})`); }
    const imdbCounts = new Map();
    for (const v of meta.videos || []) if (v.season > 0) imdbCounts.set(v.season, (imdbCounts.get(v.season) || 0) + 1);
    if (!imdbCounts.size || !tmdbSeasons.length) return season === 1 ? null : unsure('no episode list for this show');
    const lastImdb = Math.max(...imdbCounts.keys());
    // position of the episode in the whole series
    let absolute;
    if (season <= lastImdb && episode <= (imdbCounts.get(season) || 0)) {
        absolute = episode;
        for (let s = 1; s < season; s++) absolute += imdbCounts.get(s) || 0;
    } else if (season === 1) {
        absolute = episode;                                               // asked by position already ("1:400")
    } else if (season >= lastImdb && season <= lastImdb + 1) {
        // the newest season, with episodes IMDb doesn't list yet (still airing): count on from the known ones
        absolute = episode;
        for (let s = 1; s < season; s++) absolute += imdbCounts.get(s) || 0;
    } else return unsure(`IMDb has no S${season}E${episode}`);
    let same = true;
    for (let s = 1; s <= Math.min(season, lastImdb); s++) if ((imdbCounts.get(s) || 0) !== ((tmdbSeasons.find(x => x.season_number === s) || {}).episode_count || 0)) same = false;
    if (season === 1 && absolute === episode && episode <= (imdbCounts.get(1) || 0) && same) return null;   // nothing to translate
    let tmdbSeason = null, tmdbEpisode = null;
    if (same && season > 1) { tmdbSeason = season; tmdbEpisode = episode; }
    else {
        let rest = absolute;
        for (const x of tmdbSeasons) { if (rest <= x.episode_count) { tmdbSeason = x.season_number; tmdbEpisode = rest; break; } rest -= x.episode_count; }
        if (!tmdbSeason) { const last = tmdbSeasons[tmdbSeasons.length - 1]; tmdbSeason = last.season_number; tmdbEpisode = rest + last.episode_count; }
    }
    return { absolute, tmdbSeason, tmdbEpisode, imdbCounts: [...imdbCounts.entries()].sort((a, b) => a[0] - b[0]).map(x => x[1]) };
}
// what each site is asked for: pid -> [season, episode], or null = don't ask this site for this request
async function numberingPlan(id, pType, tmdbId, season, episode) {
    const imdb = String(id).split(':')[0];
    if (pType !== 'tv' || !/^tt\d+$/.test(imdb)) return { remap: null, for: () => [season, episode] };
    let remap;
    try { remap = await animeNumbering(imdb, tmdbId, season, episode); }
    catch (e) { remap = season > 1 ? { unsure: `numbering lookup failed (${e.message})` } : null; }
    if (!remap) return { remap: null, for: () => [season, episode] };
    if (remap.unsure) return { remap, for: () => null };
    // AniWorld/SerienStream also get IMDb's own season and episode as a hint: if the site splits its seasons like IMDb
    // (only a stray episode or two different), its own season S, episode E is the right one (see numbering-walk.js)
    const hint = { season, episode, imdbCounts: remap.imdbCounts };
    return { remap, for: pid => ABSOLUTE_SITES.includes(pid) ? [1, remap.absolute, hint] : [remap.tmdbSeason, remap.tmdbEpisode] };
}
const unsureLookups = new Set();   // "type:id" answered without asking the sites: keep that answer only briefly

async function showMeta(pType, tmdbId) {
    const k = `${pType}:${tmdbId}`;
    if (metaCache.has(k)) return metaCache.get(k);
    try {
        const r = await fetch(`https://api.themoviedb.org/3/${pType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-GB`, { signal: AbortSignal.timeout(5000) });
        const d = r.ok ? await r.json() : {};
        const m = { title: d.title || d.name || '', year: String(d.release_date || d.first_air_date || '').slice(0, 4) };
        if (m.title) { metaCache.set(k, m); if (metaCache.size > 3000) metaCache.delete(metaCache.keys().next().value); }
        return m;
    } catch (e) { return { title: '', year: '' }; }
}

// always through the Frankfurt server, even when the host would allow direct play (Germany-only broadcasters)
const FORCE_THROUGH = ['ardsoap', 'mediathek', 'wedotv', 'dailyme', 'netzkino'];
function releaseName(meta, ctx, quality, s, key, lang, site, host) {
    const clean = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
    const qtext = `${quality} ${s.name || ''} ${s.title || ''}`;
    const res = /2160|\b4k\b|uhd/i.test(qtext) ? '2160p' : /1080/.test(qtext) ? '1080p' : /720/.test(qtext) ? '720p' : /\b480p?\b/.test(qtext) ? '480p' : '';
    const ep = ctx && ctx.season != null ? `S${pad2(ctx.season)}E${pad2(ctx.episode)}` : (meta.year || '');
    const language = key === 'de' ? 'German' : key === 'de-sub' ? 'German.Subs' : (LANG_EN[lang] || lang);
    return [clean(meta.title), ep, res, clean(language), clean(site), clean(host)].filter(Boolean).join('.');
}
function toAddonStream(s, provider, ctx) {
    // s.name looks like "Serienstream · Deutsch · voe.sx" (built by the plugin)
    const parts = (s.name || provider.name).split(' · ');
    const lang = parts[1] || 'Deutsch';
    const key = LANG_KEY(lang);
    const quality = s.quality || 'auto';
    if (s.externalUrl) {
        // opens in the TV's browser (SerienStream: the viewer passes the site's check there and watches in the browser)
        const meta = (ctx && ctx.meta) || {};
        const head = meta.title && ctx.season != null ? `${meta.title} S${pad2(ctx.season)} ･ E${pad2(ctx.episode)}` : (meta.title || '');
        const out = {
            name: '𝗕𝗿𝗼𝘄𝘀𝗲𝗿',
            title: [head, `▫ ${parts[0]} · ${s.title || 'im Browser'}`, `▫ 🇩🇪 German · öffnet den Browser`].filter(Boolean).join('\n'),
            externalUrl: s.externalUrl,
            behaviorHints: { bingeGroup: `german-providers-${provider.id}-${key}` },
        };
        out.description = out.title;
        return { rank: RANK[key], q: 0, label: parts.join(' '), stream: out, external: true };
    }
    if (s.ytId) {
        // YouTube: no file address, the app plays the video id in its own YouTube player
        const meta = (ctx && ctx.meta) || {};
        const head = meta.title ? (ctx.season != null ? `${meta.title} S${pad2(ctx.season)} ･ E${pad2(ctx.episode)}` : meta.title) : '';
        const out = {
            name: RES_LABEL('auto'),
            title: [head, `▫ ${parts[2] || 'YouTube'}`, `▫ ${key === 'de' ? '🇩🇪 German' : '🌐 ' + (LANG_EN[lang] || lang)}`].filter(Boolean).join('\n'),
            ytId: s.ytId,
            behaviorHints: { bingeGroup: `german-providers-${provider.id}-${key}`, filename: releaseName(meta, ctx, 'auto', s, key, lang, '', parts[2] || 'YouTube') },
        };
        out.description = out.title;
        return { rank: RANK[key], q: 2, label: parts.join(' '), stream: out };
    }
    let headers = s.headers && Object.keys(s.headers).length ? s.headers : null;
    let url = s.url;
    // hosts like VOE only play on the connection that found the link: pass those through this server
    // German sources that only play inside Germany always go through this server (even if listed as 'direct')
    if (publicBase && (FORCE_THROUGH.includes(provider.id) || passthrough.wanted(s, parts.join(' '), provider.id))) {
        const source = ((`${parts.join(' ')} ${s.title || ''}`).match(/\b([a-z0-9-]+\.(?:[a-z0-9-]+\.)*[a-z]{2,})\b/i) || [])[1];
        const host = (parts[2] || source || '').toLowerCase();
        const re = ctx ? [ctx.type, ctx.id, provider.id, host] : null;
        url = passthrough.proxyUrl(publicBase, s.url, headers, null, source && source.toLowerCase(), re, false, FORCE_THROUGH.includes(provider.id));
    }
    // left: resolution like 𝗙𝗛𝗗;  right: "Merlin S01 ･ E05" / "Frankenstein ･ 2025", provider · host, language
    const meta = (ctx && ctx.meta) || {};
    const head = meta.title ? (ctx.season != null ? `${meta.title} S${pad2(ctx.season)} ･ E${pad2(ctx.episode)}` : `${meta.title}${meta.year ? ' ･ ' + meta.year : ''}`) : '';
    const hostText = hostLabel(parts[2] || s.title || '');
    const langText = key === 'de' ? '🇩🇪 German' : key === 'de-sub' ? '🇩🇪 German subs' : `🌐 ${LANG_EN[lang] || lang}`;
    const out = {
        name: RES_LABEL(`${quality} ${s.name || ''}`),
        title: [head, `▫ ${hostText || parts[0]}`, `▫ ${langText}`].filter(Boolean).join('\n'),
        url,
        behaviorHints: {
            // same group on every episode -> Nuvio/Stremio pick this addon again for the next episode
            // per provider: start on Huhu and the next episode stays on Huhu (only falls back if Huhu has nothing)
            bingeGroup: `german-providers-${provider.id}-${key}`,
            // release-style name: Nuvio's badge rules read it (resolution, language); only facts we really know
            filename: releaseName(meta, ctx, quality, s, key, lang, '', hostText || parts[0]),
            notWebReady: !!headers || undefined,
            proxyHeaders: headers ? { request: headers } : undefined,
        },
    };
    out.description = out.title;
    if (headers) out.headers = headers;   // Nuvio-style field, ignored by apps that don't know it
    // quality score for sorting: labelled 4K/1080p first; 'auto' (adaptive HLS, often up to 1080p) counts like 720p
    const qtext = `${quality} ${s.name || ''} ${s.title || ''}`;
    const q = /2160|\b4k\b|uhd/i.test(qtext) ? 4 : /1080/.test(qtext) ? 3 : /720/.test(qtext) ? 2 : /\b(480|360|240)p?\b|\bsd\b/i.test(qtext) ? 1 : 2;
    return { rank: RANK[key], q, label: parts.join(' '), stream: out };
}

// ---------- the stream lookup with cache ----------
const cache = new Map();   // key -> { time, ttl, promise }

// ---------- anime IDs (kitsu:/mal:/anilist:/anidb:) -> TMDB id + season/episode, via api.ani.zip ----------
const ANIME_PREFIXES = ['kitsu', 'mal', 'anilist', 'anidb'];
const animeMaps = new Map();
async function animeMapping(kind, animeId) {
    const key = `${kind}:${animeId}`;
    if (animeMaps.has(key)) return animeMaps.get(key);
    const res = await fetch(`https://api.ani.zip/mappings?${kind}_id=${encodeURIComponent(animeId)}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`ani.zip HTTP ${res.status}`);
    const d = await res.json();
    animeMaps.set(key, d);
    if (animeMaps.size > 500) animeMaps.delete(animeMaps.keys().next().value);
    return d;
}
// "kitsu:1376:5" -> { tmdbId, pType, season, episode }
async function resolveAnimeId(id) {
    const [kind, animeId, epText] = id.split(':');
    const d = await animeMapping(kind, animeId);
    const m = d.mappings || {};
    const movie = /movie/i.test(m.type || '') || !epText;
    const pType = movie ? 'movie' : 'tv';
    let tmdbId = m.themoviedb_id ? String(m.themoviedb_id) : null;
    if (!tmdbId && m.imdb_id) tmdbId = await toTmdb(m.imdb_id, pType);
    if (!tmdbId) return null;
    if (movie) return { tmdbId, pType, season: null, episode: null };
    const n = Number(epText) || 1;
    const ep = (d.episodes || {})[String(n)] || {};
    // seasons as the TV listings number them; without that, absolute numbering (the anime scrapers map it to seasons)
    const season = Number(ep.seasonNumber) > 0 ? Number(ep.seasonNumber) : 1;
    const episode = Number(ep.episodeNumber) > 0 ? Number(ep.episodeNumber) : (Number(ep.absoluteEpisodeNumber) || n);
    return { tmdbId, pType, season, episode };
}

// which providers had streams for a show last time (any episode): tmdb show -> Set of provider ids
const knownProviders = new Map();
const KNOWN_GRACE_MS = Number(process.env.KNOWN_GRACE_MS) || 1500;
async function lookup(type, id) {
    const ctx = { type, id };
    let tmdbId, pType, season, episode;
    if (ANIME_PREFIXES.includes(id.split(':')[0])) {
        const a = await resolveAnimeId(id).catch(e => { log(`  anime id ${id}: ${e.message}`); return null; });
        if (!a) return [];
        ({ tmdbId, pType, season, episode } = a);
        log(`  ${id} -> tmdb ${tmdbId} ${pType === 'tv' ? `S${season}E${episode}` : '(movie)'}`);
    } else {
        const [imdbOrTmdb, s, e] = id.split(':').filter(x => x !== 'tmdb');
        // 'anime' items (Xperience & co.) can be shows (with season:episode) or films (without)
        const episodic = type === 'series' || (type === 'anime' && s != null && e != null);
        season = episodic ? Number(s) : null;
        episode = episodic ? Number(e) : null;
        pType = episodic ? 'tv' : 'movie';
        tmdbId = /^tt\d+$/.test(imdbOrTmdb) ? await toTmdb(imdbOrTmdb, pType) : imdbOrTmdb;
    }
    if (!tmdbId) return [];
    ctx.season = pType === 'tv' ? season : null; ctx.episode = episode;
    ctx.meta = await showMeta(pType, tmdbId);

    const allActive = providers.filter(p => p.types.includes(pType));
    // anime asked for with IMDb's season split (e.g. One Piece season 2 = episodes 9-30): translate to the sites' own
    // numbering, otherwise they return a different episode
    const plan = await numberingPlan(id, pType, tmdbId, season, episode);
    const remap = plan.remap;
    if (remap && remap.unsure) { log(`  anime numbering unsure: ${remap.unsure}; no site asked for this episode`); unsureLookups.add(`${type}:${id}`); }
    else if (remap) log(`  anime numbering: IMDb S${season}E${episode} = episode ${remap.absolute} = TMDB S${remap.tmdbSeason}E${remap.tmdbEpisode}`);
    const active = allActive.filter(p => plan.for(p.id));
    const results = [];
    const started = Date.now();
    const stoAccess = require('./sto-access.js');
    const goodKey = `${pType}:${tmdbId}:${season}:${episode}`;
    const runs = active.map((p, order) => runProvider(p, tmdbId, pType, ...plan.for(p.id))
        .then(list => {
            // SerienStream: keep its last working answer; while s.to can't be asked, that answer stands in
            if (p.id === 'serienstream' && pType === 'tv') {
                if (list && list.length) stoAccess.rememberGood(goodKey, list);
                else if (net.stoGated()) { const prev = stoAccess.standIn(goodKey); if (prev) { list = prev; log(`  serienstream: s.to paused, using its last working answer for this episode`); } stoMissed.add(`${type}:${id}`); }
            }
            (list || []).filter(st => st && (st.ytId || st.externalUrl || /^https?:\/\//i.test(st.url || ''))).forEach((st, i) => {
                const item = Object.assign(toAddonStream(st, p, ctx), { order, i, pref: prefIndex(p.id), provider: p.id });
                // health is remembered per title + site + hoster (links themselves change with every lookup)
                srcKey.set(item.stream, `${type}:${id}|${p.id}|${String((st.name || '').split(' · ')[2] || st.ytId && 'youtube' || '').toLowerCase()}`);
                results.push(item);
            });   // a host's error word ("RELOAD") is no link
            log(`  ${p.id}: ${(list || []).length} streams in ${Date.now() - started} ms`);
        })
        .catch(err => log(`  ${p.id}: error ${err.message}`)));

    let finished = 0;
    runs.forEach(r => r.then(() => { finished++; }));
    // answer when every provider is done, or at the time limit with whatever arrived so far. If we know which
    // providers had this show before, answer as soon as those are done (plus a short grace), so the player's
    // "same provider as last time" match isn't lost to a slow site that never has the show anyway.
    const showKey = `${pType}:${tmdbId}`;
    const had = knownProviders.get(showKey);
    const hadRuns = had ? active.map((p, i) => had.has(p.id) ? runs[i] : null).filter(Boolean) : [];
    let early = false;
    const waits = [Promise.all(runs), new Promise(r => setTimeout(r, TIMEOUT_MS))];
    if (hadRuns.length) waits.push(Promise.all(hadRuns).then(() => new Promise(r => setTimeout(r, KNOWN_GRACE_MS)))) ;
    // new title: answer after SOFT_MS as soon as there is at least one German stream (late sites still fill the cache)
    else if (SOFT_MS > 0) waits.push(new Promise(r => {
        const tick = () => { if (results.some(x => x.rank === 0 && !x.external)) r(); else if (finished < runs.length) setTimeout(tick, 500); };
        setTimeout(tick, SOFT_MS);
    }));
    await Promise.race(waits);
    const allDone = finished === runs.length;
    early = !allDone;
    const snapshot = results.slice();
    const remember = () => {
        const ids = new Set([...(knownProviders.get(showKey) || [])].concat(results.map(x => x.provider).filter(Boolean)));
        if (ids.size) { knownProviders.delete(showKey); knownProviders.set(showKey, ids); if (knownProviders.size > 2000) knownProviders.delete(knownProviders.keys().next().value); }
    };
    if (allDone) remember(); else Promise.all(runs).then(remember);
    if (early) log(`  answered after ${Date.now() - started} ms${hadRuns.length ? ' (known providers for this show done)' : ''}`);
    if (early) {
        // late providers still finish in the background; refresh the cache with the full list for the next request
        Promise.all(runs).then(() => {
            const key = `${type}:${id}`;
            if (results.length > snapshot.length) { const full = sortStreams(results); const e2 = { time: Date.now(), ttl: CACHE_MIN * 60000, promise: labelStreams(full, 8000) }; cache.set(key, e2); verifyLater(key, e2, full); }
        });
    }
    return labelStreams(sortStreams(snapshot), LABEL_MS);
}

// provider order in the list (within each language group): dedicated streaming sites first, loose matchers last
const PREFERRED = (process.env.PROVIDER_ORDER || 'serienstream,aniworld,huhuto,moflix,filmpalast,megakino,kinoking,hdfilme,filmo,kellerkino,flixitv,filmfrei24,mediathek,wedotv,dailyme,ard,arte,youtube,stobrowser,dmax,tele5,tlc,southpark,netzkino,plutotv')
    .split(',').map(x => x.trim());
const prefIndex = id => { const i = PREFERRED.indexOf(id); return i < 0 ? PREFERRED.length : i; };
const DEMOTE = new RegExp(process.env.DEMOTE_HOSTS || 'supervideo|dropload|dr0pstream|moflix-stream\\.click', 'i');
const demoted = x => (DEMOTE.test(`${x.label || ''} ${x.stream.title} ${x.stream.name}`) ? 1 : 0);
const GERMAN_ONLY = process.env.GERMAN_ONLY !== '0';            // German audio only: other languages and German-subtitle streams are never shown
const KEEP_GERMAN_SUBS = process.env.GERMAN_SUBS === '1';       // set GERMAN_SUBS=1 to also show original audio with German subtitles
const MAX_PER_HOST = Number(process.env.MAX_PER_HOST) || 2;        // streams kept per site + host + language
// the real video address behind a stream (pass-through links carry it inside), without the changing ?token part
function videoKey(st) {
    if (st.ytId) return 'youtube/' + st.ytId;
    if (st.externalUrl) return 'external/' + st.externalUrl;
    const job = passthrough.jobOf(st.url);
    const u = (job && job.u) || st.url || '';
    try { const x = new URL(u); return x.host + x.pathname; } catch (e) { return u.split('?')[0]; }
}
// the last stream requests (what the player asked for: type and id with season:episode), for checking numbering
const recentRequests = [];
// stream -> its health key (title | site | hoster)
const srcKey = new WeakMap();
const health = require('./health.js');
const sortStreams = list => {
    const sorted = list.slice().sort((a, b) => demoted(a) - demoted(b) || a.rank - b.rank || (b.q || 0) - (a.q || 0) || a.pref - b.pref || a.order - b.order || a.i - b.i);
    const seen = new Set(), perHost = new Map(), out = [];
    // the browser hand-off (SerienStream) only when nothing plays in Nuvio itself
    const playableHere = list.some(x => x.rank === 0 && !x.external);
    for (const x of sorted) {
        if (x.external && playableHere) continue;
        if (GERMAN_ONLY && (x.rank === 2 || (x.rank === 1 && !KEEP_GERMAN_SUBS))) continue;   // German audio only
        const vk = videoKey(x.stream);
        if (vk && seen.has(vk)) continue;                           // same upload already listed via another site
        const hk = `${x.provider || ''}|${x.label || ''}|${x.q}`;
        const n = perHost.get(hk) || 0;
        if (n >= MAX_PER_HOST) continue;                            // enough from this site + host already
        seen.add(vk); perHost.set(hk, n + 1); out.push(x.stream);
    }
    return out;
};

// a link that fails to start (expired in the player's cache, or deleted at the host): search the episode again and
// send the player to a working link, staying on the same site where possible. One search per episode at a time.
const refreshing = new Map();
passthrough.setRefresher(async ([type, id, prov, host], failedUrl) => {
    const key = `${type}:${id}`;
    if (!refreshing.has(key)) {
        log(`refreshing expired link: ${key} (${prov} ${host})`);
        cache.delete(key);
        const p = getStreams(type, id).finally(() => setTimeout(() => refreshing.delete(key), 60000));
        refreshing.set(key, p);
    }
    const streams = await refreshing.get(key);
    // The same upload usually comes back with a fresh token (expired link): best, it's the very same video. A deleted
    // upload also comes back looking the same, so every candidate is test-started before the player is sent there.
    const deadKey = failedUrl ? videoKey({ url: failedUrl }) : null;
    const same = deadKey ? streams.filter(st => videoKey(st) === deadKey && st.url !== failedUrl) : [];
    const alive = streams.filter(st => !deadKey || videoKey(st) !== deadKey);
    const mine = alive.filter(st => (st.behaviorHints || {}).bingeGroup && st.behaviorHints.bingeGroup.startsWith(`german-providers-${prov}-`));
    const job = st => passthrough.jobOf(st.url) || {};
    // same video; else same site + host; else same site, other host; else same host via another site; else the best left
    const order = [].concat(same, mine.filter(st => (job(st).re || [])[3] === host), mine,
        alive.filter(st => (job(st).re || [])[3] === host), alive).filter((st, i, a) => a.indexOf(st) === i);
    for (const pick of order.slice(0, 4)) {
        const url = passthrough.jobOf(pick.url) ? passthrough.markFresh(pick.url) : pick.url;
        const ok = await playCheck(Object.assign({}, pick, { url })).then(r => /^OK/.test(r), () => false);
        if (ok) return url;
        log(`  refresh candidate doesn't start either: ${pick.title ? pick.title.split('\n')[1] || '' : ''}`);
    }
    // nothing confirmed: still better than an error screen
    const fallback = order.find(st => !same.includes(st)) || order[0];
    if (!fallback) return null;
    return passthrough.jobOf(fallback.url) ? passthrough.markFresh(fallback.url) : fallback.url;
});

// Streams without a known resolution ("Auto" / no label): read the video's quality list (the HLS master playlist,
// a few KB) and show the best resolution it offers, e.g. FHD. Done in parallel with a short time limit, so the
// answer is never held up; whatever isn't known in time keeps its label.
const LABEL_MS = Number(process.env.LABEL_MS) || 1500;
const UNSURE = new Set(['𝗔𝘂𝘁𝗼', '𝗦𝘁𝗿𝗲𝗮𝗺']);
// MP4 files: the video track's size sits in its "tkhd" box near the start of the file (when the file is web-optimised)
function mp4Height(buf) {
    let best = 0;
    for (let i = buf.indexOf('tkhd'); i >= 4 && i < buf.length - 90; i = buf.indexOf('tkhd', i + 4)) {
        const v = buf[i + 4];
        const off = i + 4 + 4 + (v === 1 ? 32 : 20) + 8 + 8 + 36;   // version/flags, times+id+duration, reserved, layer..volume, matrix
        if (off + 8 > buf.length) continue;
        const w = buf.readUInt32BE(off) / 65536, h = buf.readUInt32BE(off + 4) / 65536;
        if (w > 0 && h > 0 && h < 5000) best = Math.max(best, Math.round(h));
    }
    return best;
}
async function probeHeight(stream) {
    const port = (server.address() || {}).port || PORT;
    const url = publicBase && stream.url.startsWith(publicBase) ? stream.url.replace(publicBase, `http://127.0.0.1:${port}`) : stream.url;
    const headers = Object.assign({ 'User-Agent': 'ExoPlayer', 'X-Gpa-Check': '1', Range: 'bytes=0-262143' }, ((stream.behaviorHints || {}).proxyHeaders || {}).request);
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    const buf = Buffer.from(await r.arrayBuffer());
    const head = buf.toString('utf8', 0, 16).trim();
    if (head.startsWith('#EXTM3U')) {
        const hs = [...buf.toString('utf8').matchAll(/RESOLUTION=\d+x(\d+)/g)].map(m => Number(m[1]));
        return hs.length ? Math.max(...hs) : 0;
    }
    return mp4Height(buf);
}
async function labelStreams(list, budgetMs) {
    const todo = list.filter(st => st && st.url && !st.ytId && !st.externalUrl && UNSURE.has(st.name));
    if (!todo.length) return list;
    const work = Promise.all(todo.slice(0, 12).map(async st => {
        const h = await probeHeight(st).catch(() => 0);
        if (!h) return;
        const res = `${h >= 2000 ? 2160 : h >= 1300 ? 1440 : h >= 1000 ? 1080 : h >= 700 ? 720 : 480}p`;
        st.name = RES_LABEL(res);
        // the release-style name too: AIOStreams and Nuvio's badges read the resolution from it
        const bh = st.behaviorHints || {};
        if (bh.filename && !/\.(2160|1440|1080|720|480)p\./.test(bh.filename))
            bh.filename = bh.filename.replace(/^(.*?\.(?:S\d\dE\d\d|\d{4}))\./, `$1.${res}.`);
    }));
    await Promise.race([work, new Promise(r => setTimeout(r, budgetMs))]);
    return list;
}

// After answering, try every link like the player would (a few KB each, in the background) and move links that
// don't start to the end of the cached list. The next request for this episode (autoplay, the prefetched next
// episode, a second device) then starts with links known to work. VERIFY=0 turns it off.
const VERIFY = process.env.VERIFY !== '0';
const VERIFY_MAX = Number(process.env.VERIFY_MAX) || 10;
let verifying = 0;
const verifyQueue = [];
function verifySlot() { return verifying < 3 ? Promise.resolve(verifying++) : new Promise(r => verifyQueue.push(r)).then(() => verifying++); }
function verifyDone() { verifying--; const next = verifyQueue.shift(); if (next) next(); }
const verifyStats = { checked: 0, failed: 0 };
function verifyLater(key, entry, streams) {
    if (!VERIFY || streams.length < 2) return;
    setTimeout(async () => {
        // the first links, plus a few hidden ones further down: that is how a recovered hoster comes back
        const hiddenLater = streams.slice(VERIFY_MAX).filter(st => health.state(srcKey.get(st)) === 'hidden').slice(0, 3);
        const check = streams.slice(0, VERIFY_MAX).concat(hiddenLater);
        const outcomes = await Promise.all(check.map(async st => {
            await verifySlot();
            try { return st.ytId || st.externalUrl ? 'OK' : await playCheck(st); } catch (e) { return 'FAIL ' + e.message; } finally { verifyDone(); }
        }));
        const results = outcomes.map(o => /^OK/.test(o));
        // rate-limited (429), or our own short pause for a server that was rate-limiting or not answering (503/504): no
        // new evidence about the link itself
        const limited = outcomes.map(o => /^FAIL (429|503|504)\b/.test(o));
        verifyStats.checked += results.length;
        const broken = check.filter((st, i) => !results[i] && !limited[i]);
        const counted = check.filter((st, i) => !limited[i]).length;
        // links that didn't start for any reason go to the end of the list; only real failures count for hiding
        const dead = new Set(check.filter((st, i) => !results[i]));
        verifyStats.failed += dead.size;
        // every link failed: probably our own network, not the hosters: record nothing, change nothing
        if (dead.size === check.length) return;
        // every link that could be judged failed: same suspicion, so don't count it against them (still reorder)
        if (!(broken.length && broken.length === counted)) {
            const byKey = new Map();
            check.forEach((st, i) => { const k = srcKey.get(st); if (!k) return; if (limited[i]) { health.rateLimited(); return; } byKey.set(k, (byKey.get(k) || false) || results[i]); });
            for (const [k, okNow] of byKey) okNow ? health.ok(k) : health.fail(k);
        }
        if (!dead.size) return;
        const ordered = streams.filter(st => !dead.has(st)).concat(streams.filter(st => dead.has(st)));
        if (cache.get(key) === entry) entry.promise = Promise.resolve(ordered);
        log(`  checked ${key}: ${dead.size} of ${results.length} links don't start, moved to the end`);
    }, 3000).unref();
}

// episodes looked up while s.to showed its check: when it works again, they are looked up afresh (quietly, in the
// background, one after another), so SerienStream's links are back before anyone asks
const stoMissed = new Set();
function onStoRecovered() {
    const keys = [...stoMissed].slice(-10);
    stoMissed.clear();
    log(`s.to answers normally again: refreshing ${keys.length} episode(s) looked up meanwhile`);
    const stoAccess = require('./sto-access.js');
    keys.reduce((chain, key) => chain.then(() => {
        cache.delete(key);
        const [type, ...rest] = key.split(':');
        return stoAccess.priority.run('low', () => getStreams(type, rest.join(':'), true)).catch(() => {});
    }), Promise.resolve());
}
require('./sto-access.js').onRecover(() => onStoRecovered());
function getStreams(type, id, prefetched) {
    const key = `${type}:${id}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < hit.ttl) return hit.promise;
    const promise = lookup(type, id).then(streams => {
        // nothing found: only remember that briefly
        entry.ttl = (streams.length ? (prefetched ? PREFETCH_MIN : CACHE_MIN) : 2) * 60000;
        // s.to showed its check during this lookup: SerienStream's links are missing, so look again in 30 minutes
        if (type === 'series' && net.stoGated()) entry.ttl = Math.min(entry.ttl, 30 * 60000);
        // the episode couldn't be placed for sure, nothing was asked: try again soon
        if (unsureLookups.delete(key)) entry.ttl = Math.min(entry.ttl, 2 * 60000);
        verifyLater(key, entry, streams);
        return streams;
    }, err => { cache.delete(key); throw err; });
    const entry = { time: Date.now(), ttl: TIMEOUT_MS + 60000, promise };
    cache.set(key, entry);
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return promise;
}

// ---------- debug jobs (run providers one by one and record every request they make) ----------
const jobs = new Map();
async function runDebugJob(job, only) {
    const [ref, s, e] = job.id.split(':').filter(x => x !== 'tmdb');
    const pType = job.type === 'movie' ? 'movie' : 'tv';
    const tmdbId = /^tt\d+$/.test(ref) ? await toTmdb(ref, pType) : ref;
    job.tmdbId = tmdbId;
    if (!tmdbId) { job.done = true; job.error = 'no TMDB match'; return; }
    // same numbering as a real stream request
    const s0 = s ? Number(s) : null, e0 = e ? Number(e) : null;
    const plan = await numberingPlan(ref, pType, tmdbId, s0, e0);
    if (plan.remap) job.numbering = plan.remap;
    const list = providers.filter(p => p.types.includes(pType) && (!only || only.includes(p.id)));
    await Promise.all(list.map(async p => {
        const asked = plan.for(p.id);
        const entry = job.providers[p.id] = { running: true, requests: [], asked: asked ? (asked[0] != null ? `S${asked[0]}E${asked[1]}` : 'film') : 'not asked (episode not certain)' };
        if (!asked) { entry.running = false; entry.streams = 0; return; }
        const t = Date.now();
        await net.traceStore.run(entry.requests, async () => {
            try {
                const streams = (await runProvider(p, tmdbId, pType, ...asked)) || [];
                entry.streams = streams.length;
                entry.sample = streams.slice(0, 3).map(x => `${x.name} | ${(x.url || '').slice(0, 70)}`);
            } catch (err) { entry.error = err.message; }
        });
        entry.ms = Date.now() - t;
        entry.running = false;
    }));
    job.done = true;
}

// ---------- full audit: every provider x test titles, and a real play check of the streams ----------
const AUDIT_TITLES = (process.env.AUDIT_TITLES ||
    'movie:tt0133093,movie:tt1375666,series:tt0944947:1:1,series:tt0458290:1:1,series:tt1199099:1:1,series:tt0388629:1:1,series:tt0121955:1:1,series:tt5753856:1:1,series:tt1871731:1:1')
    .split(',').map(x => { const [type, ...id] = x.split(':'); return { type, id: id.join(':') }; });

// play a stream like the player would: playlist -> first quality -> first video piece (first 2 KB only)
async function playCheck(stream) {
    const local = publicBase ? stream.url.replace(publicBase, `http://127.0.0.1:${(server.address() || {}).port || PORT}`) : stream.url;
    const headers = Object.assign({}, ((stream.behaviorHints || {}).proxyHeaders || {}).request);
    let url = local;
    for (let depth = 0; depth < 4; depth++) {
        const r = await fetch(url, { headers: Object.assign({ 'User-Agent': 'ExoPlayer', 'X-Gpa-Check': '1' }, headers, { Range: 'bytes=0-2047' }), signal: AbortSignal.timeout(20000) });
        const type = r.headers.get('content-type') || '';
        const buf = Buffer.from(await r.arrayBuffer());
        const head = buf.toString('utf8', 0, 300);
        if (r.status >= 400) return `FAIL ${r.status} at ${depth ? 'playlist/piece' : 'start'}${r.status === 502 ? ' (' + buf.toString('utf8', 0, 200) + ')' : ''}`;
        if (/^#EXTM3U/.test(head.trim())) {
            const text = buf.length >= 2048 ? await (await fetch(url, { headers: Object.assign({ 'User-Agent': 'ExoPlayer', 'X-Gpa-Check': '1' }, headers), signal: AbortSignal.timeout(20000) })).text() : buf.toString('utf8');
            const next = text.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
            if (!next) return 'FAIL empty playlist';
            url = new URL(next, r.url || url).toString();
            if (publicBase) url = url.replace(publicBase, `http://127.0.0.1:${(server.address() || {}).port || PORT}`);
            continue;
        }
        if (/html/i.test(type) || /^\s*</.test(head)) return `FAIL got a web page (${r.status})`;
        return `OK ${r.status} ${type.split(';')[0] || 'data'}`;
    }
    return 'FAIL too many playlists';
}

const scans = new Map();
async function runScan(job, show, onlySeason) {
    const tmdbId = show.startsWith('tt') ? await toTmdb(show, 'tv') : show.split(':')[1];
    if (!tmdbId) throw new Error('no TMDB match');
    const d = await (await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=de-DE`)).json();
    job.name = d.name;
    const eps = [];
    for (const se of (d.seasons || []).filter(x => x.season_number > 0 && (!onlySeason || x.season_number === onlySeason)))
        for (let e = 1; e <= se.episode_count; e++) eps.push([se.season_number, e]);
    let done = 0;
    job.progress = `0/${eps.length}`;
    // three at a time; results also land in the normal cache, so the episodes open instantly afterwards
    const work = async () => {
        while (eps.length) {
            const [s, e] = eps.shift();
            const key = `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
            let list = [];
            try { list = await getStreams('series', `${show}:${s}:${e}`); } catch (err) {}
            const sites = [...new Set(list.map(st => ((st.behaviorHints || {}).bingeGroup || '').replace(/^german-providers-|-de$/g, '')).filter(Boolean))];
            (job.seasons[s] = job.seasons[s] || {})[key] = list.length ? `German: ${sites.join(', ')}` : 'NO GERMAN';
            job.progress = `${++done}/${done + eps.length}`;
        }
    };
    await Promise.all([work(), work(), work()]);
    const all = Object.values(job.seasons).flatMap(o => Object.entries(o));
    job.missing = all.filter(([, v]) => v === 'NO GERMAN').map(([k]) => k).sort();
    job.summary = `${all.length - job.missing.length} of ${all.length} episodes have German`;
    job.done = true;
    job.finished = new Date().toISOString();
}
const audits = new Map();
async function runAudit(audit) {
    for (const t of AUDIT_TITLES) {
        const row = audit.titles[`${t.type}:${t.id}`] = {};
        const [ref, s, e] = t.id.split(':');
        const pType = t.type === 'movie' ? 'movie' : 'tv';
        const tmdbId = await toTmdb(ref, pType).catch(() => null);
        if (!tmdbId) { row.error = 'no TMDB match'; continue; }
        const plan = await numberingPlan(ref, pType, tmdbId, s ? Number(s) : null, e ? Number(e) : null);
        await Promise.all(providers.filter(p => p.types.includes(pType) && plan.for(p.id)).map(async p => {
            const asked = plan.for(p.id);
            const reqs = [];
            const t0 = Date.now();
            let list = [];
            await net.traceStore.run(reqs, async () => {
                try { list = (await runProvider(p, tmdbId, pType, ...asked)) || []; }
                catch (err) { reqs.push({ log: 'ERROR ' + err.message }); }
            });
            const blockedHosts = [...new Set(reqs.filter(r => r.blocked).map(r => { try { return new URL(r.url).host; } catch (x) { return '?'; } }))];
            const stillBlocked = blockedHosts.filter(h => !reqs.some(r => r.url && r.url.includes(h) && r.status && !r.blocked));
            const out = { streams: list.length, ms: Date.now() - t0 };
            if (stillBlocked.length) out.blocked = stillBlocked;
            const errs = reqs.filter(r => r.error || r.log).map(r => (r.error ? `${r.route} ${r.error}` : r.log).slice(0, 90));
            if (errs.length) out.errors = errs.slice(0, 3);
            // play check of up to 3 streams (different hosts first)
            const addon = list.map(x => toAddonStream(x, p).stream);
            const seen = new Set(), pick = [];
            for (const a of addon) { const host = (a.title.split('\n')[1] || '').split(' · ')[0]; if (!seen.has(host)) { seen.add(host); pick.push(a); } if (pick.length >= 3) break; }
            if (pick.length) out.play = await Promise.all(pick.map(async a => `${(a.title.split('\n')[1] || a.title).split(' · ')[0].slice(0, 24)}: ${await withLimit(playCheck(a), 60000, 'play check').catch(err => 'FAIL ' + err.message.slice(0, 50))}`));
            row[p.id] = out;
        }));
        audit.progress = Object.keys(audit.titles).length + '/' + AUDIT_TITLES.length;
    }
    audit.done = true;
    audit.finished = new Date().toISOString();
}

// ---------- HTTP server ----------

function addonManifest() {
    return {
        id: 'community.german-providers.addon',
        version: '1.22.0',
        name: 'German Providers',
        description: `Deutsche Quellen (s.to, AniWorld, ARD, Arte, FilmPalast …) als Addon. Plugins v${pluginVersion} von InvalidPandaa/nuvio-german-providers (GPL-3.0).`,
        logo: publicBase ? `${publicBase}/logo.png` : 'https://flagcdn.com/w160/de.png',
        resources: ['stream'],
        types: ['movie', 'series', 'anime'],
        idPrefixes: ['tt', 'tmdb:', 'kitsu:', 'mal:', 'anilist:', 'anidb:'],
        catalogs: [],
        behaviorHints: { configurable: false },
    };
}

function send(res, code, body, maxAge) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Cache-Control': maxAge ? `max-age=${maxAge}` : 'no-cache',
    });
    res.end(JSON.stringify(body).replace(/(api_key=)[^&"\s]+/g, '$1***'));
}

// SerienStream login test with a known episode: does a German hoster button lead straight to the hoster?
async function stoTest() {
    const test = { loggedIn: false, hosterLink: null };
    try {
        const UAx = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        const ep = 'https://serienstream.to/serie/merlin-die-neuen-abenteuer/staffel-1/episode-3';
        const html = await (await net.smartFetch(ep, { headers: { 'User-Agent': UAx } })).text();
        test.loggedIn = net.stoInit() ? (await require('./sto-access.js').checkLogin()) === 'ok' : /Abmelden|logout/i.test(html);
        test.gate = (html.match(/data-redirect-gate-tier="([^"]*)"/) || [])[1] || 'none';
        const play = (html.match(/data-play-url="([^"]+)"[^>]*data-language-id="1"|data-language-id="1"[^>]*data-play-url="([^"]+)"/) || []).slice(1).find(Boolean);
        if (play) {
            const r = await net.smartFetch('https://serienstream.to' + play.replace(/&amp;/g, '&'), { headers: { 'User-Agent': UAx, Referer: ep }, _stoProbe: true });
            const host = new URL(r.url || 'https://serienstream.to').hostname;
            test.hosterLink = /serienstream|s\.to$/.test(host) ? null : host;
            if (!test.hosterLink) test.checkPage = /frameBridge/.test(await r.text().catch(() => ''));
        }
    } catch (e) { test.error = e.message; }
    return test;
}

// ---------- daily phone notification (notify.js) ----------
const NOTIFY_TITLES = [['movie', 'tt0133093'], ['series', 'tt1199099:1:1'], ['series', 'tt1695360:1:1'], ['series', 'tt0388629:1:1']];
async function notifyRun() {
    const notify = require('./notify.js');
    const st = await notify.run({
        stoCheck: async () => {
            if (!require('./sto-session.js').status().loggedIn) return null;
            const t = await stoTest();
            return t.hosterLink ? true : (t.loggedIn && t.checkPage ? 'check' : false);
        },
        providerCounts: async () => {
            const counts = {};
            for (const [type, id] of NOTIFY_TITLES) {
                const [ref, se, ep] = id.split(':');
                const pType = type === 'movie' ? 'movie' : 'tv';
                const tmdbId = await toTmdb(ref, pType).catch(() => null);
                if (!tmdbId) continue;
                await Promise.all(providers.filter(p => p.types.includes(pType)).map(async p => {
                    const list = await runProvider(p, tmdbId, pType, se ? Number(se) : null, ep ? Number(ep) : null).catch(() => []) || [];
                    // count only streams that really start (up to 2 tried per title), so a site whose links all fail is noticed too
                    let n = 0;
                    for (const raw of list.filter(x => x && x.url).slice(0, 2)) {
                        const st = toAddonStream(raw, p, { type, id }).stream;
                        if (/^OK/.test(await playCheck(st).catch(() => 'FAIL'))) { n++; break; }
                    }
                    counts[p.name || p.id] = (counts[p.name || p.id] || 0) + n;
                }));
            }
            return counts;
        },
    }, log);
    // a failed SerienStream check is repeated an hour later before you are told
    if (st.stoFails >= 1 && st.stoFails <= 24) setTimeout(() => notifyRun().catch(() => {}), 60 * 60000).unref();
    log(`notify check: SerienStream ${st.sto}, providers ${JSON.stringify(Object.fromEntries(Object.entries(st.providers).map(([k, v]) => [k, v.n])))}`);
}
if (process.env.NOTIFY !== '0' && require.main === module) {
    // daily, counted from the last check (kept across updates), at the earliest 15 minutes after a start
    const daily = () => {
        const last = Date.parse(require('./notify.js').state.lastRun || '') || 0;
        const wait = last ? Math.max(15 * 60000, last + 24 * 3600 * 1000 - Date.now()) : 15 * 60000;
        setTimeout(() => notifyRun().catch(e => log(`notify: ${e.message}`)).then(daily), wait).unref();
    };
    daily();
}

const server = http.createServer(async (req, res) => {
    if (!process.env.PUBLIC_URL && req.headers.host && !/^(localhost|127\.|10\.|192\.168\.)/.test(req.headers.host)) {
        publicBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    }
    if ((req.url || '').startsWith('/p/')) return passthrough.handle(req, res, publicBase || `http://${req.headers.host}`);
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (url === '/streams/health') return send(res, 200, Object.assign(health.summary(), { relayBackoff: passthrough.usage().backoff, recentRequests }));
    if (url === '/sto/status') { net.stoInit(); return send(res, 200, net.stoStatus()); }
    if (url === '/' || url === '/health') {
        // a real check: cron-job.org's "notify on failure" emails when this is not 200
        const problems = [];
        if (!TMDB_API_KEY) problems.push('TMDB key missing');
        if (!providers.length) problems.push('no providers loaded');
        if (process.env.WARP !== '0' && warpDownSince && Date.now() - warpDownSince > 30 * 60000) problems.push('WARP down for over 30 minutes');
        const paused = providers.filter(p => p.pausedUntil > Date.now()).map(p => p.id);
        return send(res, problems.length ? 503 : 200, { ok: !problems.length, problems, warp: net.warpOn(), addon: `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/manifest.json`, plugins: pluginVersion, providers: providers.map(p => p.id), paused, tmdbKey: !!TMDB_API_KEY, tmdbKeyStatus: keyStatus, linkChecks: verifyStats, serienstreamLogin: require('./sto-session.js').status().loggedIn, serienstreamCheck: (() => { if (!net.stoInit()) return null; const x = net.stoStatus(); return { links: x.links, meaning: x.meaning, since: x.since, login: x.login, availabilityPercent: x.availabilityPercent, details: '/sto/status' }; })(), notify: (() => { const n = require('./notify.js').state; return { lastRun: n.lastRun, serienstream: n.sto, sent: n.sent.slice(0, 3) }; })(), downHosts: net.status().down });
    }
    if (url === '/logo.png') {
        try {
            const img = fs.readFileSync(path.join(__dirname, 'logo.png'));
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400', 'Access-Control-Allow-Origin': '*' });
            return res.end(img);
        } catch (e) { res.writeHead(404); return res.end(); }
    }
    if (url === '/manifest.json') return send(res, 200, addonManifest(), 3600);
    if (url === '/diag' || url.startsWith('/diag/')) return send(res, 200, await net.diag());
    if (url === '/net' || url.startsWith('/net/')) return send(res, 200, Object.assign(net.status(), { passthrough: passthrough.usage() }));

    // debug jobs: /debug/start/series/tt1199099:1:1[/serienstream,huhuto]  ->  { job }   then  /debug/job/<job>
    const ds = url.match(/^\/debug\/start\/(movie|series)\/([^/]+?)(?:\/([a-z0-9,]+))?\/?$/);
    if (ds) {
        const id = Math.random().toString(36).slice(2, 8);
        const job = { started: new Date().toISOString(), type: ds[1], id: ds[2], done: false, providers: {} };
        jobs.set(id, job);
        if (jobs.size > 30) jobs.delete(jobs.keys().next().value);
        runDebugJob(job, ds[3] ? ds[3].split(',') : null).catch(e => { job.error = e.message; job.done = true; });
        return send(res, 200, { job: id, result: `/debug/job/${id}` });
    }
    // look at a video host page from the server (for building/fixing readers): /debug/fetch?token=<RELAY_TOKEN>&url=...&ref=...
    // password-protected so the server can't be used as an open proxy
    // phone notifications: /notify/test?token=<admin> sends a test message and shows the channel to subscribe to
    if (url === '/notify/test' || url === '/notify/run') {
        const q = new URL(req.url, 'http://x').searchParams;
        if (!adminOk(q)) return send(res, 403, { error: 'wrong token' });
        const notify = require('./notify.js');
        try {
            if (url === '/notify/run') { await notifyRun(); return send(res, 200, notify.state); }
            const topic = await notify.getTopic();
            const ok = await notify.send('German addon: test', 'Notifications work. You will only hear from the addon again when something breaks.', 'tada');
            return send(res, 200, { sent: ok, channel: topic, subscribe: `https://ntfy.sh/${topic}` });
        } catch (e) { return send(res, 200, { error: e.message }); }
    }
    // your SerienStream login for the addon (see sto-session.js): /sto/session shows a small form
    if (url === '/sto/session') {
        const sto = require('./sto-session.js');
        if (req.method !== 'POST') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SerienStream login</title>
<style>body{font:16px system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;background:#14171c;color:#e8e8e8}input,textarea,button{width:100%;box-sizing:border-box;margin:6px 0 14px;padding:10px;border-radius:6px;border:1px solid #444;background:#1f242c;color:#fff;font:inherit}button{background:#2d6cdf;border:0;cursor:pointer}small{color:#aaa}</style>
<h2>SerienStream login for the addon</h2><p>Status: <b>${sto.status().loggedIn ? 'logged in (' + sto.status().source + ')' : 'not set'}</b></p>
<form method="post"><label>Admin password</label><input name="token" type="password" autocomplete="off" required>
<label>Your serienstream.to cookie</label><textarea name="cookie" rows="6" required placeholder="name=value; name2=value2; ..."></textarea>
<small>Only sent to your own server. The addon sends it to serienstream.to only, never to anyone else.</small><button>Save and test</button></form>`);
        }
        let body = '';
        for await (const c of req) { body += c; if (body.length > 20000) break; }
        const q = new URLSearchParams(body);
        if (!adminOk(q)) return send(res, 403, { error: 'wrong admin password' });
        const enc = await sto.set(q.get('cookie') || '');
        const test = await stoTest();
        for (const k of [...cache.keys()]) if (k.startsWith('series:')) cache.delete(k);
        const ok = !!test.hosterLink;   // the real proof: a German hoster button leads straight to the hoster
        if (ok) test.loggedIn = true;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SerienStream login</title>
<style>body{font:16px system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;background:#14171c;color:#e8e8e8}textarea{width:100%;box-sizing:border-box;background:#1f242c;color:#fff;border:1px solid #444;border-radius:6px;padding:10px;font:13px monospace}</style>
<h2>${ok ? '✅ SerienStream works with your login' : '❌ Not working yet'}</h2>
<p>Logged in: <b>${test.loggedIn ? 'yes' : 'no'}</b> · Check required: <b>${test.gate || '?'}</b> · German hoster link: <b>${test.hosterLink || 'none'}</b>${test.error ? ' · Error: ' + test.error : ''}</p>
${ok && enc ? `<p><b>Keep it after updates:</b> on GitHub choose <i>Add file → Create new file</i>, name it <code>sto-session.enc</code>, paste everything below and commit. It is encrypted so that only your Oracle server can read it.</p><textarea rows="6" readonly onclick="this.select()">${enc}</textarea>` : ''}
${ok && !enc ? '<p>Saved until the next server update (this machine could not create an encrypted copy).</p>' : ''}`);
    }
    if (url === '/debug/fetch') {
        const q = new URL(req.url, 'http://x').searchParams;
        if (!adminOk(q)) return send(res, 403, { error: 'wrong token' });
        try {
            const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' };
            if (q.get('ref')) h.Referer = q.get('ref');
            const opts = { headers: h };
            if (q.get('post') != null) { opts.method = 'POST'; opts.body = q.get('post'); h['Content-Type'] = q.get('ctype') || 'application/json'; }
            const r = await net.smartFetch(q.get('url'), opts);   // same connections the plugins use (incl. WARP)
            const text = await r.text();
            const at = Number(q.get('from')) || 0;
            return send(res, 200, { status: r.status, url: r.url, type: r.headers.get('content-type'), length: text.length, body: text.slice(at, at + 20000) });
        } catch (e) { return send(res, 200, { error: e.message }); }
    }
    // veev test: /debug/veev?url=https://veev.to/e/<code>
    if ((url === '/debug/veev' || url === '/debug/byse' || url.startsWith('/debug/sto')) && !adminOk(new URL(req.url, 'http://x').searchParams)) return send(res, 403, { error: 'wrong token' });
    if (url === '/debug/veev') {
        const target = new URL(req.url, 'http://x').searchParams.get('url') || '';
        const steps = [];
        try { const list = await require('./veev.js').extract(target, m => steps.push(m)); return send(res, 200, { ok: !!list.length, steps, streams: list }); }
        catch (e) { return send(res, 200, { ok: false, steps, error: e.message }); }
    }
    // Filemoon/Byse test: /debug/byse?url=https://filemoon.to/e/<code>
    if (url === '/debug/byse') {
        const target = new URL(req.url, 'http://x').searchParams.get('url') || '';
        const steps = [];
        try { const list = await require('./byse.js').extract(target, 'https://huhu.to', m => steps.push(m)); return send(res, 200, { ok: !!list.length, steps, streams: list }); }
        catch (e) { return send(res, 200, { ok: false, steps, error: e.message }); }
    }
    // series check: /scan/series/tt0458290[/5]  ->  { job }  then /scan/job/<id>
    // goes through every episode (or one season) and lists which have German streams, from which sites
    const sc = url.match(/^\/scan\/series\/(tt\d+|tmdb:\d+)(?:\/(\d+))?\/?$/);
    if (sc) {
        const id = Math.random().toString(36).slice(2, 8);
        const job = { started: new Date().toISOString(), show: sc[1], done: false, progress: '0/?', seasons: {} };
        scans.set(id, job);
        if (scans.size > 10) scans.delete(scans.keys().next().value);
        runScan(job, sc[1], sc[2] ? Number(sc[2]) : null).catch(e => { job.error = e.message; job.done = true; });
        return send(res, 200, { job: id, result: `/scan/job/${id}` });
    }
    const sj = url.match(/^\/scan\/job\/(\w+)$/);
    if (sj) return send(res, scans.has(sj[1]) ? 200 : 404, scans.get(sj[1]) || { error: 'unknown job' });
    if (url.startsWith('/audit/start')) {
        const id = Math.random().toString(36).slice(2, 8);
        const audit = { started: new Date().toISOString(), done: false, progress: '0/' + AUDIT_TITLES.length, titles: {} };
        audits.set(id, audit);
        runAudit(audit).catch(e => { audit.error = e.message; audit.done = true; });
        return send(res, 200, { audit: id, result: `/audit/job/${id}` });
    }
    // s.to gate inspection: /debug/sto/<episode path>  e.g. /debug/sto/serie/die-legende-von-korra/staffel-1/episode-1
    if (url.startsWith('/debug/sto/') || url.startsWith('/debug/sto-part/')) {
        const part = url.startsWith('/debug/sto-part/');
        const rest = url.replace(/^\/debug\/sto(-part)?\//, '');
        const [pathPart, sectionText] = part ? [rest.replace(/\/(\d+)$/, ''), (rest.match(/\/(\d+)$/) || [])[1]] : [rest, null];
        try {
            const base = 'https://serienstream.to';
            const epUrl = `${base}/${pathPart}`;
            const ep = await net.smartFetch(epUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } });
            const html = await ep.text();
            const play = (html.match(/data-play-url="([^"]+)"/) || [])[1];
            const dlgAt = html.indexOf('Video wird vorbereitet');
            const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
            const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1].trim()).filter(Boolean);
            let r = null;
            if (play) {
                const rr = await net.smartFetch(base + play.replace(/&amp;/g, '&'), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', Referer: epUrl }, _stoProbe: true });
                r = { status: rr.status, finalUrl: rr.url, setCookie: rr.headers.get('set-cookie'), body: await rr.text() };
            }
            const report = {
                episode: { status: ep.status, bytes: html.length, playUrlFound: !!play, scriptSrcs: scripts,
                    dialogHtml: dlgAt >= 0 ? html.slice(Math.max(0, dlgAt - 1500), dlgAt + 2500) : null,
                    inlineScriptsMentioningPlay: inline.filter(x => /play|weiter|step|captcha|turnstile|redirect|\/r\?/i.test(x)).map(x => x.slice(0, 3000)) },
                redirect: r,
            };
            if (part) {
                // the same report as plain text in 1500-character pieces (my reader quotes small pieces more reliably)
                const text = JSON.stringify(report, null, 1);
                const n = Number(sectionText) || 0;
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end(`piece ${n} of ${Math.ceil(text.length / 1500) - 1}\n` + text.slice(n * 1500, n * 1500 + 1500));
            }
            return send(res, 200, report);
        } catch (e) { return send(res, 200, { error: e.message }); }
    }
    const aj = url.match(/^\/audit\/job\/([a-z0-9]+)/);
    if (aj) return send(res, 200, audits.get(aj[1]) || { error: 'unknown audit' });
    const dj = url.match(/^\/debug\/job\/([a-z0-9]+)/);
    if (dj) return send(res, 200, jobs.get(dj[1]) || { error: 'unknown job' });

    const q = new URL(req.url || '/', 'http://x').searchParams;
    // set the TMDB key from a browser: /setkey?token=<RELAY_TOKEN>&key=<TMDB key>
    if (url === '/setkey') {
        const q = new URL(req.url, 'http://x').searchParams;
        if (!adminOk(q)) return send(res, 403, { error: 'wrong token' });
        const k = (q.get('key') || '').trim();
        const ok = k && (await fetch(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(k)}`).then(r => r.ok, () => false));
        if (!ok) return send(res, 400, { error: 'TMDB did not accept that key' });
        setKey(k, 'set by link');
        log('TMDB key set by link');
        return send(res, 200, { ok: true, tmdbKey: true });
    }
    if (url === '/relay/config') {
        if (!adminOk(q)) return send(res, 403, { error: 'wrong token' });
        return res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify({ tmdbKey: TMDB_API_KEY }));
    }

    // diagnostics: /check/series/tt0944947:1:1  -> what every provider returns from this server (no cache)
    const c = url.match(/^\/check\/(movie|series)\/(.+?)(\.json)?$/);
    if (c) {
        if (!TMDB_API_KEY) return send(res, 200, { error: 'TMDB_API_KEY is not set' });
        try {
            const [ref, s, e] = c[2].split(':');
            const pType = c[1] === 'movie' ? 'movie' : 'tv';
            const tmdbId = /^tt\d+$/.test(ref) ? await toTmdb(ref, pType) : ref;
            const plan = await numberingPlan(ref, pType, tmdbId, s ? Number(s) : null, e ? Number(e) : null);
            const report = await Promise.all(providers.filter(p => p.types.includes(pType) && plan.for(p.id)).map(async p => {
                const asked = plan.for(p.id);
                const t = Date.now();
                try {
                    const list = await runProvider(p, tmdbId, pType, ...asked);
                    return { provider: p.id, streams: (list || []).length, ms: Date.now() - t, first: (list || [])[0] && list[0].name };
                } catch (err) { return { provider: p.id, error: err.message, ms: Date.now() - t }; }
            }));
            return send(res, 200, { tmdbId, report });
        } catch (err) { return send(res, 200, { error: err.message }); }
    }

    const m = url.match(/^\/stream\/(movie|series|anime)\/(.+)\.json$/);
    if (!m) return send(res, 404, { error: 'not found' });
    if (!TMDB_API_KEY) return send(res, 200, { streams: [], error: 'TMDB_API_KEY is not set' });
    const t0 = Date.now();
    log(`stream ${m[1]} ${m[2]}`);
    try {
        // order: working first, failing (or on a video server we're pausing right now) last, hidden left out
        recentRequests.unshift(`${new Date().toISOString().slice(11, 19)} ${m[1]} ${m[2]}`); recentRequests.length = Math.min(recentRequests.length, 30);
        const streams = health.apply(await getStreams(m[1], m[2]), st => srcKey.get(st), st => passthrough.paused(st.url));
        // autoplay asks for the next episode only seconds before it starts; have the answer ready by then
        const ep = m[1] !== 'movie' && m[2].match(/^(.*):(\d+):(\d+)$/);
        if (PREFETCH && ep && streams.length) {
            const next = `${ep[1]}:${ep[2]}:${Number(ep[3]) + 1}`;
            setTimeout(() => require('./sto-access.js').priority.run('low', () => getStreams(m[1], next, true)).then(l => {
                log(`prefetched ${next}: ${l.length} streams`);
                // nothing there: probably the season's last episode, so get the next season's first one ready
                if (!l.length) {
                    const first = `${ep[1]}:${Number(ep[2]) + 1}:1`;
                    return require('./sto-access.js').priority.run('low', () => getStreams(m[1], first, true)).then(f => log(`prefetched ${first}: ${f.length} streams`));
                }
            }).catch(() => {}), 5000);
        }
        log(`  -> ${streams.length} streams in ${Date.now() - t0} ms`);
        send(res, 200, { streams, cacheMaxAge: 300 });
    } catch (e) {
        log(`  -> failed: ${e.message}`);
        send(res, 200, { streams: [] });
    }
});

if (require.main === module) {
    require('./sto-session.js').load().then(() => { log(`SerienStream login: ${JSON.stringify(require('./sto-session.js').status().source)}`); net.stoInit(); }).catch(() => {});
    loadFrom(BUNDLED_DIR);
    if (!TMDB_API_KEY) {
        log('WARNING: TMDB_API_KEY is not set' + (RELAY_TOKEN ? `, asking ${KEY_SOURCE} for it` : ', every lookup will return nothing'));
        if (RELAY_TOKEN) (async () => {
            for (let i = 0; !TMDB_API_KEY; i++) {
                try {
                    const r = await fetch(`${KEY_SOURCE}/relay/config?token=${encodeURIComponent(RELAY_TOKEN)}`, { signal: AbortSignal.timeout(90000) });
                    const d = await r.json().catch(() => ({}));
                    if (d.tmdbKey) { setKey(d.tmdbKey, 'from ' + KEY_SOURCE); log('TMDB key received from ' + KEY_SOURCE); break; }
                    keyStatus = `missing (${KEY_SOURCE} answered ${r.status}${d.error ? ' ' + d.error : ''})`;
                } catch (e) { keyStatus = `missing (${KEY_SOURCE}: ${e.message})`; }
                log('  ' + keyStatus);
                await new Promise(r => setTimeout(r, Math.min(600000, 30000 * (i + 1))));
            }
        })();
    }
    server.listen(PORT, () => log(`German Providers addon on http://localhost:${PORT}/manifest.json`));
    // an update stops the container: keep what s.to answered and the notification state before going
    for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => {
        log(`${sig}: saving state, stopping`);
        try { require('./sto-access.js')._save(); } catch (e) {}
        try { require('./notify.js').save(); } catch (e) {}
        try { health.save(); } catch (e) {}
        server.close();
        setTimeout(() => process.exit(0), 1500).unref();
    });
    net.startWarpWatch();
    // YouTube film channels: fetch their lists after the start and then once a day
    if (!SKIP.includes('youtube')) { const w = () => require('./youtube.js').warm().catch(() => {}); setTimeout(w, 3 * 60000).unref(); setInterval(w, 24 * 3600 * 1000).unref(); }
    if (AUTO_UPDATE) { update(); setInterval(update, UPDATE_HOURS * 3600000).unref(); }
}

module.exports = { _setBase: b => { publicBase = b; }, server, loadFrom, toAddonStream, getStreams, _update: update, _cache: cache, _providers: () => providers };
