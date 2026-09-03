/* ============================================================
   INITIAL D SF — Videos archive page
   ============================================================ */

// Safe analytics wrapper — no-ops if gtag hasn't loaded
function trackEvent(name, params = {}) {
    if (typeof gtag === 'function') gtag('event', name, params);
}

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
}

const SHEET_ID        = '1MaofC1e4XlJ3XtKAokq34Q3q5vTziuz8NNPS7tHZD3E';
const BATTLE_LOG_GID  = '1322076132';

// Course names used for title parsing.
// 'Akina Snow' must come before 'Akina' — extractCourse() takes the first
// substring match, so snow runs would otherwise be tagged as plain Akina.
const COURSES = ['Myogi', 'Usui', 'Akagi', 'Akina Snow', 'Akina', 'Irohazaka', 'Happogahara', 'Shomaru', 'Tsuchisaka'];

// Direction abbreviations found in TA titles (e.g. "Myogi CCW")
const DIR_ABBRS = {
    'CCW': 'Counter-Clockwise',
    'CW':  'Clockwise',
    'DH':  'Downhill',
    'UH':  'Uphill',
    'OB':  'Outbound',
    'IB':  'Inbound',
};

// ── State ──────────────────────────────────────────────────
let allVideos      = [];   // enriched YouTube videos
let battleRecords  = [];   // rows from battle log sheet
let allPlayers     = [];   // derived from battle log

let activeCategory = 'all';
let activeCourse   = 'all';
let activePlayer   = 'all';
let activeSort     = 'newest';

/* ══════════════════════════════════════════════════════════
   DATA FETCHING
   ══════════════════════════════════════════════════════════ */

// JSONP loader for Google Sheets (no CORS issues from file://)
function fetchSheetData(gid) {
    return new Promise((resolve) => {
        const cb = '_gviz_' + Math.random().toString(36).slice(2);
        const cleanup = () => { delete window[cb]; document.getElementById(cb)?.remove(); };

        const timer = setTimeout(() => {
            cleanup();
            console.error('Sheet fetch timed out for gid=' + gid);
            resolve([]);
        }, 10000);

        window[cb] = (response) => {
            clearTimeout(timer);
            cleanup();
            resolve(response?.table ? parseTable(response.table) : []);
        };
        const script    = document.createElement('script');
        script.id       = cb;
        script.onerror  = () => { clearTimeout(timer); cleanup(); resolve([]); };
        // NOTE: a filtering proxy that answers with a block page fires `load`, not
        // `error`, so the timeout above is the only thing that ends that case.
        script.src      = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
                          `?tqx=out:json;responseHandler:${cb}&gid=${gid}`;
        document.head.appendChild(script);
    });
}

// Networks that block docs.google.com (a common corporate rule) would otherwise
// leave every video uncategorised. build.js mirrors the same sheet to a
// same-origin file; fall back to it when the live fetch comes back empty.
// Kept deliberately parallel to getSheetRows() in js/main.js.
function fetchSheetRowsWithFallback(gid) {
    return fetchSheetData(gid).then(rows => {
        if (rows.length) return rows;
        return fetch('/data/snapshot.json', { cache: 'no-cache' })
            .then(r => (r.ok ? r.json() : null))
            .then(s => s?.sheets?.[String(gid)] || [])
            .catch(() => []);
    });
}

function parseTable(table) {
    const cols = table.cols.map(c => (c.label || '').trim());
    return table.rows
        .filter(row => row.c?.some(cell => cell?.v != null))
        .map(row => {
            const obj = {};
            row.c.forEach((cell, i) => { obj[cols[i]] = cell?.v ?? null; });
            return obj;
        });
}

/* ══════════════════════════════════════════════════════════
   VIDEO CATEGORISATION
   ══════════════════════════════════════════════════════════ */

// Try to find a matching battle log entry by title content
function findBattle(video) {
    const t = video.title.toLowerCase();
    return battleRecords.find(b => {
        const a      = (b['Racer A'] || '').toLowerCase();
        const rb     = (b['Racer B'] || '').toLowerCase();
        const course = (b['Course']  || '').toLowerCase();
        return a && rb && course
            && t.includes(a)
            && t.includes(rb)
            && t.includes(course);
    });
}

// Attach category + metadata to a raw YouTube video object
function enrichVideo(video) {
    const title = video.title;

    // 1 ── Battle (title matches a battle log row)
    const battle = findBattle(video);
    if (battle) {
        return {
            ...video,
            category:  'battle',
            course:    battle['Course']     || null,
            direction: battle['Direction']  || null,
            condition: battle['Conditions'] || null,
            players:   [battle['Racer A'], battle['Racer B']].filter(Boolean),
            winner:    battle['Winner']     || null,
        };
    }

    // 2 ── Legend of the Street
    if (/legend of the street|\blots\b/i.test(title)) {
        return {
            ...video,
            category: 'lots',
            players:  extractPlayers(title),
            course:   extractCourse(title),
        };
    }

    // 3 ── Time Attack (has a lap time in the title, e.g. 2'53"688)
    if (/\d+['′']\d{2}["″"]\d{3}/.test(title)) {
        return {
            ...video,
            category:  'attack',
            course:    extractCourse(title),
            direction: extractDirection(title),
            players:   extractPlayers(title),
        };
    }

    // 4 ── Uncategorised
    return { ...video, category: 'other' };
}

