/* ============================================================
   INITIAL D SF — Main JavaScript
   ============================================================ */

/* ── CONFIG ──────────────────────────────────────────────────── */
const SHEET_ID               = '1MaofC1e4XlJ3XtKAokq34Q3q5vTziuz8NNPS7tHZD3E';
const LEADERBOARD_GID        = '0';          // Time Trial Records tab
const ELO_CALC_GID           = BattleEngine.ELO_CALC_GID; // per-match Elo chain — see js/battle-engine.js

// Every battle stat on the site (ELO, W/L, streak, last active, by-course, head
// to head) is derived from the Elo calc tab, filtered to matches whose video is
// already public. The Apps Script aggregate sheets ('Battle Records by Racer',
// 'Racers by Course', 'Head_to_Head') are no longer read: they count every
// logged row including scheduled uploads, which spoils them.

/* ── COURSE ORDER (canonical game sequence) ───────────────── */
const COURSE_ORDER = ['Myogi', 'Usui', 'Akagi', 'Akina', 'Irohazaka', 'Akina Snow', 'Happogahara', 'Shomaru', 'Tsuchisaka'];
function courseIndex(name) {
    const i = COURSE_ORDER.indexOf(name);
    return i === -1 ? 999 : i;
}

/* ── RACERS (hardcoded, alphabetical) ─────────────────────── */
const RACERS = [
    { name: 'BAKA',  img: 'Headshots/BAKA.JPG'  },
    { name: 'CHON!', img: null                   },
    { name: 'DUSK',  img: 'Headshots/DUSK.JPG'  },
    { name: 'GONZO', img: null                   },
    { name: 'HT',    img: 'Headshots/HT.JPG'    },
    { name: 'JINRO', img: 'Headshots/JINRO.JPG' },
    { name: 'JJ',    img: 'Headshots/jj.png'      },
    { name: 'NEFFR', img: 'Headshots/NEFFR.JPG' },
    { name: 'NEMUI', img: 'Headshots/NEMUI.JPG' },
    { name: 'RYUKI', img: 'Headshots/RYUKI.JPG' },
    { name: 'SHI',   img: 'Headshots/SHI.JPG'   },
    { name: 'SLK',   img: 'Headshots/SLK.JPG'   },
    { name: 'VIRUS', img: 'Headshots/VIRUS.JPG' },
    { name: 'WHAT?', img: 'Headshots/WHAT.JPG'  },
    { name: '(.Y.)', img: 'Headshots/Y.JPG'     },
    { name: ':v',    img: 'Headshots/v.JPG'     },
];

/* ── ANALYTICS ────────────────────────────────────────────── */

// Safe wrapper — no-ops gracefully if gtag hasn't loaded yet
function trackEvent(name, params = {}) {
    if (typeof gtag === 'function') gtag('event', name, params);
}

/* ── UTILITIES ────────────────────────────────────────────── */

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
}

