#!/usr/bin/env node
// German Providers as a Stremio/Nuvio/AIOStreams addon.
// Wraps the Nuvio plugins from InvalidPandaa/nuvio-german-providers (GPL-3.0) in a normal addon server,
// and tags every stream with a binge group so "next episode" stays on the German source.
'use strict';

const http = require('http');
const net = require('./net.js');
const passthrough = require('./stream.js');
let publicBase = (process.env.PUBLIC_URL || '').replace(/\/$/, '');   // learnt from the first request if not set
// the scrapers call the global fetch(): route it through the Chrome-like / WARP connection layer
globalThis.fetch = net.smartFetch;
const fetch = net.nativeFetch;   // this file's own calls (TMDB lookup, updates, relay) stay plain
const fs = require('fs');
const path = require('path');

// ---------- settings (environment variables) ----------
const PORT = Number(process.env.PORT) || 7000;
const TMDB_API_KEY = (process.env.TMDB_API_KEY || '').trim();
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 15000;       // how long the addon waits before answering
const CACHE_MIN = Number(process.env.CACHE_MINUTES) || 10;        // reuse results (stream links expire, keep short)
const ONLY = (process.env.PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean);   // e.g. "serienstream,aniworld,ard"
const SKIP = (process.env.SKIP_PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean);
const AUTO_UPDATE = process.env.AUTO_UPDATE !== '0';               // pull the latest provider files from his repo
const UPDATE_URL = process.env.UPDATE_URL || 'https://invalidpandaa.github.io/nuvio-german-providers/';
const UPDATE_HOURS = Number(process.env.UPDATE_HOURS) || 12;
const PREFETCH = process.env.PREFETCH !== '0';                    // look up the next episode in advance
const PREFETCH_MIN = Number(process.env.PREFETCH_MINUTES) || 40;  // how long a prefetched result is kept
// Home relay: a copy of this addon running on the FireTV (home internet) registers its tunnel address here, and
// /stream requests are passed to it, because many sites (VOE, AniWorld …) block data-centre servers like Render.
const RELAY_TOKEN = (process.env.RELAY_TOKEN || '').trim();
let relay = null;   // { url, time }

globalThis.TMDB_API_KEY = TMDB_API_KEY;   // the plugins read the key from here, like inside Nuvio

// the plugin files normally live in ./providers; a GitHub web upload can flatten them into the main folder
const BUNDLED_DIR = fs.existsSync(path.join(__dirname, 'providers', 'manifest.json')) ? path.join(__dirname, 'providers') : __dirname;
const CACHE_DIR = process.env.DATA_DIR || path.join(__dirname, '.provider-cache');   // inside the project so require('cheerio') resolves

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- loading the plugins ----------
let providers = [];   // [{ id, name, types, mod, lock }]
let pluginVersion = '?';

function loadFrom(dir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const list = [];
    for (const s of manifest.scrapers) {
        if (ONLY.length && !ONLY.includes(s.id)) continue;
        if (SKIP.includes(s.id)) continue;
        const file = path.resolve(dir, s.filename.replace(/^providers\//, ''));
        try {
            delete require.cache[require.resolve(file)];
            const mod = require(file);
            if (typeof mod.getStreams !== 'function') throw new Error('no getStreams');
            list.push({ id: s.id, name: s.name, types: s.supportedTypes || [], mod, lock: Promise.resolve() });
        } catch (e) {
            log(`provider ${s.id} failed to load: ${e.message}`);
        }
    }
    if (!list.length) throw new Error(`no providers loaded from ${dir}`);
    providers = list;
    pluginVersion = manifest.version;
    log(`loaded ${list.length} providers v${manifest.version} from ${dir === BUNDLED_DIR ? 'bundled copy' : 'update cache'}: ${list.map(p => p.id).join(', ')}`);
}

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
        loadFrom(CACHE_DIR);
        cache.clear();
    } catch (e) {
        log(`update check failed, keeping v${pluginVersion}: ${e.message}`);
    }
}

// The plugins keep a little state per file (a deadline and a request counter), so one file must not run two
// searches at the same time. Each provider gets a queue; the cache below stops the same title being searched twice.
function runProvider(p, tmdbId, type, season, episode) {
    const job = p.lock.then(() => p.mod.getStreams(tmdbId, type, season, episode));
    p.lock = job.catch(() => {});
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
    const id = hit ? String(hit.id) : null;
    if (id) tmdbIds.set(key, id);
    return id;
}

// ---------- turning plugin streams into addon streams ----------
const LANG_KEY = lang => (lang === 'Deutsch' ? 'de' : /dt\. UT|OmU/.test(lang) ? 'de-sub' : 'other');
const RANK = { de: 0, 'de-sub': 1, other: 2 };