function extractCourse(title) {
    return COURSES.find(c => title.includes(c)) || null;
}

function extractDirection(title) {
    for (const [abbr, full] of Object.entries(DIR_ABBRS)) {
        if (new RegExp(`\\b${abbr}\\b`).test(title)) return full;
    }
    return null;
}

function extractPlayers(title) {
    const t = title.toLowerCase();
    return allPlayers.filter(p => t.includes(p.toLowerCase()));
}

// Build the known-players list from the battle log (so it's always up to date)
function buildPlayerList() {
    const names = new Set();
    battleRecords.forEach(b => {
        if (b['Racer A']) names.add(b['Racer A']);
        if (b['Racer B']) names.add(b['Racer B']);
    });
    allPlayers = [...names].sort();
}

/* ══════════════════════════════════════════════════════════
   FILTERING & SORTING
   ══════════════════════════════════════════════════════════ */
function getFilteredVideos() {
    let list = allVideos.filter(v => {
        if (activeCategory !== 'all' && v.category !== activeCategory) return false;
        if (activeCourse   !== 'all' && v.course   !== activeCourse)   return false;
        if (activePlayer   !== 'all') {
            if (!v.players?.includes(activePlayer)) return false;
        }
        return true;
    });

    list.sort((a, b) => {
        const da = a.date ? new Date(a.date) : new Date(0);
        const db = b.date ? new Date(b.date) : new Date(0);
        return activeSort === 'newest' ? db - da : da - db;
    });

    return list;
}

/* ══════════════════════════════════════════════════════════
   UI — PRIMARY TABS
   ══════════════════════════════════════════════════════════ */
const CATEGORIES = [
    { id: 'all',    label: 'ALL' },
    { id: 'attack', label: 'TIME ATTACK' },
    { id: 'battle', label: 'BATTLE' },
    { id: 'lots',   label: 'LEGEND OF THE STREET' },
];