// Normalize a name to uppercase letters+digits only for fuzzy matching
function normalizeName(s) {
    return String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Generate a URL-safe slug for a player name (matches build.js slug())
function playerSlug(name) {
    return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'player';
}

// Find a player's data in a parsed cache by name (exact or fuzzy)
function findInCache(cache, playerName) {
    if (!cache) return null;
    if (cache[playerName] !== undefined) return cache[playerName];
    const norm = normalizeName(playerName);
    const key  = Object.keys(cache).find(k => normalizeName(k) === norm);
    return key !== undefined ? cache[key] : null;
}

// Format a win-percentage value (may be a raw decimal or a formatted string)
function fmtPct(val) {
    if (val == null) return '—';
    if (typeof val === 'number') return (val * 100).toFixed(1) + '%';
    return String(val);
}

function groupBy(arr, key) {
    return arr.reduce((acc, item) => {
        const k = item[key] || 'Unknown';
        (acc[k] = acc[k] || []).push(item);
        return acc;
    }, {});
}

/* ── GOOGLE SHEETS JSONP LOADER ───────────────────────────── */
// Accepts either a numeric GID (string/number) or a sheet name string.
// Optional range (e.g. 'A4:I') lets you skip title rows by starting at the real header row.
function fetchSheetData(sheetRef, range = '') {
    return new Promise((resolve) => {
        const cb = '_gviz_' + Math.random().toString(36).slice(2);
        // Distinguish GID (all digits) from sheet name
        const param = /^\d+$/.test(String(sheetRef))
            ? `gid=${sheetRef}`
            : `sheet=${encodeURIComponent(sheetRef)}`;
        const rangeParam = range ? `&range=${encodeURIComponent(range)}` : '';

        const cleanup = () => { delete window[cb]; document.getElementById(cb)?.remove(); };

        const timer = setTimeout(() => {
            cleanup();
            console.error('Sheet fetch timed out for ' + param);
            resolve([]);
        }, 10000);

        window[cb] = function(response) {
            clearTimeout(timer);
            cleanup();
            resolve(response?.table ? parseGvizTable(response.table) : []);
        };

        const script   = document.createElement('script');
        script.id      = cb;
        script.onerror = () => {
            clearTimeout(timer);
            cleanup();
            console.error('Sheet fetch failed for ' + param);
            resolve([]);
        };
        script.src = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
                     `?tqx=out:json;responseHandler:${cb}&${param}${rangeParam}`;
        document.head.appendChild(script);
    });
}

function parseGvizTable(table) {
    // Long merged-cell labels (e.g. sheet title spanning columns) → take last token
    const cols = table.cols.map(c => {
        const label = (c.label || '').trim();
        if (label.length > 25) return label.split(/\s+/).pop() || c.id;
        return label || c.id;
    });
    return table.rows
        .filter(row => row.c && row.c.some(cell => cell && cell.v != null))
        .map(row => {
            const obj = {};
            row.c.forEach((cell, i) => { obj[cols[i]] = cell ? cell.v : null; });
            return obj;
        });
}

/* ════════════════════════════════════════════════════════════
   LEADERBOARD
   ════════════════════════════════════════════════════════════ */
let allRecords         = [];
let _leaderboardPromise = null;   // stored so openRacerDetail can await it
let activeTrack = null;
let activeDir   = 'all';
let activeCond  = 'all';

async function initLeaderboard() {
    allRecords = await fetchSheetData(LEADERBOARD_GID);

    if (!allRecords.length) {
        document.getElementById('leaderboard').innerHTML =
            `<p style="color:var(--muted);font-family:var(--font-mono);padding:2rem 0">
                Could not load records. Make sure the Google Sheet is published to the web.
             </p>`;
        return;
    }

    updateHeroStats({ records: allRecords.length });

    const distinctRacers = new Set(
        allRecords
            .map(r => normalizeName(r['Identity'] || r['Player Tag'] || r['Tag_clean'] || ''))
            .filter(Boolean)
    ).size;
    updateHeroStats({ racers: distinctRacers });

    const tracks = [...new Set(allRecords.map(r => r['Map']).filter(Boolean))];
    buildTrackTabs(tracks);

    // Fire-and-forget: re-renders leaderboard footer when WR data arrives
    loadWorldRecords();

    document.getElementById('direction-tabs').addEventListener('click', e => {
        const btn = e.target.closest('.sub-tab');
        if (!btn) return;
        activeDir = btn.dataset.val;
        document.querySelectorAll('#direction-tabs .sub-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Auto-select first condition for the new direction
        activeCond = firstCondition(activeTrack, activeDir);
        buildConditionTabs(activeTrack, activeDir);
        filterAndRender();
    });

    document.getElementById('condition-tabs').addEventListener('click', e => {
        const btn = e.target.closest('.sub-tab');
        if (!btn) return;
        activeCond = btn.dataset.val;
        document.querySelectorAll('#condition-tabs .sub-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        filterAndRender();
    });

    showTrack(tracks[0]);
}

// Returns first direction found in data for a track
function firstDirection(track) {
    return allRecords.find(r => r['Map'] === track && r['Direction'])?.['Direction'] || null;
}

// Returns first condition found in data for a track + direction
function firstCondition(track, dir) {
    return allRecords.find(r =>
        r['Map'] === track && r['Direction'] === dir && r['Condition']
    )?.['Condition'] || null;
}

function buildTrackTabs(tracks) {
    const container = document.getElementById('track-tabs');
    container.innerHTML = tracks.map((track, i) =>
        `<button class="track-tab${i === 0 ? ' active' : ''}" data-track="${escHtml(track)}">
            ${escHtml(track.toUpperCase())}
         </button>`
    ).join('');

    container.addEventListener('click', e => {
        const tab = e.target.closest('.track-tab');
        if (!tab) return;
        container.querySelectorAll('.track-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        showTrack(tab.dataset.track);
    });
}

function showTrack(track) {
    activeTrack = track;
    // Default to first direction + first condition — no ALL option
    activeDir  = firstDirection(track);
    activeCond = firstCondition(track, activeDir);
    buildDirectionTabs(track);
    buildConditionTabs(track, activeDir);
    document.getElementById('secondary-filters').style.display = '';
    filterAndRender();
    trackEvent('leaderboard_course_select', { course: track });
}

// Build direction tabs — no ALL option, first is active by default
function buildDirectionTabs(track) {
    const dirs = [...new Set(
        allRecords.filter(r => r['Map'] === track).map(r => r['Direction']).filter(Boolean)
    )];
    document.getElementById('direction-tabs').innerHTML = dirs.map(d =>
        `<button class="sub-tab${d === activeDir ? ' active' : ''}" data-val="${d}">
            ${d.toUpperCase()}
         </button>`
    ).join('');
}

// Build condition tabs — no ALL option, first is active by default
function buildConditionTabs(track, dir) {
    const subset = allRecords.filter(r =>
        r['Map'] === track && r['Direction'] === dir
    );
    const conds = [...new Set(subset.map(r => r['Condition']).filter(Boolean))];
    document.getElementById('condition-tabs').innerHTML = conds.map(c =>
        `<button class="sub-tab${c === activeCond ? ' active' : ''}" data-val="${c}">
            ${c.toUpperCase()}
         </button>`
    ).join('');
}

function filterAndRender() {
    let records = allRecords.filter(r => r['Map'] === activeTrack);
    if (activeDir  !== 'all') records = records.filter(r => r['Direction'] === activeDir);
    if (activeCond !== 'all') records = records.filter(r => r['Condition'] === activeCond);

    // Sort fastest first
    records.sort((a, b) => timeToMs(a) - timeToMs(b));

    // Dedup: keep only the fastest time per player+car combo.
    // Falls back through Identity → Player Tag → Tag_clean so it works
    // even if the Identity column isn't fully populated yet.
    const seen = new Set();
    records = records.filter(r => {
        const player = r['Identity'] || r['Player Tag'] || r['Tag_clean'] || '';
        const car    = r['Car_clean'] || r['Car'] || '';
        const key    = `${player}|${car}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const lb = document.getElementById('leaderboard');
    if (!records.length) {
        lb.innerHTML = `<p style="color:var(--muted);font-family:var(--font-mono);padding:2rem 0">
            No records for this combination yet.</p>`;
        return;
    }

    const showCond = activeCond === 'all';
    const showDir  = activeDir  === 'all';

    // World record strip — shows WR time + gap from our P1 (if data loaded)
    const _dirAbbr = DIR_TO_ABBR[activeDir] || activeDir;
    const _wrMs    = getWorldRecord(activeTrack, _dirAbbr, activeCond || 'Dry');
    const _p1Ms    = records.length ? timeToMs(records[0]) : null;
    let _wrStripHtml = '';
    if (_wrMs && _p1Ms !== null) {
        const gapMs  = _p1Ms - _wrMs;
        const gapStr = gapMs >= 0
            ? `+${(gapMs / 1000).toFixed(3)}s behind WR`
            : `${Math.abs(gapMs / 1000).toFixed(3)}s ahead of WR`;
        _wrStripHtml = `
        <div class="wr-strip">
            <span class="wr-label">// WORLD RECORD</span>
            <span class="wr-time">${formatWrMs(_wrMs)}</span>
            <span class="wr-sep">·</span>
            <span class="wr-gap">OUR BEST IS ${gapStr}</span>
        </div>`;
    }

    lb.innerHTML = `
        <table class="leaderboard-table">
            <thead><tr>
                <th>RANK</th><th>PLAYER</th><th>CAR</th><th>TIME</th>
                ${showCond ? '<th class="lb-col-cond">COND</th>' : ''}
                ${showDir  ? '<th class="lb-col-dir">DIR</th>'   : ''}
            </tr></thead>
            <tbody>
                ${records.map((r, i) => {
                    // Identity = real racer (primary), Player Tag = card name (secondary)
                    const identity = r['Identity'] || r['Player Tag'] || r['Tag_clean'] || '—';
                    const cardTag  = r['Player Tag'] || r['Tag_clean'] || '';
                    const showTag  = cardTag && cardTag !== identity;
                    const playerCell = showTag
                        ? `<strong>${escHtml(identity)}</strong><br>
                           <span style="color:var(--muted);font-size:0.76em;font-family:var(--font-mono)">${escHtml(cardTag)}</span>`
                        : `<strong>${escHtml(identity)}</strong>`;
                    const lbTerms    = [...new Set([identity, cardTag].filter(Boolean).map(s => s.toLowerCase()))];
                    const lbVid      = findVideoForRecord(r, lbTerms);
                    const timeStr    = r['Time'] || '—';
                    const timeMarkup = lbVid
                        ? `<a class="time-cell time-link"
                              href="https://youtube.com/watch?v=${lbVid.id}"
                              target="_blank" rel="noopener">${timeStr} ↗</a>`
                        : `<span class="time-cell">${timeStr}</span>`;

                    return `
                <tr>
                    <td><span class="rank-badge rank-${i + 1}">${i + 1}</span></td>
                    <td>${playerCell}</td>
                    <td style="color:var(--muted);font-size:0.88em">${escHtml(r['Car_clean'] || r['Car'] || '—')}</td>
                    <td>${timeMarkup}</td>
                    ${showCond ? `<td class="lb-col-cond"><span class="cond-badge cond-${(r['Condition']||'').toLowerCase()}">${escHtml(r['Condition']||'')}</span></td>` : ''}
                    ${showDir  ? `<td class="lb-col-dir" style="color:var(--muted);font-size:0.8em;white-space:nowrap">${escHtml(r['Direction']||'')}</td>` : ''}
                </tr>`;
                }).join('')}
            </tbody>
        </table>
        ${_wrStripHtml}
        <div class="lb-footer-link">
            <a href="/courses/${activeTrack.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}.html">
                ${activeTrack.toUpperCase()} COURSE PAGE ↗
            </a>
            <a href="https://idrankings.com/initiald/v3/rankings" target="_blank" rel="noopener">
                ALL-TIME WORLD RECORDS ↗
            </a>
        </div>`;

    // Announce filter result to screen readers
    const _lbAnn = document.getElementById('lb-announcement');
    if (_lbAnn && activeTrack) {
        const dirPart  = (activeDir  && activeDir  !== 'all') ? ` ${activeDir}`  : '';
        const condPart = (activeCond && activeCond !== 'all') ? ` ${activeCond}` : '';
        _lbAnn.textContent = `${records.length} record${records.length !== 1 ? 's' : ''} for ${activeTrack}${dirPart}${condPart}`;
    }

    // Sync URL to current filter state
    if (activeTrack) {
        const _fp = new URLSearchParams(window.location.search);
        _fp.set('course', activeTrack);
        if (activeDir  && activeDir  !== 'all') _fp.set('dir',  activeDir);  else _fp.delete('dir');
        if (activeCond && activeCond !== 'all') _fp.set('cond', activeCond); else _fp.delete('cond');
        history.replaceState(null, '', `?${_fp.toString()}`);
    }
}

/* ════════════════════════════════════════════════════════════
   RACERS GRID
   ════════════════════════════════════════════════════════════ */
function initRacers() {
    const grid = document.getElementById('racer-grid');

    grid.innerHTML = RACERS.map(r => {
        // Safe abbreviation for placeholder (strip special chars, take first 2 letters)
        const abbr = r.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
        const avatarHtml = r.img
            ? `<img class="racer-avatar" src="${r.img}" alt="${r.name}" width="80" height="80"
                    onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
               <div class="racer-avatar-placeholder" style="display:none">${abbr}</div>`
            : `<div class="racer-avatar-placeholder">${abbr}</div>`;

        return `
        <div class="racer-card" data-player="${r.name}" role="button" tabindex="0"
             aria-label="View ${r.name} profile">
            <div class="racer-avatar-wrap">
                ${avatarHtml}
            </div>
            <div class="racer-name">${r.name}</div>
        </div>`;
    }).join('');

    // Click and keyboard handlers — event delegation
    grid.addEventListener('click', e => {
        const card = e.target.closest('.racer-card');
        if (card) openRacerDetail(card.dataset.player);
    });
    grid.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target.closest('.racer-card');
        if (card) { e.preventDefault(); openRacerDetail(card.dataset.player); }
    });
}

/* ════════════════════════════════════════════════════════════
   RACER DETAIL PANEL
   ════════════════════════════════════════════════════════════ */
let homeVideos = [];          // populated by initVideos() for use in detail panel
let activeRacerName = null;

/* ── Battle data (publish-gated) ───────────────────────────── */
// One fetch of the Elo calc tab feeds the ELO leaderboard, the racer detail
// panel's head-to-head and by-course tables, and the hero ELO leader stat.
// Matches whose video hasn't gone live yet are dropped before anything is
// derived, so the board never reveals a scheduled upload's result.
let _battleDataPromise = null;
let _battleData        = null;   // { standings, byCourse, headToHead, withheldCount }

function loadBattleData() {
    if (_battleDataPromise) return _battleDataPromise;

    _battleDataPromise = Promise.all([
        fetchSheetData(ELO_CALC_GID),
        // Resolve rather than reject — a dead YouTube fetch must not take the
        // leaderboard down with it, it just falls back to date-only gating.
        loadVideosOnce().catch(() => null),
    ]).then(([rows, ytResult]) => {
        const all = BattleEngine.parseMatches(rows);

        const outOfOrder = BattleEngine.checkChainOrder(all);
        if (outOfOrder.length) {
            console.warn('[battle] Elo calc tab is not date-ascending at rows ' +
                outOfOrder.join(', ') + ' — ratings may read from an incomplete chain.');
        }

        const videos   = ytResult && ytResult.videos ? ytResult.videos : [];
        const { published, withheld } = BattleEngine.splitByPublished(all, {
            publishedIds: BattleEngine.publishedIdsFrom(videos),
        });

        if (withheld.length) {
            console.info(`[battle] ${published.length} published matches shown, ` +
                `${withheld.length} held back until their videos go live.`);
        }

        _battleData = {
            standings    : BattleEngine.deriveStandings(published),
            byCourse     : BattleEngine.deriveByCourse(published, COURSE_ORDER),
            headToHead   : BattleEngine.deriveHeadToHead(published),
            withheldCount: withheld.length,
        };
        return _battleData;
    });

    return _battleDataPromise;
}

/* ── TA records from allRecords (already loaded) ──────────── */
// Returns the player's best time per car + track + direction + condition,
// derived directly from the main leaderboard data so it's always accurate.
function getPlayerTARecords(playerName) {
    const nameLower = playerName.toLowerCase();
    const nameNorm  = normalizeName(playerName);

    // Primary match: Identity (real racer). Fallback: Player Tag or Tag_clean.
    // Normalised comparison strips hyphens/punctuation so "H-T" matches "HT", etc.
    let records = allRecords.filter(r => {
        const identity    = (r['Identity']   || '').toLowerCase();
        const identityNorm = normalizeName(r['Identity'] || '');
        const tag         = (r['Player Tag'] || r['Tag_clean'] || '').toLowerCase();
        const tagNorm     = normalizeName(r['Player Tag'] || r['Tag_clean'] || '');
        if (identity && (identity === nameLower || identityNorm === nameNorm)) return true;
        if (!identity && (tag === nameLower || tagNorm === nameNorm)) return true;
        return false;
    });

    if (!records.length) return {};

    // Sort fastest first, then keep best time per car + track + dir + cond
    records.sort((a, b) => timeToMs(a) - timeToMs(b));
    const seen = new Set();
    records = records.filter(r => {
        const car = r['Car_clean'] || r['Car'] || '';
        const key = `${car}|${r['Map']}|${r['Direction']}|${r['Condition']}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Group by car
    const byCar = {};
    records.forEach(r => {
        const car = r['Car_clean'] || r['Car'] || 'Unknown';
        if (!byCar[car]) byCar[car] = [];
        byCar[car].push(r);
    });

    // Sort each car's rows by canonical course order
    Object.values(byCar).forEach(rows => {
        rows.sort((a, b) => courseIndex(a['Map']) - courseIndex(b['Map']));
    });

    return byCar; // { 'BNR32': [ record, ... ], 'AE86': [ ... ] }
}

/* ── Sheet parsers ─────────────────────────────────────────── */

// Labels that appear as subheader rows inside player blocks — must be skipped
const SUBHEADER_LABELS = /^(course|opponent|player|racer|name)$/i;

function parseCourseRecords(rawRows) {
    // Returns { 'DUSK': [{ car, records: [{ rank, map, dir, time, cond }] }] }
    // Two levels of grouping: player header → car header → data rows
    const RACER_NORMS = new Set(RACERS.map(r => normalizeName(r.name)));
    const result = {};
    let curPlayer = null;
    let curCar    = null;

    rawRows.forEach(row => {
        const vals = Object.values(row);
        const first = vals[0];
        const restNull = vals.slice(1).every(v => v == null || v === '');

        if (first == null) return;

        if (restNull) {
            const str  = String(first).trim();
            const norm = normalizeName(str);

            // Distinguish player headers from car headers by matching known racer names
            if (RACER_NORMS.has(norm) || !curPlayer) {
                curPlayer = str;
                curCar    = null;
                if (!result[str]) result[str] = [];
            } else {
                // Car sub-header within the current player block
                curCar = { car: str, records: [] };
                if (curPlayer && result[curPlayer]) result[curPlayer].push(curCar);
            }
        } else if (curPlayer && curCar && vals.some(v => v != null)) {
            curCar.records.push({
                rank: vals[0],
                map:  vals[1],
                dir:  vals[2],
                time: vals[3],
                cond: vals[4],
            });
        }
    });

    return result;
}

/* ── Direction full-name → abbreviation map ───────────────── */
// Both hyphenated and space-separated variants included so sheet
// inconsistencies ("Counter-Clockwise" vs "Counter Clockwise") both resolve.
const DIR_TO_ABBR = {
    'Counter-Clockwise': 'CCW', 'Counter Clockwise': 'CCW',
    'Clockwise': 'CW',
    'Downhill': 'DH', 'Uphill': 'UH',
    'Outbound': 'OB', 'Inbound': 'IB',
    // Irohazaka's second direction is stored as "Reverse" in the sheet;
    // idrankings (world records) files the same runs under "UH"
    'Reverse': 'UH',
};

// Match a player search term against a video title safely.
// Pure alphanumeric terms (HT, JJ, SHI, BAKA…) use lookaround assertions so
// we don't match the term as a substring inside another word:
//   "HT" must NOT match "night", "right", "eight", etc.
// Terms that already contain non-alphanumeric characters (:v, CHON!, WHAT?, (.Y.))
// are distinctive enough that simple inclusion is fine.
// Milliseconds for sorting a record. The displayed Time string is the source
// of truth — the sheet's Time_ms column has had stale values that made rows
// sort differently than they read. Time_ms is only a fallback for rows whose
// Time string doesn't parse.
function timeToMs(r) {
    const s = normalizeQuotes(String(r['Time'] || ''));
    const m = s.match(/^(\d+)'(\d+)["](\d+)$/);
    if (m) return +m[1] * 60000 + +m[2] * 1000 + +m[3];
    const ms = r['Time_ms'];
    return (ms != null && ms > 0) ? ms : 9999999;
}

function matchesPlayerTerm(title, term) {
    if (/^[a-z0-9]+$/i.test(term)) {
        const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Use capturing groups instead of lookbehind — Safari 16 and earlier don't support (?<!...)
        return new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)', 'i').test(title);
    }
    return title.toLowerCase().includes(term.toLowerCase());
}

// Normalize typographic/Unicode quote variants to plain ASCII so sheet values
// and YouTube titles match regardless of which quote character was used.
//   '  '  ʼ  ′  →  '     (apostrophe / single quote)
//   "  "  ″  →  "         (double quote)
function normalizeQuotes(s) {
    return s
        .replace(/[‘’ʼ′]/g, "'")
        .replace(/[“”″]/g, '"');
}

// Extract an 11-char YouTube video ID from a watch/short URL, or null.
function videoIdFromUrl(u) {
    const m = String(u || '').match(/(?:youtube\.com\/watch\?(?:[^#]*&)?v=|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
}

// Maps car name patterns to their video-title shorthand.
// Checked top-to-bottom — first match wins.
// AE85 must come before the Levin rule because some AE85 names contain "Levin".
const CAR_TITLE_MAP = [
    { match: /ae85/i,   code: 'ae85' },  // Corolla Levin SR (AE85) → "AE85"
    { match: /levin/i,  code: '86l'  },  // Levin GT-APEX (AE86)    → "86L"
    // Trueno (AE86) uses the raw parenthetical "AE86" — no alias needed
    // Add more rows here for any other car with a custom title shorthand
];

// Return the string to look for in a video title for a given Car_clean value.
//   "Levin GT-APEX (AE86)"  →  "86l"
//   "Sprinter Trueno (AE86)"→  "ae86"  (falls through to parenthetical)
//   "Lancer Evo III (CE9A)" →  "ce9a"  (falls through to parenthetical)
function carCode(car) {
    const s = car || '';
    for (const { match, code } of CAR_TITLE_MAP) {
        if (match.test(s)) return code;
    }
    const m = s.match(/\(([^)]+)\)$/);
    return m ? m[1].toLowerCase() : s.toLowerCase();
}

// Find the best-matching YouTube video for a TA record.
//
// Required signals (all must pass):
//   1. Lap time  — normalized to ASCII quotes, present anywhere in the title
//   2. Course    — course name present in title
//   3. Player    — identity or any known card tag present in title
//   4. Direction — abbreviation (CCW, DH, …) or full name present in title
//
// Tiebreaker (when multiple candidates survive):
//   Prefer the video whose title also contains the car code (e.g. "AE86").
function findVideoForRecord(r, searchTerms) {
    // Exact link from the sheet wins over fuzzy title matching — and works
    // even when the YouTube API hasn't loaded (homeVideos empty).
    const sheetVid = videoIdFromUrl(r['YouTube URL']);
    if (sheetVid) return { id: sheetVid };

    if (!r['Time'] || !homeVideos.length) return null;

    const time    = normalizeQuotes(r['Time'].trim()).toLowerCase();
    const course  = (r['Map'] || '').toLowerCase();
    const dirAbbr = (DIR_TO_ABBR[r['Direction']] || '').toLowerCase();
    const dirFull = (r['Direction'] || '').toLowerCase().replace('-', ' '); // "counter-clockwise" → "counter clockwise"
    const car     = carCode(r['Car_clean'] || r['Car'] || '');

    const candidates = homeVideos.filter(v => {
        const t = normalizeQuotes(v.title).toLowerCase();

        // 1. Lap time (normalized)
        if (!t.includes(time)) return false;

        // 2. Course name
        if (course && !t.includes(course)) return false;

        // 3. Player identity or any card tag
        if (searchTerms.length && !searchTerms.some(term => matchesPlayerTerm(v.title, term))) return false;

        // 4. Direction — abbreviation OR spelled-out full name
        if (dirAbbr || dirFull) {
            const hasAbbr = dirAbbr && t.includes(dirAbbr);
            const hasFull = dirFull && t.includes(dirFull);
            if (!hasAbbr && !hasFull) return false;
        }

        // Condition intentionally not checked — not included in video titles

        return true;
    });

    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    // Multiple videos survived — pick the one that also names the car
    if (car) {
        const bycar = candidates.find(v => normalizeQuotes(v.title).toLowerCase().includes(car));
        if (bycar) return bycar;
    }

    return candidates[0];
}

/* ── Open / render detail panel ────────────────────────────── */
async function openRacerDetail(playerName) {
    activeRacerName = playerName;
    trackEvent('racer_profile_view', { racer: playerName });

    // Mark active card
    document.querySelectorAll('.racer-card').forEach(c => c.classList.remove('active'));
    document.querySelector(`.racer-card[data-player="${CSS.escape(playerName)}"]`)
            ?.classList.add('active');

    const panel    = document.getElementById('racer-detail');
    const backdrop = document.getElementById('racer-backdrop');
    const content  = document.getElementById('racer-detail-content');

    // Show modal with loading state
    panel.style.display = '';
    backdrop.classList.add('active');
    document.body.classList.add('modal-open');
    content.innerHTML = '<div class="loading">LOADING RACER DATA...</div>';

    // Preserve any existing course params when updating URL
    const _openParams = new URLSearchParams(window.location.search);
    _openParams.set('racer', playerName);
    history.replaceState({ racer: playerName }, '', `?${_openParams.toString()}`);

    // Wait for both data sources in parallel — both are no-ops after first load
    // (loadBattleData and _leaderboardPromise cache their results).
    try {
        await Promise.all([
            loadBattleData(),
            _leaderboardPromise,   // guarantees allRecords is populated before we render TA records
        ]);
    } catch {
        // If data load fails entirely (all JSONP timeouts), show error rather than stuck spinner
        if (activeRacerName !== playerName) return;
        content.innerHTML = `
            <div style="padding:2rem;font-family:var(--font-mono);color:var(--muted);text-align:center">
                <p>FAILED TO LOAD DATA</p>
                <button class="detail-close" id="detail-close" aria-label="Close racer detail"
                        style="margin-top:1.5rem">CLOSE ✕</button>
            </div>`;
        document.getElementById('detail-close')?.addEventListener('click', closeRacerDetail);
        document.getElementById('detail-close')?.focus();
        return;
    }

    // Guard against a second click overtaking this one
    if (activeRacerName !== playerName) return;

    renderRacerDetail(playerName, content);
    // Move focus into modal for keyboard/screen reader users
    document.getElementById('detail-close')?.focus();
}

function renderRacerDetail(playerName, container) {
    const racer    = RACERS.find(r => r.name === playerName);
    const battleSt = findInCache(_battleData?.byCourse,   playerName);
    const h2h      = findInCache(_battleData?.headToHead, playerName);
    // TA records come directly from allRecords — already loaded, always accurate
    const taByCar  = getPlayerTARecords(playerName);

    const abbr = playerName.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
    const avatarHtml = racer?.img
        ? `<img class="detail-avatar" src="${racer.img}" alt="${playerName}" width="100" height="100"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
           <div class="detail-avatar-placeholder" style="display:none">${abbr}</div>`
        : `<div class="detail-avatar-placeholder">${abbr}</div>`;

    // Collect all card tags that map to this real identity (for alt-card video matching)
    // e.g. DUSK might also appear under card name DAWN → include "dawn" in video title search
    //
    // A tag is only included if:
    //   1. It's at least 3 characters long
    //   2. It normalizes differently from the player's own name (avoids duplicates)
    //   3. It's EXCLUSIVELY used by this player — if another Identity ever used the
    //      same card tag, it's shared/ambiguous and would cause false positives in
    //      video title matching (e.g. VIRUS and WHAT? both using a "HIRO" card).
    const foreignTags = new Set(
        allRecords
            .filter(r => (r['Identity'] || '').toLowerCase() !== playerName.toLowerCase())
            .map(r => (r['Player Tag'] || '').toLowerCase())
            .filter(Boolean)
    );
    const altCardNames = [...new Set(
        allRecords
            .filter(r => (r['Identity'] || '').toLowerCase() === playerName.toLowerCase())
            .map(r => (r['Player Tag'] || '').toLowerCase())
            .filter(tag =>
                tag.length >= 3 &&
                normalizeName(tag) !== normalizeName(playerName) &&
                !foreignTags.has(tag)
            )
    )];
    const searchTerms = [playerName.toLowerCase(), ...altCardNames];

    // Recent videos: match by identity name ONLY (not alt card names).
    // Alt card matching (HIRO/SOKHA/etc.) is too broad for a general title search —
    // multiple players may use the same physical card, so "HIRO" in a title doesn't
    // reliably mean it's this player's video. findVideoForRecord() uses altCardNames
    // safely because it also requires time + course + direction to match.
    const recentVideos = homeVideos
        .filter(v => matchesPlayerTerm(v.title, playerName))
        .slice(0, 10);

    const hasBattle = battleSt?.courses?.length;
    const hasH2H    = h2h?.length;
    const carNames  = Object.keys(taByCar);

    // ── Build HTML ─────────────────────────────────────────
    const slug = playerSlug(playerName);
    let html = `
        <div class="detail-header">
            <div class="detail-player-info">
                <div class="detail-avatar-wrap">${avatarHtml}</div>
                <div>
                    <div class="detail-player-name">${playerName}</div>
                    <a href="/racers/${slug}.html" class="detail-profile-link">Full Profile ↗</a>
                </div>
            </div>
            <button class="detail-close" id="detail-close" aria-label="Close racer detail">✕</button>
        </div>`;

    // ── BATTLE RECORDS ────────────────────────────────────
    // Always render the section so the user can see it loaded (even if empty)
    if (true) {
        html += `
        <div class="detail-group">
            <div class="detail-group-header">
                <span class="detail-group-label">BATTLE RECORDS</span>
                ${battleSt?.overall
                    ? `<span class="detail-group-overall">${battleSt.overall}</span>` : ''}
            </div>
            <div class="detail-two-col">`;

        if (hasH2H) {
            html += `
                <div class="detail-section">
                    <div class="detail-section-label">// HEAD TO HEAD</div>
                    <table class="leaderboard-table">
                        <thead>
                            <tr><th>OPPONENT</th><th>W</th><th>L</th><th>TOTAL</th><th>WIN%</th></tr>
                        </thead>
                        <tbody>
                            ${h2h.filter(r => r.opponent).map(r => `
                            <tr>
                                <td>${escHtml(r.opponent)}</td>
                                <td style="color:var(--green)">${r.wins ?? '—'}</td>
                                <td style="color:var(--red)">${r.losses ?? '—'}</td>
                                <td>${r.total ?? '—'}</td>
                                <td style="color:var(--muted)">${fmtPct(r.winPct)}</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
        }

        if (hasBattle) {
            html += `
                <div class="detail-section">
                    <div class="detail-section-label">// BY COURSE</div>
                    <table class="leaderboard-table">
                        <thead>
                            <tr><th>COURSE</th><th>W</th><th>L</th><th>TOTAL</th><th>WIN%</th></tr>
                        </thead>
                        <tbody>
                            ${battleSt.courses.filter(c => c.name).map(c => `
                            <tr>
                                <td>${escHtml(c.name)}</td>
                                <td style="color:var(--green)">${c.wins ?? '—'}</td>
                                <td style="color:var(--orange)">${c.losses ?? '—'}</td>
                                <td>${c.total ?? '—'}</td>
                                <td style="color:var(--muted)">${fmtPct(c.winPct)}</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
        }

        // Fallback — data loaded but no battle records exist for this player
        if (!hasH2H && !hasBattle) {
            html += `
                <div class="detail-section">
                    <p class="detail-empty">No battle records on file.</p>
                </div>`;
        }

        html += `</div></div>`; // end two-col + detail-group
    }

    // ── TIME ATTACK RECORDS ───────────────────────────────
    // Always render the section header; show table or placeholder depending on data
    html += `
        <div class="detail-group">
            <div class="detail-group-header">
                <span class="detail-group-label">TIME ATTACK RECORDS</span>
            </div>`;

    if (carNames.length) {
        html += `
            <table class="leaderboard-table ta-detail-table">
                <colgroup>
                    <col style="width:28%">
                    <col style="width:28%">
                    <col style="width:14%">
                    <col style="width:30%">
                </colgroup>
                <thead>
                    <tr><th>COURSE</th><th>DIR</th><th>COND</th><th>TIME</th></tr>
                </thead>
                <tbody>
                    ${carNames.map(car => {
                        const rows = taByCar[car];
                        return `
                        <tr class="ta-car-header-row">
                            <td colspan="4" class="detail-car-name">${car}</td>
                        </tr>
                        ${rows.map(r => {
                            const timeStr = r['Time'] ?? '—';
                            const vid     = findVideoForRecord(r, searchTerms);
                            const timeCell = vid
                                ? `<a class="time-cell time-link"
                                      href="https://youtube.com/watch?v=${vid.id}"
                                      target="_blank" rel="noopener">${timeStr} ↗</a>`
                                : `<span class="time-cell">${timeStr}</span>`;
                            const courseLink = r['Map']
                                ? `<a href="/courses/${playerSlug(r['Map'])}.html" class="ta-course-link">${escHtml(r['Map'])}</a>`
                                : '—';
                            return `
                        <tr>
                            <td>${courseLink}</td>
                            <td style="color:var(--muted);font-size:0.8em;white-space:nowrap">${escHtml(r['Direction'] ?? '—')}</td>
                            <td><span class="cond-badge cond-${String(r['Condition']||'').toLowerCase()}">${escHtml(r['Condition'] ?? '')}</span></td>
                            <td>${timeCell}</td>
                        </tr>`;
                        }).join('')}`;
                    }).join('')}
                </tbody>
            </table>`;
    } else {
        html += `<p class="detail-empty">No time attack records on file.</p>`;
    }

    html += `</div>`; // end detail-group

    // ── RECENT VIDEOS ─────────────────────────────────────
    if (recentVideos.length) {
        const allPlayerVideos = homeVideos.filter(v => matchesPlayerTerm(v.title, playerName));
        const hasMore = allPlayerVideos.length > recentVideos.length;
        html += `
        <div class="detail-group">
            <div class="detail-group-header">
                <span class="detail-group-label">RECENT VIDEOS</span>
                ${hasMore
                    ? `<a href="videos.html?player=${encodeURIComponent(playerName)}"
                          class="detail-view-all-link">VIEW ALL ${allPlayerVideos.length} →</a>`
                    : ''}
            </div>
            <div class="detail-video-grid">
                ${recentVideos.map(v => {
                    const thumb   = v.thumbnail || `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`;
                    const dateStr = v.date
                        ? new Date(v.date).toLocaleDateString('en-US',
                            {year:'numeric', month:'short', day:'numeric'})
                        : '';
                    return `
                    <a class="video-card" href="https://youtube.com/watch?v=${v.id}"
                       target="_blank" rel="noopener">
                        <div class="video-thumb">
                            <img src="${thumb}" alt="${escHtml(v.title)}" loading="lazy">
                        </div>
                        <div class="video-info">
                            <div class="video-title">${escHtml(v.title)}</div>
                            ${dateStr
                                ? `<div class="video-date" style="margin-top:0.4rem">${dateStr}</div>`
                                : ''}
                        </div>
                    </a>`;
                }).join('')}
            </div>
        </div>`;
    }

    // Empty fallback
    if (!hasBattle && !hasH2H && !carNames.length && !recentVideos.length) {
        html += `
        <div class="empty-state" style="padding:2rem 0">
            <div class="empty-icon">—</div>
            <p>No data available for this racer yet.</p>
        </div>`;
    }

    container.innerHTML = html;

    // Wire close button
    document.getElementById('detail-close')?.addEventListener('click', closeRacerDetail);
}

function closeRacerDetail() {
    document.getElementById('racer-detail').style.display = 'none';
    document.getElementById('racer-backdrop').classList.remove('active');
    document.body.classList.remove('modal-open');
    // Return focus to the card that triggered the modal (before clearing activeRacerName)
    if (activeRacerName) {
        document.querySelector(`.racer-card[data-player="${CSS.escape(activeRacerName)}"]`)?.focus();
    }
    document.querySelectorAll('.racer-card').forEach(c => c.classList.remove('active'));
    activeRacerName = null;
    const _closeParams = new URLSearchParams(window.location.search);
    _closeParams.delete('racer');
    const _closeQs = _closeParams.toString();
    history.replaceState(null, '', _closeQs ? `?${_closeQs}` : window.location.pathname);
}

/* ════════════════════════════════════════════════════════════
   BATTLE LEADERBOARD (homepage section)
   ════════════════════════════════════════════════════════════ */
async function initBattleLeaderboard() {
    const container = document.getElementById('battle-leaderboard');
    if (!container) return;

    const { standings, withheldCount } = await loadBattleData();

    if (!standings.length) {
        container.innerHTML = `<p style="color:var(--muted);font-family:var(--font-mono);padding:2rem 0">
            No battle data available.</p>`;
        return;
    }

    // Hero stat strip — current ELO leader
    updateHeroStats({ elo1: String(standings[0].racer).toUpperCase() });

    const COLS = [
        { label: 'RACER',       cell: r => playerCell(r.racer) },
        { label: 'ELO',         cell: r => `<span class="elo-value">${r.elo == null ? '—' : r.elo.toFixed(2)}</span>`, accent: true },
        { label: 'W',           cell: r => `<span style="color:var(--green)">${r.wins}</span>` },
        { label: 'L',           cell: r => `<span style="color:var(--red)">${r.losses}</span>` },
        { label: 'MATCHES',     cell: r => r.matches },
        { label: 'WIN %',       cell: r => `<span style="color:var(--muted)">${(r.winPct * 100).toFixed(1)}%</span>` },
        { label: 'STREAK',      cell: r => streakCell(r.streak) },
        { label: 'LAST ACTIVE', cell: r => `<span style="color:var(--muted)">${fmtDate(r.lastActive)}</span>` },
    ];

    // Roster match is normalised so sheet variants like ":V" still resolve to
    // ":v"; guests (MJ, KAY, …) have no profile page so they stay plain text.
    function playerCell(name) {
        const known = RACERS.find(rc =>
            rc.name === name || normalizeName(rc.name) === normalizeName(name));
        return known
            ? `<button class="battle-player-link" data-racer="${escHtml(known.name)}">${escHtml(known.name)}</button>`
            : `<strong>${escHtml(name) || '—'}</strong>`;
    }

    function streakCell(s) {
        if (!s) return '—';
        const colour = s[0] === 'W' ? 'var(--green)' : 'var(--red)';
        return `<span style="color:${colour}">${escHtml(s)}</span>`;
    }

    function fmtDate(d) {
        if (!d) return '—';
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    container.innerHTML = `
        <table class="leaderboard-table">
            <thead>
                <tr>
                    <th>RANK</th>
                    ${COLS.map(c =>
                        `<th${c.accent ? ' style="color:var(--orange)"' : ''}>${c.label}</th>`
                    ).join('')}
                </tr>
            </thead>
            <tbody>
                ${standings.map(r => `
                <tr>
                    <td><span class="rank-badge rank-${r.rank}">${r.rank}</span></td>
                    ${COLS.map(c => `<td>${c.cell(r)}</td>`).join('')}
                </tr>`).join('')}
            </tbody>
        </table>
        ${withheldCount
            ? `<p class="battle-pending-note">▸ Standings are current as of the latest published video.
                   ${withheldCount} logged ${withheldCount === 1 ? 'battle is' : 'battles are'}
                   waiting on ${withheldCount === 1 ? 'its' : 'their'} upload and ${withheldCount === 1 ? 'is' : 'are'} not counted yet.</p>`
            : ''}`;

    container.querySelectorAll('.battle-player-link[data-racer]').forEach(btn => {
        btn.addEventListener('click', () => openRacerDetail(btn.dataset.racer));
    });
}
/* ════════════════════════════════════════════════════════════
   VIDEOS — homepage preview (6 most recent, two rows of 3)
   ════════════════════════════════════════════════════════════ */
const HOME_VIDEO_COUNT = 6;

// The video preview and the battle publish gate both need the channel's upload
// list. Share one call so a cold localStorage cache doesn't cost two API round
// trips (and two hits against the YouTube quota) per page load.
let _videosPromise = null;
function loadVideosOnce() {
    if (!_videosPromise) _videosPromise = loadVideos();
    return _videosPromise;
}

async function initVideos() {
    const grid = document.getElementById('video-grid');
    grid.innerHTML = '<div class="loading">LOADING VIDEOS...</div>';

    const result = await loadVideosOnce();

    if (result.status === 'unconfigured') {
        grid.innerHTML = `
            <p style="color:var(--muted);font-family:var(--font-mono);font-size:0.82rem;
                      grid-column:1/-1;line-height:1.8">
                ▸ Open <strong style="color:var(--text)">data/videos.js</strong> and add your
                YouTube API key and Channel ID — videos will appear here automatically.
            </p>`;
        return;
    }

    if (result.status === 'error') {
        grid.innerHTML = `
            <p style="color:var(--muted);font-family:var(--font-mono);font-size:0.82rem;grid-column:1/-1">
                ⚠ Could not load videos: ${result.message}
            </p>`;
        return;
    }

    // Store videos for use in the racer detail panel and leaderboard links
    homeVideos = result.videos;

    // Re-render the leaderboard now that videos are available so time links appear.
    // (The leaderboard almost always finishes before the YouTube API responds.)
    if (activeTrack) filterAndRender();

    const recent = homeVideos.slice(0, HOME_VIDEO_COUNT);

    grid.innerHTML = recent.map(v => `
        <a class="video-card" href="https://youtube.com/watch?v=${v.id}" target="_blank" rel="noopener">
            <div class="video-thumb">
                <img src="${v.thumbnail || `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`}"
                     alt="${escHtml(v.title)}" loading="lazy">
            </div>
            <div class="video-info">
                <div class="video-title">${escHtml(v.title)}</div>
                ${v.date
                    ? `<div class="video-date" style="margin-top:0.4rem">
                           ${new Date(v.date).toLocaleDateString('en-US',
                               {year:'numeric', month:'short', day:'numeric'})}
                       </div>`
                    : ''}
            </div>
        </a>
    `).join('');
}

/* ════════════════════════════════════════════════════════════
   MOBILE NAV
   ════════════════════════════════════════════════════════════ */
function initNav() {
    const toggle = document.getElementById('nav-toggle');
    const links  = document.getElementById('nav-links');
    if (!toggle || !links) return;

    toggle.addEventListener('click', () => {
        const isOpen = links.classList.toggle('open');
        toggle.setAttribute('aria-expanded', isOpen);
    });

    links.querySelectorAll('a').forEach(a =>
        a.addEventListener('click', () => {
            links.classList.remove('open');
            toggle.setAttribute('aria-expanded', 'false');
        })
    );
}

/* ════════════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════
   HERO STATS STRIP
   ════════════════════════════════════════════════════════════ */
function updateHeroStats(updates = {}) {
    if ('racers'  in updates) { const el = document.getElementById('stat-racers');  if (el) el.textContent = updates.racers; }
    if ('records' in updates) { const el = document.getElementById('stat-records'); if (el) el.textContent = updates.records; }
    if ('courses' in updates) { const el = document.getElementById('stat-courses'); if (el) el.textContent = updates.courses; }
    if ('elo1'    in updates) { const el = document.getElementById('stat-elo1');    if (el) el.textContent = updates.elo1; }
}

document.addEventListener('DOMContentLoaded', () => {
    // Capture URL params before any init overwrites them
    const _urlParams   = new URLSearchParams(window.location.search);
    const _paramRacer  = _urlParams.get('racer');
    const _paramCourse = _urlParams.get('course');
    const _paramDir    = _urlParams.get('dir');
    const _paramCond   = _urlParams.get('cond');

    initNav();
    initRacers();           // synchronous — renders cards immediately from RACERS array
    initVideos();           // async — fetches YouTube videos
    _leaderboardPromise = initLeaderboard(); // async — fetches TA leaderboard sheet; stored for racer detail
    initBattleLeaderboard(); // async — fetches battle ELO leaderboard

    // Hero stats — static values available immediately
    updateHeroStats({ racers: RACERS.length, courses: COURSE_ORDER.length });

    // Close racer detail on Escape or backdrop click
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && activeRacerName) closeRacerDetail();
    });
    document.getElementById('racer-backdrop')?.addEventListener('click', () => {
        if (activeRacerName) closeRacerDetail();
    });

    // ── Scroll-spy: highlight nav link for current section ─
    (function() {
        const ids   = ['home','videos','records','battles','racers','about'];
        const links = {};
        ids.forEach(id => {
            const a = document.querySelector(`.nav-links a[href="#${id}"]`);
            if (a) links[id] = a;
        });
        let active = 'home';
        links.home?.classList.add('nav-active');
        window.addEventListener('scroll', () => {
            const mark = window.innerHeight * 0.4;
            let next = 'home';
            for (const id of ids) {
                const el = document.getElementById(id);
                if (el && el.getBoundingClientRect().top <= mark) next = id;
            }
            if (next !== active) {
                links[active]?.classList.remove('nav-active');
                links[next]?.classList.add('nav-active');
                active = next;
            }
        }, { passive: true });
    })();

    // Close modal on backdrop click (click on overlay but not the modal content itself)
    document.getElementById('racer-detail').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeRacerDetail();
    });

    // Apply URL params after leaderboard data is ready
    _leaderboardPromise.then(() => {
        if (_paramCourse && COURSE_ORDER.includes(_paramCourse)) {
            showTrack(_paramCourse);
            // Sync course tab active state (showTrack already called filterAndRender for default dir/cond)
            document.querySelectorAll('#track-tabs .track-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.track === _paramCourse);
            });
            // Override dir/cond if specified in URL
            let needsRerender = false;
            if (_paramDir) {
                activeDir = _paramDir;
                document.querySelectorAll('#direction-tabs .sub-tab').forEach(b => {
                    b.classList.toggle('active', b.dataset.val === _paramDir);
                });
                buildConditionTabs(_paramCourse, _paramDir);
                needsRerender = true;
            }
            if (_paramCond) {
                activeCond = _paramCond;
                document.querySelectorAll('#condition-tabs .sub-tab').forEach(b => {
                    b.classList.toggle('active', b.dataset.val === _paramCond);
                });
                needsRerender = true;
            }
            if (needsRerender) filterAndRender();
        }
        if (_paramRacer && RACERS.some(r => r.name === _paramRacer)) {
            openRacerDetail(_paramRacer);
        }
    });

    // ── Outbound link tracking ─────────────────────────────
    // Single delegated listener catches all external clicks:
    // video cards, time links, nav/footer YouTube links, idrankings, email.
    document.addEventListener('click', e => {
        const a = e.target.closest('a[href]');
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href) return;

        if (href.startsWith('mailto:')) {
            trackEvent('outbound_click', {
                link_url:  href,
                link_text: a.textContent.trim().slice(0, 100),
            });
            return;
        }

        try {
            const url = new URL(href, window.location.href);
            if (url.hostname !== window.location.hostname) {
                trackEvent('outbound_click', {
                    link_url:    href.slice(0, 500),
                    link_domain: url.hostname,
                    link_text:   a.textContent.trim().slice(0, 100),
                });
            }
        } catch { /* unparseable href — skip */ }
    });
});
