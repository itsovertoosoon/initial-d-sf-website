# Initial D San Francisco — Project Context

## What this is
A static website for a group of Initial D Arcade Stage Version 3 players in the SF Bay Area.
Live at: https://initialdsanfrancisco.com
Hosted on: Netlify (static, no build step — deploy the folder directly)

## Build step
Netlify runs `node build.js` before serving. The script fetches Google Sheets + YouTube data and:
- Injects JSON-LD structured data into `<!-- PRERENDER:JSONLD -->` markers in `index.html` and `videos.html`
- Injects a `<noscript>` crawlable table into `<!-- PRERENDER:NOSCRIPT -->` markers
- Generates `/racers/[slug].html` — one static profile page per player
- Generates `/courses/[slug].html` — one static page per course
- Generates `/courses.html` — course directory index
- Regenerates `sitemap.xml` with all pages
- Writes `data/snapshot.json` — a same-origin mirror of the sheets (see below)

**Do not run `node build.js` locally and commit the result** — the markers in `index.html` are the source of truth; the injected content is generated fresh each deploy.

## Offline / blocked-network fallback

Every stat is fetched client-side from `docs.google.com`. Corporate networks
routinely block Google Workspace domains as a data-exfiltration control, which
used to leave the whole site rendering no numbers at all — after a silent 10s
spinner, followed by error copy that wrongly blamed the sheet's sharing settings.

`build.js` therefore mirrors all three sheets into **`data/snapshot.json`**
(`{ generated, sheets: { [gid]: rows } }`), served from our own origin where no
proxy sits in the way. `getSheetRows()` in `js/main.js` races the live JSONP
fetch against the snapshot:

- Whichever answers first paints. The snapshot usually wins (same origin, no
  round trip to Google), so stats now appear immediately rather than after a
  round trip — this is a speed win for *every* visitor, not just blocked ones.
- Live data always wins in the end: when it lands after the snapshot, the
  `onUpgrade` callback re-renders. `applyRecords()` skips the re-render when the
  rows are identical, so the common case does not flicker or reset filters.
- While any section is showing snapshot data, a `.data-source-notice` banner
  appears under the hero stats naming the snapshot date.
- If both fail, the UI says the network may be blocking `docs.google.com` and
  fires a `data_load_failure` GA event.

**Gotchas**
- `fetchSheetData()` resolves `{ ok, rows, reason }` and **never rejects**. `ok:false`
  (request did not complete) is deliberately distinct from `ok:true` with zero rows
  (sheet really is empty). Never conflate them — doing so is what made the racer
  modal claim "No time attack records on file" during an outage, which reads as
  fact rather than failure.
- A filtering proxy that returns a block page fires the script's `load` event, not
  `error`, so `SHEET_TIMEOUT_MS` is the only thing that ends that case.
- `writeSnapshot()` keeps the previous rows for any sheet whose build-time fetch
  failed or came back empty, so one bad deploy cannot ship an empty fallback.
  Keep `data/snapshot.json` committed — Netlify builds from a fresh clone, so the
  committed copy is the floor that guard falls back to.
- `SNAPSHOT_SHEETS` must stay aligned with the first N entries of the
  `Promise.allSettled` array in `main()`; `writeSnapshot` pairs them by index.

## Tech stack
- Plain HTML / CSS / JS — no framework, no bundler
- **Data backend:** Google Sheets, fetched client-side via the gviz/tq JSONP API (no server needed)
- **Videos:** YouTube Data API v3, results cached in localStorage with a 1-hour TTL
- **Analytics:** Google Analytics 4 via gtag

## File structure
```
index.html          — main page (leaderboard + racer profiles)
videos.html         — videos archive page (filterable by category/course/player)
courses.html        — course directory index (BUILD-GENERATED)
css/style.css       — all styles; CSS custom properties in :root
js/main.js          — leaderboard, racer grid, racer detail panel logic
js/battle-engine.js — shared (browser + build.js): publish gate + all battle stat derivation
js/youtube.js       — YouTube API fetch + localStorage cache (1hr TTL)
js/videos.js        — videos page logic (category/course/player filters + URL params)
data/videos.js      — YouTube API key + channel ID config
data/snapshot.json  — BUILD-GENERATED; same-origin mirror of the sheets, used as fallback
racers/             — BUILD-GENERATED static racer profile pages
courses/            — BUILD-GENERATED static course pages
Headshots/          — player headshot images (JPG/PNG)
Courses/            — course map images (webp/gif)
build.js            — Netlify build script (generates all static pages + sitemap)
_headers            — Netlify security headers
_redirects          — Netlify www → apex redirect
404.html            — custom 404 page
robots.txt
sitemap.xml         — BUILD-GENERATED; placeholder in repo, overwritten at deploy
.claude/commands/   — slash command skills
```

