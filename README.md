# German Providers Addon

The [German Providers](https://github.com/InvalidPandaa/nuvio-german-providers) Nuvio plugins by InvalidPandaa, wrapped as a normal addon (Nuvio, Stremio, AIOStreams).

Unlike the plugin version, every stream carries a **binge group**. Pick a German stream once and Nuvio's "Prefer Binge Group" keeps the next episode on German instead of falling back to another addon.

Other extras:
- **Next-episode prefetch:** while you watch episode 5, the addon already looks up episode 6, so autoplay gets an instant answer.
- **Auto-update:** every 12 hours it downloads the newest provider files from InvalidPandaa's repo, so his fixes arrive on their own.
- **Diagnostics page** that shows which sites work from the server.

---

## Setup (about 15 minutes)

### 1. Get a free TMDB API key
themoviedb.org → create an account → Settings → API → request a key (Developer, personal use) → copy the **API Key** (the short one, not the long "Read Access Token").

### 2. Put the code on GitHub
1. github.com → **New repository** → name it `german-providers-addon` → Private is fine → Create.
2. On the empty repo page click **uploading an existing file**.
3. Drag in **everything inside this folder** (server.js, package.json, Dockerfile, the `providers` folder, etc.) → Commit.

### 3. Deploy on Koyeb (free, Frankfurt)
1. koyeb.com → sign up with GitHub.
2. **Create Web Service** → GitHub → pick `german-providers-addon`.
3. Builder: **Dockerfile**.
4. Instance: **Free**. Region: **Frankfurt**.
5. Environment variables → add `TMDB_API_KEY` = your key.
6. Exposed port: **8000**. Health check path: `/health`.
7. **Deploy**, and wait until it says *Healthy*. Your address looks like `https://something-yourname.koyeb.app`.

The free instance sleeps after 1 hour without use and takes a few seconds to wake. That's fine; Render took ~50 s.

### 4. Check which sites work from the server
Open these in a browser (replace the address):

- `https://YOUR-APP.koyeb.app/check/series/tt0944947:1:1` (a series: Serienstream, KinoKing …)
- `https://YOUR-APP.koyeb.app/check/series/tt0388629:1:1` (an anime: Aniworld)
- `https://YOUR-APP.koyeb.app/check/movie/tt0133093` (a film: FilmPalast, Megakino, HDFilme …)

Each provider shows `streams: N` (working) or `error` / `0` (blocked or not found). If the important ones work, you're done. If the sites block the server, see *Run it at home* below.

### 5. Add it to Nuvio
Nuvio → Settings → Addons → add `https://YOUR-APP.koyeb.app/manifest.json`

Keep **Prefer Binge Group (Next Episode)** turned on. Start a series by picking a stream marked 🇩🇪 *DE Providers*, and the following episodes stay on it.

(Optional) In AIOStreams it can be added as a custom addon with the same URL. The binge group only works if AIOStreams passes it through, so adding it straight to Nuvio is the safer choice.

Once the addon works, you can switch off the German plugin in Nuvio's plugin settings so streams don't show up twice.

---

## Settings (environment variables, all optional except the key)

| Variable | Default | What it does |
|---|---|---|
| `TMDB_API_KEY` | – | **Required.** |
| `PROVIDERS` | all | Only use these, e.g. `serienstream,aniworld,filmpalast,megakino` |
| `SKIP_PROVIDERS` | none | Leave these out, e.g. `southpark,tlc` |
| `TIMEOUT_MS` | 15000 | Longest wait before answering; late results are kept for the next request |
| `CACHE_MINUTES` | 10 | How long results are reused |
| `PREFETCH` | on | `0` turns off next-episode prefetch |
| `PREFETCH_MINUTES` | 40 | How long a prefetched episode is kept |
| `AUTO_UPDATE` | on | `0` sticks to the bundled provider files |

---

## Run it at home instead (if the sites block Koyeb)

The same code runs on any always-on device at home, for example an old Android phone with **Termux**:

```
pkg install nodejs git cloudflared
git clone https://github.com/YOURNAME/german-providers-addon && cd german-providers-addon
npm install
TMDB_API_KEY=yourkey PORT=8000 node server.js
# second Termux session, gives you a free https address:
cloudflared tunnel --url http://localhost:8000
```

Use the `https://….trycloudflare.com/manifest.json` address it prints. A quick tunnel's address changes when it restarts; a named Cloudflare tunnel keeps a fixed one.

---

## Credits & licence
Site logic and decoders: [InvalidPandaa/nuvio-german-providers](https://github.com/InvalidPandaa/nuvio-german-providers), based on [Bnyro/GermanProviders](https://github.com/Bnyro/GermanProviders) and [recloudstream/cloudstream](https://github.com/recloudstream/cloudstream). All GPL-3.0, and so is this addon (see LICENSE). Bundled plugin version: see `providers/SOURCE_COMMIT`.