function buildCategoryTabs() {
    const container = document.getElementById('category-tabs');
    container.innerHTML = CATEGORIES.map(c =>
        `<button class="track-tab${c.id === activeCategory ? ' active' : ''}" data-cat="${c.id}">
            ${c.label}
         </button>`
    ).join('');

    container.addEventListener('click', e => {
        const btn = e.target.closest('.track-tab');
        if (!btn) return;
        activeCategory = btn.dataset.cat;
        activeCourse   = 'all';
        activePlayer   = 'all';
        container.querySelectorAll('.track-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        buildSecondaryFilters();
        renderGrid();
    });
}

/* ══════════════════════════════════════════════════════════
   UI — SECONDARY FILTERS (course + player, contextual)
   ══════════════════════════════════════════════════════════ */
function buildSecondaryFilters() {
    const dropdowns    = document.getElementById('filter-dropdowns');
    const courseGroup  = document.getElementById('course-dropdown-group');
    const playerGroup  = document.getElementById('player-dropdown-group');
    const courseSelect = document.getElementById('course-select');
    const playerSelect = document.getElementById('player-select');

    // Course options — scoped to active category
    const courseSubset = allVideos.filter(v =>
        (activeCategory === 'all' || v.category === activeCategory) && v.course
    );
    const courses    = [...new Set(courseSubset.map(v => v.course))].sort();
    const showCourse = courses.length > 0;
    courseGroup.style.display = showCourse ? '' : 'none';
    if (showCourse) {
        courseSelect.innerHTML = ['all', ...courses].map(c =>
            `<option value="${c}"${c === activeCourse ? ' selected' : ''}>${c === 'all' ? 'ALL COURSES' : c}</option>`
        ).join('');
    }

    // Player options — scoped to active category + course
    const playerSubset = allVideos.filter(v =>
        (activeCategory === 'all' || v.category === activeCategory) &&
        (activeCourse   === 'all' || v.course   === activeCourse)   &&
        v.players?.length
    );
    const players    = [...new Set(playerSubset.flatMap(v => v.players))].sort();
    const showPlayer = players.length > 0;
    playerGroup.style.display = showPlayer ? '' : 'none';
    if (showPlayer) {
        playerSelect.innerHTML = ['all', ...players].map(p =>
            `<option value="${p}"${p === activePlayer ? ' selected' : ''}>${p === 'all' ? 'ALL PLAYERS' : p}</option>`
        ).join('');
    }

    dropdowns.style.display = (showCourse || showPlayer) ? '' : 'none';
}

// Wire dropdown change events once
function wireSecondaryFilters() {
    document.getElementById('course-select').addEventListener('change', e => {
        activeCourse = e.target.value;
        activePlayer = 'all';
        buildSecondaryFilters(); // refresh player list for new course
        renderGrid();
    });

    document.getElementById('player-select').addEventListener('change', e => {
        activePlayer = e.target.value;
        renderGrid();
    });
}

/* ══════════════════════════════════════════════════════════
   UI — VIDEO GRID
   ══════════════════════════════════════════════════════════ */
function renderGrid() {
    const videos = getFilteredVideos();
    const grid   = document.getElementById('video-grid');
    const count  = document.getElementById('result-count');

    count.textContent = `${videos.length} video${videos.length !== 1 ? 's' : ''}`;

    if (!videos.length) {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">—</div>
                <p>No videos match this filter.</p>
                <p class="empty-sub">Try clearing the course or player filter.</p>
            </div>`;
        return;
    }

    grid.innerHTML = videos.map(videoCardHTML).join('');
}

function videoCardHTML(v) {
    const thumb   = v.thumbnail || `https://img.youtube.com/vi/${v.id}/hqdefault.jpg`;
    const dateStr = v.date
        ? new Date(v.date).toLocaleDateString('en-US', {year:'numeric', month:'short', day:'numeric'})
        : '';

    const catLabel = { attack: 'TIME ATTACK', battle: 'BATTLE', lots: 'LEGEND' }[v.category] || '';
    const catBadge = catLabel
        ? `<span class="vid-cat-badge cat-${v.category}">${catLabel}</span>` : '';

    const coursePill = v.course
        ? `<span class="video-tag">${v.course.toUpperCase()}${v.direction ? ' · ' + v.direction.toUpperCase() : ''}</span>`
        : '';

    const playerTags = v.players?.length
        ? v.players.map(p => `<span class="video-tag">${p}</span>`).join('') : '';

    const winnerBadge = v.category === 'battle' && v.winner
        ? `<span class="vid-winner">▲ ${v.winner}</span>` : '';

    return `
        <a class="video-card" href="https://youtube.com/watch?v=${v.id}"
           target="_blank" rel="noopener">
            <div class="video-thumb">
                <img src="${thumb}" alt="${escHtml(v.title)}" loading="lazy">
                ${catBadge}
            </div>
            <div class="video-info">
                <div class="video-title">${escHtml(v.title)}</div>
                <div class="video-meta">
                    ${dateStr ? `<span class="video-date">${dateStr}</span>` : ''}
                    ${coursePill}
                    ${playerTags}
                    ${winnerBadge}
                </div>
            </div>
        </a>`;
}

/* ══════════════════════════════════════════════════════════
   UI — SORT + NAV
   ══════════════════════════════════════════════════════════ */
function buildSortTabs() {
    document.querySelectorAll('.sort-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeSort = btn.dataset.sort;
            document.querySelectorAll('.sort-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderGrid();
        });
    });
}

function initNav() {
    const toggle = document.getElementById('nav-toggle');
    const links  = document.getElementById('nav-links');
    if (!toggle || !links) return;
    toggle.addEventListener('click', () => {
        const open = links.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open);
    });
    links.querySelectorAll('a').forEach(a =>
        a.addEventListener('click', () => {
            links.classList.remove('open');
            toggle.setAttribute('aria-expanded', 'false');
        })
    );
}

/* ══════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
    initNav();
    buildSortTabs();

    const grid = document.getElementById('video-grid');
    grid.innerHTML = '<div class="loading">LOADING VIDEOS...</div>';

    // Fetch YouTube videos and battle log in parallel
    const [ytResult, battles] = await Promise.all([
        loadVideos(),
        fetchSheetRowsWithFallback(BATTLE_LOG_GID),
    ]);

    battleRecords = battles;
    buildPlayerList();

    // Pre-filter by player/course from URL params.
    // Player must be added to allPlayers before enrichVideo() so TA video titles get tagged.
    const urlParams   = new URLSearchParams(window.location.search);
    const paramPlayer = urlParams.get('player');
    const paramCourse = urlParams.get('course');
    if (paramPlayer && !allPlayers.includes(paramPlayer)) {
        allPlayers = [...allPlayers, paramPlayer].sort();
    }

    if (ytResult.status === 'unconfigured') {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">▶</div>
                <p>YouTube API not configured.</p>
                <p class="empty-sub">Open <strong>data/videos.js</strong> and follow the setup instructions.</p>
            </div>`;
        return;
    }
    if (ytResult.status === 'error') {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">⚠</div>
                <p>Could not load videos.</p>
                <p class="empty-sub">${ytResult.message}</p>
            </div>`;
        return;
    }

    allVideos = ytResult.videos.map(enrichVideo);

    // Apply URL param pre-selections after videos are enriched
    if (paramPlayer) activePlayer = paramPlayer;
    if (paramCourse) activeCourse = paramCourse;

    buildCategoryTabs();
    wireSecondaryFilters();
    buildSecondaryFilters();
    renderGrid();

    // ── Outbound link tracking ─────────────────────────────
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