## Google Sheets setup

**Sheet ID:** `1MaofC1e4XlJ3XtKAokq34Q3q5vTziuz8NNPS7tHZD3E`

| Constant | Reference | Contents |
|---|---|---|
| `LEADERBOARD_GID = '0'` | GID (stable, it's the first sheet) | Time attack records |
| `ELO_CALC_GID = '20260409'` | GID | **The only battle source the site reads.** One row per match with the full Elo audit trail (`Elo_A_before/after`, `Expected_*`, `Session_*`) written by Apps Script |
| `BATTLE_LOG_GID = '1322076132'` | GID | Raw battle log — still read by `js/videos.js` only, to classify a video as a battle |

**Important:** Use sheet names (not GIDs) where a sheet may be reorganised — GIDs break when tabs are recreated. `fetchSheetData()` accepts either; all-digit strings are treated as GIDs, anything else as a sheet name.

### Sheets the site deliberately does NOT read
`Battle Records by Racer`, `Racers by Course` and `Head_to_Head` are Apps Script aggregates over **every** logged row, including matches whose videos are still scheduled — so they spoil pending uploads (see the publish gate below). They're still maintained in the spreadsheet for the owner's own use; nothing on the site consumes them. Don't wire them back in.

### Sheet data structure
The TA sheet uses a grouped format with three row types:
1. **Player header rows** — first cell has player name, rest are null (or a merged title string)
2. **Subheader rows** — column labels like "Course", "Opponent", "Wins" — skipped by `SUBHEADER_LABELS` regex
3. **Data rows** — actual records

The gviz parser trims long merged-cell labels to their last word. Column header rows are skipped with:
```js
const SUBHEADER_LABELS = /^(course|opponent|player|racer|name)$/i;
```

The Elo calc tab is a flat one-row-per-match table — no grouping, no subheaders.

## The publish gate (`js/battle-engine.js`)

Battle videos go out on a schedule, so the battle log always contains rows dated in the **future**: matches already played and logged, whose video isn't public yet. Column `Date` is the video's **publish** date; column `Recorded Date` is when it was actually played.

Every battle number on the site — ELO, rank, W/L, matches, win%, streak, last active, by-course, head-to-head, course battle counts — is derived from the Elo calc tab **filtered to matches whose video is live**. A match counts when either:

1. its video ID is in the channel's upload list (exact, and true the moment a scheduled video publishes), **or**
2. it is dated **strictly before today** — covers legacy rows that hold a pasted title instead of a URL, and keeps the gate working if the YouTube fetch fails.

Rule 2 is deliberately `< today`, not `<= today`: without the video list, a row scheduled for later today stays hidden rather than publishing its result hours early. Trade-off is a lag until midnight in that fallback case only.

**ELO is never recomputed here.** The calc tab holds a running Elo chain in publish order, so a player's current rating is just `Elo_A_after`/`Elo_B_after` from their most recent published row. The Google engine remains the single source of truth for the rating math (K-factor, etc.).

Consequences:
- The board advances on its own as videos go live — **no Apps Script run and no deploy needed.**
- A player whose only battles are unpublished doesn't appear on the board yet.
- **Row order in the calc tab IS the Elo chain order**, so rows are never re-sorted. `checkChainOrder()` warns (build log + browser console) if the tab stops being date-ascending, which would make the publish cut non-contiguous. If you ever backdate an inserted match, re-sort the calc tab.
- Racer pages carry a build-time snapshot in their static HTML (good for SEO, never spoils) **and** re-derive client-side on load, so they stay current between deploys. Course pages are build-time only — gated, so never spoiling, but their battle standings can lag until the next deploy.

**Still open (spreadsheet side):** `Battle Records by Racer` itself remains unfiltered, so opening the sheet still reveals pending results. Fixing that means adding a `Date <= TODAY` filter in the Apps Script.

## Player list
Defined in the `RACERS` array in `js/main.js`. Keep it alphabetical — letters A–Z first, then symbols.
- `img: 'Headshots/FILENAME.EXT'` if headshot exists
- `img: null` for initials-placeholder fallback

Current players: BAKA, CHON!, DUSK, GONZO, HT, JINRO, JJ, NEFFR, NEMUI, RYUKI, SHI, SLK, VIRUS, WHAT?, (.Y.), :v

Use `/add-player` skill when adding a new racer.

## Car naming conventions (video titles)

| Car | Code used in video titles |
|---|---|
| Toyota Trueno AE86 | `ae86` |
| Toyota Levin AE86 | `86L` |
| Toyota AE85 | `ae85` |
| Everything else | extracted from parentheses in car name |

`carCode()` in main.js handles this. `CAR_TITLE_MAP` checks for `ae85` before `levin` to avoid false matches.

## Video title format
Two formats exist (changed partway through the channel):
- **New:** `Initial D v3 - PLAYERNAME CAR COURSE DIR COND TIME`
  - e.g. `Initial D v3 - :v ae86 Akina DH Dry 2'58"692`
- **Old:** `Initial D v3 - WHAT? AE86 Akina DH Dry 2'58"692`

`normalizeQuotes()` handles Unicode apostrophe/quote variants in time strings.

`DIR_TO_ABBR` maps full direction names to abbreviations used in titles:
- Counter-Clockwise / Counter Clockwise → CCW
- Clockwise → CW, Downhill → DH, Uphill → UH, Outbound → OB, Inbound → IB

## Google Analytics events
Three custom events tracked:
- `leaderboard_course_select` — params: `course`
- `racer_profile_view` — params: `racer`
- `outbound_click` — params: `link_url`, `link_domain`, `link_text`

Use the `trackEvent(name, params)` helper (safe no-op if gtag not loaded).

## Known quirks / gotchas
- **HT's tag in the sheet is `H-T`** — `normalizeName()` strips non-alphanumerics so `HT` matches `H-T`
- **YouTube API key is HTTP-referrer-restricted** to the site's domain. Build-time (server-side) fetches in `build.js` must send `Referer: https://initialdsanfrancisco.com/` or Google returns 403 and the videos.html JSON-LD/noscript content silently comes out empty (`fetchYouTubeVideos` handles this via `YT_FETCH_OPTS`).
- **Sheet data uses `Reverse` (Irohazaka) and `Snow` (Akina Snow)** as direction/condition values. idrankings files those runs under `UH` and `Dry` respectively — `DIR_TO_ABBR` maps Reverse→UH, and `getWorldRecord()` falls back to Dry, so the WR strip works on both tabs.
- **Guest players in the TA sheet** (CAL, DROOL, NARF, JDV, WIND, RICE, PJSV, `:)`) have no racer pages. Anything that links a player name to `/racers/…` must first check the name against the RACERS roster (normalized), or you generate 404 links.
- **`allRecords` race condition** — `_leaderboardPromise` is stored and awaited alongside `loadDetailSheets()` in `openRacerDetail()` so TA records are always ready before rendering
- **Video/record race condition** — `filterAndRender()` is called again inside `initVideos()` after `homeVideos` is populated, guarded by `if (activeTrack)`
- **Battle leaderboard** used to read the Apps Script standings sheet (and before that a two-column `Helper_*` layout). It now derives everything from the Elo calc tab through `js/battle-engine.js` with fixed columns — no dynamic column discovery, no `Helper_*` merging.
- **Short player name false positives** — `matchesPlayerTerm()` in `main.js` uses lookaround assertions for pure alphanumeric names so e.g. `HT` doesn't match "night", "right", "eight". Same logic is inlined in the generated racer page scripts in `build.js`

## Roster exceptions (do not add these to RACERS)
- **MJ** — appears in battle standings (rank ~3) and all battle sheets, but intentionally excluded from `RACERS`. No profile photo. She's a girlfriend of one of the players.
- **KAY** — same situation (0W 2L in standings). No profile photo.
- Both will show in the ELO table without a clickable profile link until photos are available. Use `/add-player` when ready.

## Card name aliases
- **DAWN** is DUSK's alternate card name. All DAWN rows in the TA sheet have `Identity = DUSK`, so they are correctly attributed to DUSK. No fix needed.
- **H-T** is HT's old card tag. Some TA rows may still show H-T as `Player Tag` — these are correctly matched to HT via `normalizeName()`.
- **:V** — the battle sheets store :v in caps. Player-name comparisons against sheet data must use `normalizeName()` / `BattleEngine.normName()`, never exact string match (this broke the standings profile link once).

## TA-only players (no battle history)
JINRO and SHI have time attack records but do not appear in any battle sheet. This is expected — they've recorded times but haven't played ranked battles.

## Static page generation (build.js)

All battle inputs below are the **publish-gated** derivations from `BattleEngine` — see "The publish gate" above.

### Racer pages — `generateRacerPage(racer, taByCar, battle, h2h, standing)`
Located at `/racers/[slug].html`. Contains:
- Hero with avatar, ELO, rank, overall record (`standing` is a `deriveStandings()` row: `{rank, elo, wins, losses, matches, winPct, streak, lastActive}`)
- TIME ATTACK RECORDS table (grouped by car, sorted by course order, course names link to course pages)
- BATTLE RECORDS section — H2H table + by-course table in two-column layout
- VIDEOS section — client-side feed via `../data/videos.js` + `../js/youtube.js`, up to 12 videos, hidden if none found
- **Client-side battle refresh** — also loads `../js/battle-engine.js`, re-fetches the Elo calc tab via JSONP on load, and repaints `#rp-meta` + `#rp-battle-body` so the page stays current between deploys. The static markup is the build-time snapshot and stands if the fetch fails.
- ProfilePage + BreadcrumbList JSON-LD
- `playerSlug(name)` / `slug(name)` — strip non-alphanumeric, lowercase (mirrors `main.js`)

### Course pages — `generateCoursePage(courseName, taRecords, matches, racers)`
Located at `/courses/[slug].html`. Contains:
- Hero with course map image (faded background)
- TIME ATTACK RECORDS — grouped by direction → condition, ranked leaderboard per group, player names link to racer pages
- BATTLE STANDINGS — from `BattleEngine.deriveCourseStandings(matches, courseName)`, already sorted by wins then win%
- VIDEOS section — client-side feed filtered by course name, up to 12 videos
- WebPage + BreadcrumbList JSON-LD

### Courses index — `generateCoursesIndex(taRecords, matches)`
Located at `/courses.html`. Grid of 8 course cards with map image, TA record count, battle count (published only), course record holder. CollectionPage + BreadcrumbList JSON-LD.

### Key constants in build.js
```js
const COURSE_ORDER  = ['Myogi','Usui','Akagi','Akina','Irohazaka','Akina Snow','Happogahara','Shomaru','Tsuchisaka'];
const COURSE_IMAGES = { /* course name → Courses/ image path */ };
const DIR_ORDER     = ['Downhill','Uphill','Counter-Clockwise','Counter Clockwise','Clockwise','Outbound','Inbound'];
const COND_ORDER    = ['Dry','Wet'];
const ELO_CALC_GID  = BattleEngine.ELO_CALC_GID;   // '20260409'
```
`COURSE_ORDER` must be kept in sync with `main.js`.

The build log prints `Battles: N published, M awaiting upload (excluded)` — if M is 0 when you know videos are scheduled, the gate isn't seeing the future rows and something changed in the sheet.

## Videos page (js/videos.js)
- `?player=NAME` and `?course=NAME` URL params pre-filter the grid on load
- Player param must be injected into `allPlayers` BEFORE `enrichVideo()` runs so TA video titles get tagged
- Course filter is shown on ALL category tabs (not just attack/battle)
- Categories: ALL / TIME ATTACK / BATTLE / LEGEND OF THE STREET
- `enrichVideo()` detects category by: battle log match → LOTS keyword → lap time regex → other

## SEO setup
- `index.html` — SportsOrganization + WebSite JSON-LD (injected by build.js)
- `videos.html` — CollectionPage + VideoObject list JSON-LD (injected by build.js)
- `courses.html` — CollectionPage + BreadcrumbList JSON-LD (generated by build.js)
- `/courses/[slug].html` — WebPage + BreadcrumbList JSON-LD
- `/racers/[slug].html` — ProfilePage + BreadcrumbList JSON-LD
- All pages have canonical URLs, Open Graph tags, and meta descriptions
- `robots.txt` references `https://initialdsanfrancisco.com/sitemap.xml`
- `sitemap.xml` is regenerated at each build (includes all racer + course pages)
- **Favicon** must be square — Google rejects non-square images. Current favicon is a square PNG from favicon.io.

## Navigation order (all pages)
HOME · VIDEOS · RECORDS · COURSES · BATTLES · RACERS · ABOUT · YOUTUBE ↗

## Available slash commands
- `/add-player [name]` — add a new racer to the site
- `/check-sheets` — verify all four Google Sheet endpoints are reachable and returning expected columns
- `/audit-videos` — (not yet built) check TA record → video match rate by player
- `/qa` — cross-reference RACERS array against all four sheets; catches players missing from the roster or leaderboards
