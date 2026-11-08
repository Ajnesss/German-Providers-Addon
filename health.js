// Stream health: remembers, per title + site + hoster (e.g. "movie:tt0816692 | moflix | vidsonic"), whether its links
// started when the server tried them. Links are tried in the background after every fresh lookup (verifyLater).
//   - works          -> listed first
//   - failed lately  -> listed after the working ones
//   - failed in two separate checks at least 10 minutes apart, and never started in between -> hidden for 1 hour, then 3, then
//     6 hours at most. Hidden sources are still looked up and tried in the background; the first time one starts
//     again it is shown again. Nothing is ever removed for good.
// A host that answers "429 Too many requests" is rate-limiting, not broken: that never counts as a failure.
// Several failed checks close together (a short network problem, repeated lookups) count as one: within 5 minutes of a
// counted failure further failures are ignored, so only failures spread over time can hide anything.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN = 60000, HOUR = 60 * MIN;
const HIDE_STEPS = (process.env.HEALTH_HIDE_HOURS || '1,3,6').split(',').map(h => Number(h) * HOUR);
const SPREAD_MS = (Number(process.env.HEALTH_SPREAD_MINUTES) || 10) * MIN;   // two failures this far apart = a pattern
const FORGET_MS = 7 * 24 * HOUR;
const WINDOW_MS = (Number(process.env.HEALTH_WINDOW_MINUTES) || 5) * MIN;
const FILE = path.join(process.env.STATE_DIR || path.join(os.homedir(), '.german-addon'), 'health.json');

const sources = new Map();   // key -> { ok, fail, firstFail, lastFail, lastOk, hides, hiddenUntil }
const stats = { hidden: 0, recovered: 0, checks: 0, rateLimited: 0 };

function load() {
    try {
        const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        for (const [k, v] of d.sources || []) if (Date.now() - Math.max(v.lastOk || 0, v.lastFail || 0) < FORGET_MS) sources.set(k, v);
    } catch (e) {}
}
let saveTimer = null;
function save() {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify({ v: 1, sources: [...sources] }));
    } catch (e) {}
}
function saveSoon() { if (!saveTimer) { saveTimer = setTimeout(() => { saveTimer = null; save(); }, 60000); saveTimer.unref(); } }
load();

function rec(key) {
    let r = sources.get(key);
    if (!r) { r = { ok: 0, fail: 0, firstFail: 0, lastFail: 0, lastOk: 0, hides: 0, hiddenUntil: 0 }; sources.set(key, r); if (sources.size > 20000) sources.delete(sources.keys().next().value); }
    return r;
}

function ok(key) {
    if (!key) return;
    const r = rec(key);
    stats.checks++;
    if (r.hiddenUntil) stats.recovered++;
    Object.assign(r, { ok: r.ok + 1, fail: 0, firstFail: 0, lastOk: Date.now(), hiddenUntil: 0, hides: 0 });
    saveSoon();
}
function fail(key) {
    if (!key) return;
    const r = rec(key);
    stats.checks++;
    if (r.lastFail && Date.now() - r.lastFail < WINDOW_MS && r.lastFail > r.lastOk) { saveSoon(); return; }   // same incident
    r.fail++;
    r.lastFail = Date.now();
    if (!r.firstFail) r.firstFail = r.lastFail;
    const pattern = r.fail >= 2 && r.lastFail - r.firstFail >= SPREAD_MS;
    if (pattern && r.hiddenUntil <= Date.now()) {
        r.hiddenUntil = Date.now() + HIDE_STEPS[Math.min(r.hides, HIDE_STEPS.length - 1)];
        r.hides++;
        stats.hidden++;
    }
    saveSoon();
}
function rateLimited() { stats.rateLimited++; }

const state = key => {
    const r = key && sources.get(key);
    if (!r) return 'unknown';
    if (r.hiddenUntil > Date.now()) return 'hidden';
    if (r.fail > 0 && r.lastFail > r.lastOk) return 'failing';
    if (r.lastOk) return 'ok';
    return 'unknown';
};

// order a ready list for the player: working first, unknown next, failing last; hidden ones left out unless nothing
// else would be left. keyOf(stream) gives a stream's key.
function apply(list, keyOf, paused) {
    const tagged = list.map((s, i) => { let st = state(keyOf(s)); if (st !== 'hidden' && paused && paused(s)) st = 'failing'; return { s, i, st }; });
    const visible = tagged.filter(t => t.st !== 'hidden');
    const use = visible.length ? visible : tagged;
    // keep the existing order (language, quality, site preference) and only move failing ones behind the rest
    return use.sort((a, b) => (a.st === 'failing') - (b.st === 'failing') || a.i - b.i).map(t => t.s);
}

function summary() {
    const now = Date.now();
    const vals = [...sources.entries()];
    return {
        tracked: vals.length,
        hiddenNow: vals.filter(([, r]) => r.hiddenUntil > now).map(([k, r]) => `${k} (until ${new Date(r.hiddenUntil).toISOString().slice(11, 16)})`).slice(0, 40),
        failingNow: vals.filter(([, r]) => r.hiddenUntil <= now && r.fail > 0 && r.lastFail > r.lastOk).length,
        working: vals.filter(([, r]) => r.lastOk && !r.fail).length,
        totals: stats,
    };
}

module.exports = { ok, fail, rateLimited, state, apply, summary, save, _reset: () => sources.clear() };