function toAddonStream(s, provider) {
    // s.name looks like "Serienstream · Deutsch · voe.sx" (built by the plugin)
    const parts = (s.name || provider.name).split(' · ');
    const lang = parts[1] || 'Deutsch';
    const key = LANG_KEY(lang);
    const flag = key === 'de' ? '🇩🇪' : key === 'de-sub' ? '🇩🇪 UT' : '🌐';
    const quality = s.quality || 'auto';
    let headers = s.headers && Object.keys(s.headers).length ? s.headers : null;
    let url = s.url;
    // hosts like VOE only play on the connection that found the link: pass those through this server
    if (publicBase && passthrough.wanted(s, parts.join(' '), provider.id)) {
        url = passthrough.proxyUrl(publicBase, s.url, headers);
    }
    const out = {
        name: `${flag} DE Providers\n${quality}`,
        title: [`${parts[0]} · ${lang}`, s.title].filter(Boolean).join('\n'),
        url,
        behaviorHints: {
            // same group on every episode -> Nuvio/Stremio pick this addon again for the next episode
            bingeGroup: `german-providers-${key}`,
            notWebReady: !!headers || undefined,
            proxyHeaders: headers ? { request: headers } : undefined,
        },
    };
    out.description = out.title;
    if (headers) out.headers = headers;   // Nuvio-style field, ignored by apps that don't know it
    return { rank: RANK[key], stream: out };
}

// ---------- the stream lookup with cache ----------
const cache = new Map();   // key -> { time, ttl, promise }

async function lookup(type, id) {
    const [imdbOrTmdb, s, e] = id.split(':').filter(x => x !== 'tmdb');
    const season = type === 'series' ? Number(s) : null;
    const episode = type === 'series' ? Number(e) : null;
    const pType = type === 'movie' ? 'movie' : 'tv';
    const tmdbId = /^tt\d+$/.test(imdbOrTmdb) ? await toTmdb(imdbOrTmdb, pType) : imdbOrTmdb;
    if (!tmdbId) return [];

    const active = providers.filter(p => p.types.includes(pType));
    const results = [];
    const started = Date.now();
    const runs = active.map((p, order) => runProvider(p, tmdbId, pType, season, episode)
        .then(list => {
            (list || []).forEach((st, i) => results.push(Object.assign(toAddonStream(st, p), { order, i })));
            log(`  ${p.id}: ${(list || []).length} streams in ${Date.now() - started} ms`);
        })
        .catch(err => log(`  ${p.id}: error ${err.message}`)));

    // answer when every provider is done, or at the time limit with whatever arrived so far
    let timedOut = false;
    await Promise.race([Promise.all(runs), new Promise(r => setTimeout(() => { timedOut = true; r(); }, TIMEOUT_MS))]);
    const snapshot = results.slice();
    if (timedOut) {
        // late providers still finish in the background; refresh the cache with the full list for the next request
        Promise.all(runs).then(() => {
            const key = `${type}:${id}`;
            if (results.length > snapshot.length) cache.set(key, { time: Date.now(), ttl: CACHE_MIN * 60000, promise: Promise.resolve(sortStreams(results)) });
        });
    }
    return sortStreams(snapshot);
}

const sortStreams = list => list.slice().sort((a, b) => a.rank - b.rank || a.order - b.order || a.i - b.i).map(x => x.stream);

