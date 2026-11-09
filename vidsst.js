// vids.st: Moflix lists it for many films. The player page names the file directly
//   const url = "https:\/\/cdn.vids.st\/video189395\/Oppenheimer.2023.51.1080p.BluRay.mp4";
// (an MP4, sometimes an HLS playlist: "const isHls = true"). Checked 9 Nov 2026: Oppenheimer from Moflix is a
// 1080p MP4 with a German ("deu") and an English audio track, German first; seeking works.
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fromPage(html) {
    const m = html.match(/const\s+url\s*=\s*"((?:[^"\\]|\\.)+)"/);
    if (!m) return null;
    let src;
    try { src = JSON.parse(`"${m[1]}"`); } catch (e) { src = m[1].replace(/\\\//g, '/'); }
    if (!/^https?:\/\//.test(src)) return null;
    const hls = /const\s+isHls\s*=\s*true/.test(html) || /\.m3u8(\?|$)/.test(src);
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const q = /2160|4k/i.test(title) ? '2160p' : /1080/.test(title) ? '1080p' : /720/.test(title) ? '720p' : 'auto';
    return { url: src, hls, quality: q, title };
}

async function extract(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://moflix-stream.xyz/' } });
    if (r.status === 404) throw new Error(`HTTP 404 ${url}`);
    const f = fromPage(await r.text());
    if (!f) return [];
    return [{ url: f.url, quality: f.quality, headers: { Referer: new URL(url).origin + '/', 'User-Agent': UA } }];
}

const forPlugins = url => extract(url);
module.exports = { extract, forPlugins, fromPage };
