// Stricter film matching for the AniWorld plugin (appended to its code; this findMovie replaces the plugin's own).
//
// The plugin's version took a film when the AniWorld entry merely contained the searched words. TMDB's titles can
// shrink to almost nothing after cleaning: "爆転シュート ベイブレード THE MOVIE 激闘!!" keeps only "the movie", and
// a subtitle like "Fierce Battle" is an episode title in dozens of shows. So "Beyblade: The Movie - Fierce Battle"
// was matched to a Prince of Tennis special.
//
// Now an AniWorld film ("<title> [Movie]: <Series> Staffel 0 Episode N") counts only if, for one of the film's titles,
//   - its series is the same franchise (a distinctive word of the title appears in the series name), and
//   - at least half of the title's other distinctive words appear in the film's own title on AniWorld
//     (a title with nothing beyond the franchise name, like "Beyblade: The Movie", can't tell films apart: no match)
// Generic words (the, movie, film, der, ...) never count, and titles in other scripts are not used for searching.
'use strict';

const PATCH = `
var __AW_STOP = new Set("the a an and of to in on at for der die das den dem des ein eine und von zu im am mit movie movies film filme the_movie ova oad special specials teil part chapter kapitel version gekijouban gekijoban theatrical edition".split(" "));
function __awWords(s) { return norm(s).split(" ").filter(function (w) { return w.length >= 3 && !__AW_STOP.has(w) && !/^\\d+$/.test(w); }); }
function __awLatin(s) { var t = String(s || "").replace(/\\s+/g, ""); if (!t) return false; var l = (t.match(/[A-Za-z0-9\\u00C0-\\u024F]/g) || []).length; return l / t.length >= 0.6; }
function __awFilmMatches(item, meta) {
  var parts = String(item.title || "").split("]:");
  if (parts.length < 2) return false;
  var filmTitle = norm(parts[0].replace(/\\[[^\\]]*$/, ""));
  var series = norm(parts.slice(1).join(" ").replace(/\\bStaffel\\s+\\d+.*$/i, ""));
  var slug = norm(((item.link || "").match(/\\/anime\\/stream\\/([^/]+)/) || [])[1] || "");
  var filmWords = " " + filmTitle + " ", seriesWords = " " + series + " " + slug + " ";
  return meta.titles.filter(__awLatin).some(function (t) {
    var w = __awWords(t);
    // same franchise: a distinctive word of the title is in the series name
    var franchise = w.filter(function (x) { return seriesWords.indexOf(" " + x + " ") >= 0; });
    if (!franchise.length) return false;
    // this particular film: at least half of the remaining distinctive words are in the film's own title
    var own = w.filter(function (x) { return franchise.indexOf(x) < 0; });
    if (!own.length) return false;
    var hits = own.filter(function (x) { return filmWords.indexOf(" " + x + " ") >= 0; }).length;
    return hits >= Math.ceil(own.length / 2);
  });
}
function findMovie(meta) {
  return __async(this, null, function* () {
    var titles = meta.titles.filter(__awLatin);
    var queries = [].concat.apply([], titles.map(function (t) { return [t, t.split(/\\s[-\\u2013:]\\s|:\\s/).pop(), t.split(/\\s[-\\u2013:]\\s|:\\s/)[0]]; }))
      .filter(function (q, i, a) { return q && __awWords(q).length && a.indexOf(q) === i; });
    for (var qi = 0; qi < queries.length; qi++) {
      var items = yield search(queries[qi]);
      var series = yield pickSeries(items.filter(function (i) { return /^\\/anime\\/stream\\/[^/]+$/.test(i.link); }), meta, BASE);
      if (series) return series.link + "/staffel-1/episode-1";
      var film = items.find(function (i) { return /\\/staffel-0\\/episode-\\d+$/.test(i.link) && __awFilmMatches(i, meta); });
      if (film) return film.link;
    }
    return null;
  });
}
`;
module.exports = { PATCH };
