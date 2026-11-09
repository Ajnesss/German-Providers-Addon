// AniWorld / SerienStream: which of the site's episodes is IMDb's season S, episode E?
//
// The server sends these sites "season 1, episode <position in the whole series>". When season 1 on the site is
// shorter, the plugin walks on through the site's seasons (splitSeasonPath). That is right when the site splits the
// series differently from IMDb (One Piece, Naruto, Demon Slayer), but wrong by one or two when IMDb lists a stray
// extra episode in an earlier season while splitting its seasons exactly like the site.
// Found 9 Nov 2026: Yu-Gi-Oh! (tt0249327) has 49 episodes in IMDb's season 2, AniWorld 48; IMDb S4E10
// "My Freaky Valentine (3/3)" is position 155 by IMDb's count, but AniWorld's S4E10 (episode 154) is that episode.
//
// So while walking, the site's own season counts are compared with IMDb's (the hint the server passes along):
//   - the site has season S with at least E episodes, and its seasons before S hold about as many episodes as IMDb's
//     (at most 3 apart): the seasons line up -> the site's own season S, episode E
//   - otherwise the seasons don't line up -> the position in the whole series, as before
// Without a hint (not an anime request with IMDb numbering) the plugin's own walk runs unchanged.
'use strict';

const PATCH = `
;(function () {
  var __gpaOrigSplit = splitSeasonPath;
  splitSeasonPath = function (base, link, season, episode) {
    var store = globalThis.__gpaNumbering, hint = store && store.getStore();
    if (!hint || season !== 1 || !hint.imdbCounts) return __gpaOrigSplit(base, link, season, episode);
    return __async(this, null, function* () {
      var counts = [], siteBefore = 0, imdbBefore = 0;
      for (var s = 1; s <= 80; s++) {
        var html = yield getText(base + link + "/staffel-" + s).catch(function () { return ""; });
        var count = new Set(html.match(new RegExp(link + "/staffel-" + s + "/episode-\\\\d+", "g"))).size;
        if (!count) break;
        counts.push(count);
        if (s === hint.season && hint.season > 1) {
          for (var i = 0; i < s - 1; i++) imdbBefore += hint.imdbCounts[i] || 0;
          if (Math.abs(siteBefore - imdbBefore) <= 3 && hint.episode <= count) {
            if (siteBefore !== imdbBefore) console.error("[numbering] " + link + ": seasons line up with IMDb (" + siteBefore + " vs " + imdbBefore + " episodes before season " + s + "), using S" + s + "E" + hint.episode);
            return link + "/staffel-" + s + "/episode-" + hint.episode;
          }
        }
        siteBefore += count;
        // past the position: nothing further to learn
        if (siteBefore >= episode && s >= hint.season) break;
      }
      var rest = episode;
      for (var k = 0; k < counts.length; k++) {
        if (rest <= counts[k]) return k === 0 ? null : link + "/staffel-" + (k + 1) + "/episode-" + rest;
        rest -= counts[k];
      }
      return null;
    });
  };
  try { module.exports.__splitSeasonPath = splitSeasonPath; } catch (e) {}
})();
`;
module.exports = { PATCH };
