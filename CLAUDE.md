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

**Do not run `node build.js` locally and commit the result** — the markers in `index.html` are the source of truth; the injected content is generated fresh each deploy.

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
js/youtube.js       — YouTube API fetch + localStorage cache (1hr TTL)
js/videos.js        — videos page logic (category/course/player filters + URL params)
data/videos.js      — YouTube API key + channel ID config
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
| `BATTLE_STATS_SHEET = 'Racers by Course'` | Sheet name | Battle W/L by course per player |
| `HEAD_TO_HEAD_SHEET = 'Head_to_Head'` | Sheet name | Battle W/L per opponent per player |
| `BATTLE_LEADERBOARD_SHEET = 'Battle Records by Racer'` | Sheet name | ELO rankings (rows 1–3 are titles; fetched with `range='A4:I'`) |

**Important:** Use sheet names (not GIDs) for the battle sheets — GIDs break whenever the spreadsheet is reorganised. `fetchSheetData()` accepts either; all-digit strings are treated as GIDs, anything else as a sheet name.

### Sheet data structure
Sheets use a grouped format with three row types:
1. **Player header rows** — first cell has player name, rest are null (or a merged title string)
2. **Subheader rows** — column labels like "Course", "Opponent", "Wins" — skipped by `SUBHEADER_LABELS` regex
3. **Data rows** — actual records

The gviz parser trims long merged-cell labels to their last word. Column header rows are skipped with:
```js
const SUBHEADER_LABELS = /^(course|opponent|player|racer|name)$/i;
```

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
- **`allRecords` race condition** — `_leaderboardPromise` is stored and awaited alongside `loadDetailSheets()` in `openRacerDetail()` so TA records are always ready before rendering
- **Video/record race condition** — `filterAndRender()` is called again inside `initVideos()` after `homeVideos` is populated, guarded by `if (activeTrack)`
- **Battle leaderboard** previously used a two-column Helper_* layout; now reads from 'Battle Records by Racer' which is a clean single-column layout maintained by Google Apps Script
- **Short player name false positives** — `matchesPlayerTerm()` in `main.js` uses lookaround assertions for pure alphanumeric names so e.g. `HT` doesn't match "night", "right", "eight". Same logic is inlined in the generated racer page scripts in `build.js`

## Roster exceptions (do not add these to RACERS)
- **MJ** — appears in battle standings (rank ~3) and all battle sheets, but intentionally excluded from `RACERS`. No profile photo. She's a girlfriend of one of the players.
- **KAY** — same situation (0W 2L in standings). No profile photo.
- Both will show in the ELO table without a clickable profile link until photos are available. Use `/add-player` when ready.

## Card name aliases
- **DAWN** is DUSK's alternate card name. All DAWN rows in the TA sheet have `Identity = DUSK`, so they are correctly attributed to DUSK. No fix needed.
- **H-T** is HT's old card tag. Some TA rows may still show H-T as `Player Tag` — these are correctly matched to HT via `normalizeName()`.

## TA-only players (no battle history)
JINRO, SHI, and :v have time attack records but do not appear in any battle sheet. This is expected — they've recorded times but haven't played ranked battles.

## Static page generation (build.js)

### Racer pages — `generateRacerPage(racer, taByCar, battle, h2h, standing)`
Located at `/racers/[slug].html`. Contains:
- Hero with avatar, ELO, rank, overall record
- TIME ATTACK RECORDS table (grouped by car, sorted by course order, course names link to course pages)
- BATTLE RECORDS section — H2H table + by-course table in two-column layout
- VIDEOS section — client-side feed via `../data/videos.js` + `../js/youtube.js`, up to 12 videos, hidden if none found
- ProfilePage + BreadcrumbList JSON-LD
- `playerSlug(name)` / `slug(name)` — strip non-alphanumeric, lowercase (mirrors `main.js`)

### Course pages — `generateCoursePage(courseName, taRecords, battleLog, battleStats)`
Located at `/courses/[slug].html`. Contains:
- Hero with course map image (faded background)
- TIME ATTACK RECORDS — grouped by direction → condition, ranked leaderboard per group, player names link to racer pages
- BATTLE STANDINGS — aggregated W/L table from `parseBattleStats()`, sorted by wins then win%
- VIDEOS section — client-side feed filtered by course name, up to 12 videos
- WebPage + BreadcrumbList JSON-LD

### Courses index — `generateCoursesIndex(taRecords, battleLog)`
Located at `/courses.html`. Grid of 8 course cards with map image, TA record count, battle count, course record holder. CollectionPage + BreadcrumbList JSON-LD.

### Key constants in build.js
```js
const COURSE_ORDER  = ['Myogi','Usui','Akagi','Akina','Irohazaka','Akina Snow','Happogahara','Shomaru','Tsuchisaka'];
const COURSE_IMAGES = { /* course name → Courses/ image path */ };
const DIR_ORDER     = ['Downhill','Uphill','Counter-Clockwise','Counter Clockwise','Clockwise','Outbound','Inbound'];
const COND_ORDER    = ['Dry','Wet'];
const BATTLE_LOG_GID = '1322076132';
```
`COURSE_ORDER` must be kept in sync with `main.js`.

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