function getStreams(type, id, prefetched) {
    const key = `${type}:${id}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < hit.ttl) return hit.promise;
    const promise = lookup(type, id).then(streams => {
        // nothing found: only remember that briefly
        entry.ttl = (streams.length ? (prefetched ? PREFETCH_MIN : CACHE_MIN) : 2) * 60000;
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
    const [ref, s, e] = job.id.split(':');
    const pType = job.type === 'movie' ? 'movie' : 'tv';
    const tmdbId = /^tt\d+$/.test(ref) ? await toTmdb(ref, pType) : ref;
    job.tmdbId = tmdbId;
    if (!tmdbId) { job.done = true; job.error = 'no TMDB match'; return; }
    const list = providers.filter(p => p.types.includes(pType) && (!only || only.includes(p.id)));
    await Promise.all(list.map(async p => {
        const entry = job.providers[p.id] = { running: true, requests: [] };
        const t = Date.now();
        await net.traceStore.run(entry.requests, async () => {
            try {
                const streams = (await runProvider(p, tmdbId, pType, s ? Number(s) : null, e ? Number(e) : null)) || [];
                entry.streams = streams.length;
                entry.sample = streams.slice(0, 3).map(x => `${x.name} | ${(x.url || '').slice(0, 70)}`);
            } catch (err) { entry.error = err.message; }
        });
        entry.ms = Date.now() - t;
        entry.running = false;
    }));
    job.done = true;
}

// ---------- HTTP server ----------
const relayAlive = () => !!relay && Date.now() - relay.time < 12 * 60000;

function addonManifest() {
    return {
        id: 'community.german-providers.addon',
        version: '1.1.0',
        name: 'German Providers',
        description: `Deutsche Quellen (s.to, AniWorld, ARD, Arte, FilmPalast …) als Addon. Plugins v${pluginVersion} von InvalidPandaa/nuvio-german-providers (GPL-3.0).`,
        logo: 'https://flagcdn.com/w160/de.png',
        resources: ['stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'tmdb:'],
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
    res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
    if (!process.env.PUBLIC_URL && req.headers.host && !/^(localhost|127\.|10\.|192\.168\.)/.test(req.headers.host)) {
        publicBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    }
    if ((req.url || '').startsWith('/p/')) return passthrough.handle(req, res, publicBase || `http://${req.headers.host}`);
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (url === '/' || url === '/health') {
        return send(res, 200, { ok: true, homeRelay: relayAlive() ? 'online' : 'offline', addon: `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/manifest.json`, plugins: pluginVersion, providers: providers.map(p => p.id), tmdbKey: !!TMDB_API_KEY });
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
    const dj = url.match(/^\/debug\/job\/([a-z0-9]+)/);
    if (dj) return send(res, 200, jobs.get(dj[1]) || { error: 'unknown job' });

    // ---- home relay ----
    const q = new URL(req.url || '/', 'http://x').searchParams;
    if (url === '/relay/register' || url === '/relay/config') {
        if (!RELAY_TOKEN || q.get('token') !== RELAY_TOKEN) return send(res, 403, { error: 'wrong token' });
        if (url === '/relay/config') return send(res, 200, { tmdbKey: TMDB_API_KEY });
        const target = q.get('url') || '';
        if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(target)) return send(res, 400, { error: 'bad url' });
        if (!relay || relay.url !== target) log(`home relay registered: ${target}`);
        relay = { url: target, time: Date.now() };
        return send(res, 200, { ok: true });
    }

    // diagnostics: /check/series/tt0944947:1:1  -> what every provider returns from this server (no cache)
    const c = url.match(/^\/check\/(movie|series)\/(.+?)(\.json)?$/);
    if (c) {
        if (!TMDB_API_KEY) return send(res, 200, { error: 'TMDB_API_KEY is not set' });
        try {
            const [ref, s, e] = c[2].split(':');
            const pType = c[1] === 'movie' ? 'movie' : 'tv';
            const tmdbId = /^tt\d+$/.test(ref) ? await toTmdb(ref, pType) : ref;
            const report = await Promise.all(providers.filter(p => p.types.includes(pType)).map(async p => {
                const t = Date.now();
                try {
                    const list = await runProvider(p, tmdbId, pType, s ? Number(s) : null, e ? Number(e) : null);
                    return { provider: p.id, streams: (list || []).length, ms: Date.now() - t, first: (list || [])[0] && list[0].name };
                } catch (err) { return { provider: p.id, error: err.message, ms: Date.now() - t }; }
            }));
            return send(res, 200, { tmdbId, report });
        } catch (err) { return send(res, 200, { error: err.message }); }
    }

    const m = url.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (!m) return send(res, 404, { error: 'not found' });
    if (!TMDB_API_KEY) return send(res, 200, { streams: [], error: 'TMDB_API_KEY is not set' });
    const t0 = Date.now();
    log(`stream ${m[1]} ${m[2]}`);
    if (relayAlive()) {
        try {
            const r = await fetch(relay.url + url, { signal: AbortSignal.timeout(TIMEOUT_MS + 10000) });
            const body = await r.json();
            if (!r.ok || !Array.isArray(body.streams)) throw new Error(`HTTP ${r.status}`);
            log(`  -> ${body.streams.length} streams from home relay in ${Date.now() - t0} ms`);
            return send(res, 200, body);
        } catch (e) {
            log(`  home relay failed (${e.message}), searching from here instead`);
            relay = null;
        }
    }
    try {
        const streams = await getStreams(m[1], m[2]);
        // autoplay asks for the next episode only seconds before it starts; have the answer ready by then
        const ep = m[1] === 'series' && m[2].match(/^(.*):(\d+):(\d+)$/);
        if (PREFETCH && ep && streams.length) {
            const next = `${ep[1]}:${ep[2]}:${Number(ep[3]) + 1}`;
            setTimeout(() => getStreams('series', next, true).then(l => log(`prefetched ${next}: ${l.length} streams`), () => {}), 5000);
        }
        log(`  -> ${streams.length} streams in ${Date.now() - t0} ms`);
        send(res, 200, { streams, cacheMaxAge: 300 });
    } catch (e) {
        log(`  -> failed: ${e.message}`);
        send(res, 200, { streams: [] });
    }
});

if (require.main === module) {
    loadFrom(BUNDLED_DIR);
    if (!TMDB_API_KEY) log('WARNING: TMDB_API_KEY is not set, every lookup will return nothing');
    server.listen(PORT, () => log(`German Providers addon on http://localhost:${PORT}/manifest.json`));
    net.startWarpWatch();
    if (AUTO_UPDATE) { update(); setInterval(update, UPDATE_HOURS * 3600000).unref(); }
}

module.exports = { _setBase: b => { publicBase = b; }, _setRelay: r => { relay = r; }, server, loadFrom, toAddonStream, getStreams, _cache: cache, _providers: () => providers };
