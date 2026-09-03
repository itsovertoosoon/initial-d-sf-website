#!/usr/bin/env node
/**
 * Initial D San Francisco — Pre-render build script
 *
 * Runs at Netlify deploy time (node build.js).
 * Fetches Google Sheets + YouTube data and:
 *
 *   index.html   — injects JSON-LD + noscript TA records / standings
 *   videos.html  — injects JSON-LD VideoObject list + noscript video list
 *   racers/*.html — generates one static profile page per player
 *   sitemap.xml  — regenerated to include all racer pages
 *
 * Do NOT commit modified HTML files — the source markers are the truth.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const BattleEngine = require('./js/battle-engine.js');

const SHEET_ID       = '1MaofC1e4XlJ3XtKAokq34Q3q5vTziuz8NNPS7tHZD3E';
const SITE_URL       = 'https://initialdsanfrancisco.com';
const COURSE_ORDER   = ['Myogi', 'Usui', 'Akagi', 'Akina', 'Irohazaka', 'Akina Snow', 'Happogahara', 'Shomaru', 'Tsuchisaka'];
const ELO_CALC_GID    = BattleEngine.ELO_CALC_GID;
const LEADERBOARD_GID = '0';           // Time Trial Records tab
const BATTLE_LOG_GID  = '1322076132';  // per-battle log, read client-side by js/videos.js

// Sheets mirrored into data/snapshot.json so the site still renders stats when a
// visitor's network blocks docs.google.com (corporate proxies commonly do).
// Keys must match the refs js/main.js and js/videos.js pass to fetchSheetData().
const SNAPSHOT_SHEETS = [LEADERBOARD_GID, ELO_CALC_GID, BATTLE_LOG_GID];

const COURSE_IMAGES = {
    'Myogi':       'Courses/Myogi_map.webp',
    'Usui':        'Courses/Usui_all.gif',
    'Akagi':       'Courses/Akagi_AS8.webp',
    'Akina':       'Courses/05akina_pic.webp',
    'Akina Snow':  'Courses/05akina_pic.webp',
    'Irohazaka':   'Courses/Irohazaka_AS8.webp',
    'Happogahara': 'Courses/Happogahara_AS8.webp',
    'Shomaru':     'Courses/Shomaru_all.webp',
    'Tsuchisaka':  'Courses/10tsuchisaka_pic.webp',
};

const DIR_ORDER  = ['Downhill', 'Uphill', 'Counter-Clockwise', 'Counter Clockwise', 'Clockwise', 'Outbound', 'Inbound'];
const COND_ORDER = ['Dry', 'Wet'];

/* ── Normalise player name for fuzzy matching (mirrors main.js) ─────────── */
function norm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/* ── URL slug ────────────────────────────────────────────────────────────── */
function slug(name) { return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'player'; }

/* ── Read RACERS array from js/main.js ───────────────────────────────────── */
function readRacers() {
    const src = fs.readFileSync(path.join(__dirname, 'js', 'main.js'), 'utf8');
    const re  = /\{\s*name:\s*'([^']+)'\s*,\s*img:\s*(null|'([^']*)')\s*\}/g;
    const out = [];
    let m;
    while ((m = re.exec(src)) !== null) {
        out.push({ name: m[1], img: m[2] === 'null' ? null : m[3] });
    }
    return out;
}

/* ── Read YouTube config from data/videos.js ─────────────────────────────── */
function readYouTubeConfig() {
    const src       = fs.readFileSync(path.join(__dirname, 'data', 'videos.js'), 'utf8');
    const apiKey    = (src.match(/API_KEY\s*:\s*['"]([^'"]+)['"]/)    || [])[1] || '';
    const channelId = (src.match(/CHANNEL_ID\s*:\s*['"]([^'"]+)['"]/) || [])[1] || '';
    return {
        apiKey:    process.env.YOUTUBE_API_KEY    || apiKey,
        channelId: process.env.YOUTUBE_CHANNEL_ID || channelId,
    };
}

/* ── Inject API key from env var into data/videos.js at build time ──────── */
function writeYouTubeConfigIfEnvSet() {
    const apiKey = process.env.YOUTUBE_API_KEY;
    console.log(`[build] YOUTUBE_API_KEY env var: ${apiKey ? 'found (' + apiKey.slice(-4) + ')' : 'NOT SET'}`);
    if (!apiKey) return;
    const filePath = path.join(__dirname, 'data', 'videos.js');
    const src      = fs.readFileSync(filePath, 'utf8');
    const updated  = src.replace(/(API_KEY\s*:\s*)['"][^'"]*['"]/, `$1'${apiKey}'`);
    fs.writeFileSync(filePath, updated, 'utf8');
    console.log('[build] Injected YOUTUBE_API_KEY into data/videos.js');
}

/* ── Fetch + parse a gviz sheet ─────────────────────────────────────────── */
async function fetchSheet(ref, range = '') {
    const param      = /^\d+$/.test(String(ref)) ? `gid=${ref}` : `sheet=${encodeURIComponent(ref)}`;
    const rangeParam = range ? `&range=${encodeURIComponent(range)}` : '';
    const url        = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&${param}${rangeParam}`;
    const res        = await fetch(url);
    if (!res.ok) throw new Error(`Sheet fetch failed (${res.status}) for ${param}`);
    const text   = await res.text();
    const json   = text.replace(/^[^(]+\(/, '').replace(/\);\s*$/, '');
    const { table } = JSON.parse(json);
    return parseTable(table);
}

function parseTable(table) {
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

/* ── Fetch YouTube videos ────────────────────────────────────────────────── */
// The API key is HTTP-referrer-restricted to the site's domain, so build-time
// (server-side) requests must send the site as Referer or Google rejects them.
const YT_FETCH_OPTS = { headers: { Referer: `${SITE_URL}/` } };

async function fetchYouTubeVideos(apiKey, channelId) {
    const chRes  = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${apiKey}`, YT_FETCH_OPTS);
    const chData = await chRes.json();
    if (chData.error) throw new Error(`YouTube: ${chData.error.message}`);
    if (!chData.items?.length) throw new Error('YouTube: channel not found or no uploads playlist');
    const uploadsId = chData.items[0].contentDetails.relatedPlaylists.uploads;
    let videos = [], pageToken = '';
    do {
        const url  = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}&key=${apiKey}`;
        const res  = await fetch(url, YT_FETCH_OPTS);
        const data = await res.json();
        if (data.error) throw new Error(`YouTube: ${data.error.message}`);
        videos    = videos.concat((data.items || []).map(item => ({
            id: item.snippet.resourceId.videoId, title: item.snippet.title, date: item.snippet.publishedAt,
        })));
        pageToken = data.nextPageToken || '';
    } while (pageToken);
    return videos;
}

/* ── Find player data by normalised name ─────────────────────────────────── */
function findPlayer(cache, playerName) {
    if (!cache) return null;
    if (cache[playerName] !== undefined) return cache[playerName];
    const n   = norm(playerName);
    const key = Object.keys(cache).find(k => norm(k) === n);
    return key !== undefined ? cache[key] : null;
}

/* ── Get player TA records from raw rows ─────────────────────────────────── */
function getPlayerTA(taRecords, playerName) {
    const nameNorm = norm(playerName);
    let records = taRecords.filter(r => {
        const iNorm = norm(r['Identity'] || '');
        const tNorm = norm(r['Player Tag'] || r['Tag_clean'] || '');
        return iNorm ? iNorm === nameNorm : tNorm === nameNorm;
    });
    if (!records.length) return {};
    records.sort((a, b) => timeToMs(a) - timeToMs(b));
    const seen = new Set();
    records = records.filter(r => {
        const key = `${r['Car_clean']||r['Car']||''}|${r['Map']}|${r['Direction']}|${r['Condition']}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const byCar = {};
    records.forEach(r => {
        const car = r['Car_clean'] || r['Car'] || 'Unknown';
        if (!byCar[car]) byCar[car] = [];
        byCar[car].push(r);
    });
    Object.values(byCar).forEach(rows =>
        rows.sort((a, b) => {
            const ai = COURSE_ORDER.indexOf(a['Map']), bi = COURSE_ORDER.indexOf(b['Map']);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        })
    );
    return byCar;
}

/* ── HTML helpers ────────────────────────────────────────────────────────── */
function fmtPct(val) {
    if (val == null) return '—';
    if (typeof val === 'number') return (val * 100).toFixed(1) + '%';
    return String(val);
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// Milliseconds for sorting a record — displayed Time string first (mirrors
// main.js timeToMs; the sheet's Time_ms column has had stale values).
function timeToMs(r) {
    const s = String(r['Time'] || '').replace(/[''ʼ′]/g, "'").replace(/[""″]/g, '"');
    const m = s.match(/^(\d+)'(\d+)["](\d+)$/);
    if (m) return +m[1] * 60000 + +m[2] * 1000 + +m[3];
    const ms = r['Time_ms'];
    return (ms != null && ms > 0) ? ms : 9999999;
}
function injectMarker(html, markerName, content) {
    const start = `<!-- PRERENDER:${markerName} -->`;
    const end   = `<!-- /PRERENDER:${markerName} -->`;
    const re    = new RegExp(escRe(start) + '[\\s\\S]*?' + escRe(end));
    if (!re.test(html)) { console.warn(`[build] Marker ${markerName} not found — skipping`); return html; }
    return html.replace(re, `${start}\n${content}\n${end}`);
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ── Generate one racer page ─────────────────────────────────────────────── */
function generateRacerPage(racer, taByCar, battle, h2h, standing) {
    const { name, img } = racer;
    const playerSlug    = slug(name);
    const imgSrc        = img ? `../${img}` : null;
    const ogImage       = img ? `${SITE_URL}/${img}` : `${SITE_URL}/squad.jpg`;
    // standing comes from BattleEngine.deriveStandings() — published matches only
    const rank          = standing ? standing.rank : null;
    const elo           = standing && standing.elo != null ? standing.elo.toFixed(2) : null;
    const streak        = standing ? standing.streak : null;
    const carNames      = Object.keys(taByCar);
    const abbr          = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '??';

    const avatarHtml = imgSrc
        ? `<img class="rp-avatar" src="${esc(imgSrc)}" alt="${esc(name)}" width="120" height="120" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
           <div class="rp-avatar-placeholder" style="display:none">${abbr}</div>`
        : `<div class="rp-avatar-placeholder">${abbr}</div>`;

    const metaDesc = `${esc(name)}'s Initial D Arcade Stage Version 3 time attack records and battle history — SF Bay Area community.`;

    // ── JSON-LD ──
    const jsonLd = {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'ProfilePage',
                '@id'  : `${SITE_URL}/racers/${playerSlug}.html`,
                url    : `${SITE_URL}/racers/${playerSlug}.html`,
                name   : `${name} — Initial D San Francisco`,
                isPartOf: { '@id': `${SITE_URL}/#website` },
                mainEntity: {
                    '@type': 'Person',
                    name,
                    memberOf: { '@id': `${SITE_URL}/#org` },
                    ...(elo ? { description: `ELO ${elo}${rank ? `, Rank #${rank}` : ''}` } : {}),
                },
            },
            {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Home',   item: `${SITE_URL}/` },
                    { '@type': 'ListItem', position: 2, name: 'Racers', item: `${SITE_URL}/#racers` },
                    { '@type': 'ListItem', position: 3, name: name,     item: `${SITE_URL}/racers/${playerSlug}.html` },
                ],
            },
        ],
    };

    // ── TA records table ──
    let taHtml = '';
    if (carNames.length) {
        taHtml = `
        <table class="leaderboard-table ta-detail-table" style="width:100%">
            <colgroup><col style="width:22%"><col style="width:30%"><col style="width:18%"><col style="width:12%"><col style="width:18%"></colgroup>
            <thead><tr><th>CAR</th><th>COURSE</th><th>DIR</th><th>COND</th><th>TIME</th></tr></thead>
            <tbody>
            ${carNames.map(car => {
                const rows = taByCar[car];
                return `<tr class="ta-car-header-row"><td colspan="5" class="detail-car-name">${esc(car)}</td></tr>` +
                    rows.map(r => `<tr>
                        <td style="color:var(--muted);font-size:0.8em"></td>
                        <td>${r['Map'] ? `<a href="../courses/${slug(r['Map'])}.html" class="cp-player-link">${esc(r['Map'])}</a>` : '—'}</td>
                        <td style="color:var(--muted);font-size:0.8em">${esc(r['Direction'] ?? '—')}</td>
                        <td><span class="cond-badge cond-${String(r['Condition']||'').toLowerCase()}">${esc(r['Condition'] ?? '')}</span></td>
                        <td><span class="time-cell">${esc(r['Time'] ?? '—')}</span></td>
                    </tr>`).join('')
            }).join('')}
            </tbody>
        </table>`;
    } else {
        taHtml = `<p class="detail-empty">No time attack records on file.</p>`;
    }

    // ── Battle tables ──
    const h2hRows = h2h ? h2h.filter(r => r.opponent) : [];
    const courseRows = battle ? battle.courses.filter(c => c.name) : [];

    const h2hHtml = h2hRows.length ? `
        <div class="detail-section">
            <div class="detail-section-label">// HEAD TO HEAD</div>
            <table class="leaderboard-table">
                <thead><tr><th>OPPONENT</th><th>W</th><th>L</th><th>TOTAL</th><th>WIN%</th></tr></thead>
                <tbody>${h2hRows.map(r => `<tr>
                    <td>${esc(r.opponent)}</td>
                    <td style="color:var(--green)">${r.wins ?? '—'}</td>
                    <td style="color:var(--red)">${r.losses ?? '—'}</td>
                    <td>${r.total ?? '—'}</td>
                    <td style="color:var(--muted)">${fmtPct(r.winPct)}</td>
                </tr>`).join('')}</tbody>
            </table>
        </div>` : '';

    const courseHtml = courseRows.length ? `
        <div class="detail-section">
            <div class="detail-section-label">// BY COURSE</div>
            <table class="leaderboard-table">
                <thead><tr><th>COURSE</th><th>W</th><th>L</th><th>TOTAL</th><th>WIN%</th></tr></thead>
                <tbody>${courseRows.map(r => `<tr>
                    <td>${esc(r.name)}</td>
                    <td style="color:var(--green)">${r.wins ?? '—'}</td>
                    <td style="color:var(--orange)">${r.losses ?? '—'}</td>
                    <td>${r.total ?? '—'}</td>
                    <td style="color:var(--muted)">${fmtPct(r.winPct)}</td>
                </tr>`).join('')}</tbody>
            </table>
        </div>` : '';

    const noBattle = !h2hRows.length && !courseRows.length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(name)} — Initial D San Francisco</title>
    <meta name="description" content="${metaDesc}">
    <link rel="canonical" href="${SITE_URL}/racers/${playerSlug}.html">
    <meta property="og:type"        content="profile">
    <meta property="og:site_name"   content="Initial D San Francisco">
    <meta property="og:url"         content="${SITE_URL}/racers/${playerSlug}.html">
    <meta property="og:title"       content="${esc(name)} — Initial D San Francisco">
    <meta property="og:description" content="${metaDesc}">
    <meta property="og:image"       content="${ogImage}">
    <meta name="twitter:card"       content="summary_large_image">
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="../css/style.css">
    <link rel="icon" type="image/png" href="../favicon.png">
    <link rel="apple-touch-icon" href="../favicon.png">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-F6HVQ6WFF1"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-F6HVQ6WFF1');</script>
    <style>
        .rp-hero { padding: 3rem 0 2rem; }
        .rp-hero-inner { display:flex; align-items:center; gap:2rem; flex-wrap:wrap; }
        .rp-avatar, .rp-avatar-placeholder {
            width:120px; height:120px; border-radius:4px; object-fit:cover; flex-shrink:0;
        }
        .rp-avatar-placeholder {
            display:flex; align-items:center; justify-content:center;
            background:rgba(255,255,255,0.06); font-family:var(--font-display);
            font-size:2.5rem; color:var(--muted); border:1px solid rgba(255,255,255,0.1);
        }
        .rp-name { font-family:var(--font-display); font-size:clamp(3rem,8vw,5rem); letter-spacing:0.05em; line-height:1; }
        .rp-meta { font-family:var(--font-mono); font-size:0.78rem; color:var(--muted); letter-spacing:0.15em; margin-top:0.5rem; }
        .rp-meta span { color:var(--cyan); }
        .rp-back { font-family:var(--font-mono); font-size:0.75rem; letter-spacing:0.15em; color:var(--muted);
                   text-decoration:none; margin-bottom:1.5rem; display:inline-block; }
        .rp-back:hover { color:var(--orange); }
        .rp-two-col { display:grid; grid-template-columns:1fr 1fr; gap:2rem; }
        @media(max-width:640px) { .rp-two-col { grid-template-columns:1fr; } }
        .cp-player-link { color:var(--text); text-decoration:none; border-bottom:1px solid rgba(255,255,255,0.15); }
        .cp-player-link:hover { color:var(--orange); border-bottom-color:var(--orange); }
    </style>
</head>
<body>
    <div class="scanlines" aria-hidden="true"></div>
    <nav class="site-nav">
        <a href="../index.html" class="nav-logo">
            <img src="../Initial D San Francisco logo.png" alt="Initial D San Francisco" class="nav-logo-img" width="1920" height="1080">
        </a>
        <ul class="nav-links">
            <li><a href="../index.html">HOME</a></li>
            <li><a href="../videos.html">VIDEOS</a></li>
            <li><a href="../index.html#records">RECORDS</a></li>
            <li><a href="../courses.html">COURSES</a></li>
            <li><a href="../index.html#battles">BATTLES</a></li>
            <li><a href="../index.html#racers" class="nav-active">RACERS</a></li>
            <li><a href="../index.html#about">ABOUT</a></li>
            <li><a href="https://www.youtube.com/@InitialDSanFrancisco" target="_blank" rel="noopener" style="color:var(--orange)">YOUTUBE ↗</a></li>
        </ul>
        <button class="nav-toggle" aria-label="Toggle menu" aria-expanded="false">☰</button>
    </nav>

    <div class="dark-band">
        <section class="section rp-hero">
            <a href="../index.html#racers" class="rp-back">← BACK TO ROSTER</a>
            <div class="section-tag">// RACER PROFILE</div>
            <div class="rp-hero-inner">
                <div>${avatarHtml}</div>
                <div>
                    <div class="rp-name">${esc(name)}</div>
                    <div class="rp-meta" id="rp-meta">
                        ${rank ? `RANK <span>#${rank}</span> &nbsp;·&nbsp; ` : ''}
                        ${elo  ? `ELO <span>${elo}</span> &nbsp;·&nbsp; ` : ''}
                        ${battle?.overall ? `<span>${esc(battle.overall)}</span> &nbsp;·&nbsp; ` : ''}
                        ${streak ? `STREAK <span>${esc(streak)}</span>` : ''}
                    </div>
                </div>
            </div>
        </section>
    </div>

    <section class="section">
        <h2 class="detail-group-label" style="margin-bottom:1.5rem">TIME ATTACK RECORDS</h2>
        ${taHtml}
    </section>

    <div class="dark-band">
        <section class="section">
            <h2 class="detail-group-label" style="margin-bottom:1.5rem">BATTLE RECORDS</h2>
            <div id="rp-battle-body">${noBattle
                ? `<p class="detail-empty">No battle records on file.</p>`
                : `<div class="rp-two-col">${h2hHtml}${courseHtml}</div>`}</div>
        </section>
    </div>

    <section class="section" id="racer-videos-section">
        <h2 class="detail-group-label" style="margin-bottom:1.5rem">VIDEOS</h2>
        <div class="video-grid video-grid-large" id="racer-video-grid">
            <div class="loading">LOADING VIDEOS…</div>
        </div>
        <a href="../videos.html?player=${encodeURIComponent(name)}" class="cp-videos-link" style="margin-top:1.25rem;display:inline-block">
            VIEW ALL ${esc(name)} VIDEOS →
        </a>
    </section>

    <footer class="site-footer">
        <img src="../Initial D San Francisco logo.png" alt="Initial D San Francisco" class="footer-logo-img" width="1920" height="1080">
        <p>San Francisco, CA &nbsp;·&nbsp; Initial D Arcade Stage V3 &nbsp;·&nbsp;
           <a href="https://www.youtube.com/@InitialDSanFrancisco" target="_blank" rel="noopener" style="color:var(--orange);text-decoration:none">YouTube ↗</a></p>
    </footer>
    <script src="../data/videos.js"></script>
    <script src="../js/youtube.js"></script>
    <script src="../js/battle-engine.js"></script>
    <script>
    (function () {
        // ── Nav toggle ──────────────────────────────────────────
        var toggle = document.querySelector('.nav-toggle');
        var links  = document.querySelector('.nav-links');
        if (toggle && links) {
            toggle.addEventListener('click', function () {
                var open = links.classList.toggle('open');
                toggle.setAttribute('aria-expanded', open);
            });
            links.querySelectorAll('a').forEach(function (a) {
                a.addEventListener('click', function () {
                    links.classList.remove('open');
                    toggle.setAttribute('aria-expanded', 'false');
                });
            });
        }

        var PLAYER_NAME = ${JSON.stringify(name)};

        // One shared upload-list fetch: the video feed renders it, and the
        // battle refresh below uses it to decide which matches are public.
        var videosPromise = (typeof loadVideos === 'function')
            ? loadVideos().catch(function () { return null; })
            : Promise.resolve(null);

        // -- Racer video feed ------------------------------------
        // Uses word-boundary matching for pure alphanumeric names (e.g. HT)
        // so we don't false-positive on common words like "night", "right".
        var isAlphanumeric = /^[a-z0-9]+$/i.test(PLAYER_NAME);

        function matchesPlayer(title) {
            if (isAlphanumeric) {
                // Safe to interpolate directly - isAlphanumeric guarantees no regex special chars.
                // Capturing groups instead of lookbehind - Safari 16 and earlier don't support (?<!...)
                return new RegExp('(^|[^a-z0-9])' + PLAYER_NAME + '([^a-z0-9]|$)', 'i').test(title);
            }
            return title.toLowerCase().indexOf(PLAYER_NAME.toLowerCase()) !== -1;
        }

        var grid    = document.getElementById('racer-video-grid');
        var section = document.getElementById('racer-videos-section');

        videosPromise.then(function (result) {
            if (!result || result.status !== 'ok' || !result.videos || !result.videos.length) {
                grid.innerHTML = '';
                return;
            }
            var playerVideos = result.videos.filter(function (v) {
                return v.title && matchesPlayer(v.title);
            }).slice(0, 12);

            if (!playerVideos.length) {
                grid.innerHTML = '';
                section.style.display = 'none';
                return;
            }

            grid.innerHTML = playerVideos.map(function (v) {
                var thumb   = v.thumbnail || 'https://img.youtube.com/vi/' + v.id + '/hqdefault.jpg';
                var dateStr = v.date
                    ? new Date(v.date).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' })
                    : '';
                var titleEsc = v.title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                return '<a class="video-card" href="https://youtube.com/watch?v=' + v.id +
                    '" target="_blank" rel="noopener">' +
                    '<div class="video-thumb"><img src="' + thumb + '" alt="" loading="lazy"></div>' +
                    '<div class="video-info">' +
                    '<div class="video-title">' + titleEsc + '</div>' +
                    (dateStr ? '<div class="video-meta"><span class="video-date">' + dateStr + '</span></div>' : '') +
                    '</div></a>';
            }).join('');
        }).catch(function () {
            grid.innerHTML = '';
        });

        // -- Live battle stats -----------------------------------
        // The rank / ELO / record above and the tables below are a deploy-time
        // snapshot, gated to videos that were public when the site was built.
        // Videos keep publishing between deploys, so re-derive from the Elo
        // calc tab on load and repaint. Deploys stay optional; the numbers
        // still never include a battle whose video hasn't gone live.
        var SHEET_ID     = ${JSON.stringify(SHEET_ID)};
        var CALC_GID     = ${JSON.stringify(ELO_CALC_GID)};
        var COURSE_ORDER = ${JSON.stringify(COURSE_ORDER)};

        function fetchCalcTab() {
            return new Promise(function (resolve) {
                var cb = '_rp_gviz_' + Math.random().toString(36).slice(2);
                var el;
                function cleanup() { delete window[cb]; if (el) el.remove(); }
                var timer = setTimeout(function () { cleanup(); resolve(null); }, 10000);

                window[cb] = function (response) {
                    clearTimeout(timer);
                    cleanup();
                    var table = response && response.table;
                    if (!table) { resolve(null); return; }
                    var cols = table.cols.map(function (c) {
                        var label = (c.label || '').trim();
                        if (label.length > 25) return label.split(/\s+/).pop() || c.id;
                        return label || c.id;
                    });
                    resolve(table.rows.filter(function (r) {
                        return r.c && r.c.some(function (c) { return c && c.v != null; });
                    }).map(function (r) {
                        var o = {};
                        r.c.forEach(function (c, i) { o[cols[i]] = c ? c.v : null; });
                        return o;
                    }));
                };

                el = document.createElement('script');
                el.id = cb;
                el.onerror = function () { clearTimeout(timer); cleanup(); resolve(null); };
                el.src = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
                         '/gviz/tq?tqx=out:json;responseHandler:' + cb + '&gid=' + CALC_GID;
                document.head.appendChild(el);
            });
        }

        function escapeHtml(s) {
            return String(s == null ? '' : s)
                .replace(/&/g,'&amp;').replace(/</g,'&lt;')
                .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function pct(v) { return (v * 100).toFixed(1) + '%'; }

        function statTable(label, keyName, rows, lossColour) {
            return '<div class="detail-section">' +
                '<div class="detail-section-label">// ' + label + '</div>' +
                '<table class="leaderboard-table"><thead><tr>' +
                '<th>' + keyName + '</th><th>W</th><th>L</th><th>TOTAL</th><th>WIN%</th>' +
                '</tr></thead><tbody>' +
                rows.map(function (r) {
                    return '<tr><td>' + escapeHtml(r.key) + '</td>' +
                        '<td style="color:var(--green)">' + r.wins + '</td>' +
                        '<td style="color:' + lossColour + '">' + r.losses + '</td>' +
                        '<td>' + r.total + '</td>' +
                        '<td style="color:var(--muted)">' + pct(r.winPct) + '</td></tr>';
                }).join('') +
                '</tbody></table></div>';
        }

        function findByName(obj, key) {
            var hit = null;
            Object.keys(obj).forEach(function (n) {
                if (BattleEngine.normName(n) === key) hit = obj[n];
            });
            return hit;
        }

        if (typeof BattleEngine !== 'undefined') {
            Promise.all([fetchCalcTab(), videosPromise]).then(function (res) {
                var rows = res[0], ytResult = res[1];
                if (!rows || !rows.length) return;   // keep the build-time snapshot

                var videos    = (ytResult && ytResult.videos) || [];
                var published = BattleEngine.splitByPublished(
                    BattleEngine.parseMatches(rows),
                    { publishedIds: BattleEngine.publishedIdsFrom(videos) }
                ).published;
                if (!published.length) return;

                var key  = BattleEngine.normName(PLAYER_NAME);
                var mine = BattleEngine.deriveStandings(published).filter(function (s) {
                    return BattleEngine.normName(s.racer) === key;
                })[0];
                if (!mine) return;   // no published battles for this racer yet

                var mineByCourse = findByName(BattleEngine.deriveByCourse(published, COURSE_ORDER), key);
                var mineH2H      = findByName(BattleEngine.deriveHeadToHead(published), key);

                var meta = document.getElementById('rp-meta');
                if (meta) {
                    var bits = ['RANK <span>#' + mine.rank + '</span>'];
                    if (mine.elo != null) bits.push('ELO <span>' + mine.elo.toFixed(2) + '</span>');
                    bits.push('<span>' + mine.wins + 'W ' + mine.losses + 'L (' +
                              pct(mine.winPct) + ' overall)</span>');
                    if (mine.streak) bits.push('STREAK <span>' + escapeHtml(mine.streak) + '</span>');
                    meta.innerHTML = bits.join(' &nbsp;&middot;&nbsp; ');
                }

                var body = document.getElementById('rp-battle-body');
                if (body) {
                    var tables = '';
                    if (mineH2H && mineH2H.length) {
                        tables += statTable('HEAD TO HEAD', 'OPPONENT', mineH2H.map(function (r) {
                            return { key: r.opponent, wins: r.wins, losses: r.losses, total: r.total, winPct: r.winPct };
                        }), 'var(--red)');
                    }
                    if (mineByCourse && mineByCourse.courses.length) {
                        tables += statTable('BY COURSE', 'COURSE', mineByCourse.courses.map(function (r) {
                            return { key: r.name, wins: r.wins, losses: r.losses, total: r.total, winPct: r.winPct };
                        }), 'var(--orange)');
                    }
                    body.innerHTML = tables
                        ? '<div class="rp-two-col">' + tables + '</div>'
                        : '<p class="detail-empty">No battle records on file.</p>';
                }
            }).catch(function () { /* snapshot stands */ });
        }

    })();
    </script>
</body>
</html>`;
}

/* ── Generate courses index page (courses.html) ──────────────────────────── */
function generateCoursesIndex(taRecords, matches) {
    const cards = COURSE_ORDER.map(course => {
        const imgFile = COURSE_IMAGES[course];
        const s       = slug(course);

        const taCount     = [...new Set(
            taRecords.filter(r => r['Map'] === course).map(r =>
                `${r['Identity']||r['Player Tag']||''}|${r['Car_clean']||r['Car']||''}|${r['Direction']}|${r['Condition']}`
            )
        )].length;
        // Published matches only — a scheduled upload shouldn't bump the count
        const battleCount = matches.filter(m =>
            BattleEngine.normName(m.course) === BattleEngine.normName(course)
        ).length;
        const fastest = taRecords
            .filter(r => r['Map'] === course && (r['Time_ms'] || r['Time']))
            .sort((a, b) => timeToMs(a) - timeToMs(b))[0];

        return `
        <a class="ci-card" href="courses/${s}.html">
            <div class="ci-card-img-wrap">
                ${imgFile
                    ? `<img src="${esc(imgFile)}" alt="${esc(course)} course map" class="ci-card-img" loading="lazy">`
                    : `<div class="ci-card-img-placeholder">—</div>`}
            </div>
            <div class="ci-card-body">
                <div class="ci-card-name">${esc(course)}</div>
                <div class="ci-card-stats">
                    <span>${taCount} TA record${taCount !== 1 ? 's' : ''}</span>
                    <span>${battleCount} battle${battleCount !== 1 ? 's' : ''}</span>
                </div>
                ${fastest
                    ? `<div class="ci-card-cr">
                           <span class="ci-cr-label">CR</span>
                           ${esc(fastest['Identity'] || fastest['Player Tag'] || fastest['Tag_clean'] || '?')}
                           · ${esc(fastest['Time'] || '')}
                       </div>`
                    : ''}
            </div>
        </a>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Courses — Initial D San Francisco</title>
    <meta name="description" content="All Initial D Arcade Stage Version 3 courses — time attack records and battle history for each stage, SF Bay Area community.">
    <link rel="canonical" href="${SITE_URL}/courses.html">
    <meta property="og:type"        content="website">
    <meta property="og:site_name"   content="Initial D San Francisco">
    <meta property="og:url"         content="${SITE_URL}/courses.html">
    <meta property="og:title"       content="Courses — Initial D San Francisco">
    <meta property="og:description" content="All Initial D Arcade Stage Version 3 courses — time attack records and battle history for each stage.">
    <meta property="og:image"       content="${SITE_URL}/squad.jpg">
    <meta name="twitter:card"       content="summary_large_image">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="css/style.css">
    <link rel="icon" type="image/png" href="favicon.png">
    <link rel="apple-touch-icon" href="favicon.png">
    <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type'      : 'CollectionPage',
                '@id'        : `${SITE_URL}/courses.html`,
                url          : `${SITE_URL}/courses.html`,
                name         : 'Courses — Initial D San Francisco',
                description  : 'All Initial D Arcade Stage Version 3 courses — time attack records and battle history for each stage, SF Bay Area community.',
                isPartOf     : { '@id': `${SITE_URL}/#website` },
            },
            {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Home',    item: `${SITE_URL}/` },
                    { '@type': 'ListItem', position: 2, name: 'Courses', item: `${SITE_URL}/courses.html` },
                ],
            },
        ],
    })}</script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-F6HVQ6WFF1"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-F6HVQ6WFF1');</script>
    <style>
        .ci-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
            gap: 1.5rem;
            margin-top: 1.5rem;
        }
        .ci-card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 4px;
            text-decoration: none;
            color: var(--text);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            transition: border-color 0.2s, transform 0.2s;
            position: relative;
        }
        .ci-card::before {
            content: '';
            position: absolute;
            inset: 0 0 auto 0;
            height: 2px;
            background: var(--orange);
            transform: scaleX(0);
            transform-origin: left;
            transition: transform 0.2s;
        }
        .ci-card:hover { border-color: var(--orange); transform: translateY(-3px); }
        .ci-card:hover::before { transform: scaleX(1); }
        .ci-card-img-wrap {
            width: 100%;
            aspect-ratio: 4/3;
            background: var(--surface2);
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .ci-card-img { width: 100%; height: 100%; object-fit: contain; object-position: center; padding: 1rem; opacity: 0.85; transition: opacity 0.2s; }
        .ci-card:hover .ci-card-img { opacity: 1; }
        .ci-card-img-placeholder { color: var(--muted); font-family: var(--font-mono); font-size: 2rem; }
        .ci-card-body { padding: 1rem 1.1rem 1.25rem; }
        .ci-card-name { font-family: var(--font-display); font-size: 2rem; letter-spacing: 0.06em; line-height: 1; margin-bottom: 0.5rem; text-transform: uppercase; }
        .ci-card-stats { font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted); letter-spacing: 0.08em; display: flex; gap: 1rem; margin-bottom: 0.5rem; }
        .ci-card-cr { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text); letter-spacing: 0.06em; }
        .ci-cr-label { color: var(--orange); margin-right: 0.35rem; }
    </style>
</head>
<body>
    <div class="scanlines" aria-hidden="true"></div>
    <nav class="site-nav">
        <a href="index.html" class="nav-logo">
            <img src="Initial D San Francisco logo.png" alt="Initial D San Francisco" class="nav-logo-img" width="1920" height="1080">
        </a>
        <ul class="nav-links" id="nav-links">
            <li><a href="index.html">HOME</a></li>
            <li><a href="videos.html">VIDEOS</a></li>
            <li><a href="index.html#records">RECORDS</a></li>
            <li><a href="courses.html" class="nav-active">COURSES</a></li>
            <li><a href="index.html#battles">BATTLES</a></li>
            <li><a href="index.html#racers">RACERS</a></li>
            <li><a href="index.html#about">ABOUT</a></li>
            <li><a href="https://www.youtube.com/@InitialDSanFrancisco" target="_blank" rel="noopener" style="color:var(--orange)">YOUTUBE ↗</a></li>
        </ul>
        <button class="nav-toggle" id="nav-toggle" aria-label="Toggle menu" aria-expanded="false">☰</button>
    </nav>

    <div class="page-hero">
        <div class="page-hero-inner">
            <div class="section-tag">// INITIAL D ARCADE STAGE V3</div>
            <h1 class="page-hero-title">COURSE <span class="accent-orange">DIRECTORY</span></h1>
        </div>
    </div>

    <section class="section">
        <div class="ci-grid">${cards}</div>
    </section>

    <footer class="site-footer">
        <img src="Initial D San Francisco logo.png" alt="Initial D San Francisco" class="footer-logo-img" width="1920" height="1080">
        <p>San Francisco, CA &nbsp;·&nbsp; Initial D Arcade Stage V3 &nbsp;·&nbsp;
           <a href="https://www.youtube.com/@InitialDSanFrancisco" target="_blank" rel="noopener" style="color:var(--orange);text-decoration:none">YouTube ↗</a></p>
    </footer>
    <script>
    (function () {
        var toggle = document.getElementById('nav-toggle');
        var links  = document.getElementById('nav-links');
        if (!toggle || !links) return;
        toggle.addEventListener('click', function () {
            var open = links.classList.toggle('open');
            toggle.setAttribute('aria-expanded', open);
        });
        links.querySelectorAll('a').forEach(function (a) {
            a.addEventListener('click', function () {
                links.classList.remove('open');
                toggle.setAttribute('aria-expanded', 'false');
            });
        });
    })();
    </script>
</body>
</html>`;
}

/* ── Generate one course page ────────────────────────────────────────────── */
function generateCoursePage(courseName, taRecords, matches, racers) {
    // Canonical roster names by normalised form — guests (CAL, MJ, KAY, …) have
    // no racer page, so their names must render as plain text, not dead links.
    const racerByNorm = new Map((racers || []).map(r => [norm(r.name), r.name]));
    const courseSlug_ = slug(courseName);
    const imgFile     = COURSE_IMAGES[courseName];
    const imgSrc      = imgFile ? `../${imgFile}` : null;
    const ogImage     = imgFile ? `${SITE_URL}/${imgFile}` : `${SITE_URL}/squad.jpg`;

    // ── TA records: dedup best per player+car+dir+cond ──
    let courseTA = taRecords.filter(r => r['Map'] === courseName);
    courseTA.sort((a, b) => timeToMs(a) - timeToMs(b));
    const seen = new Set();
    courseTA = courseTA.filter(r => {
        const player = r['Identity'] || r['Player Tag'] || r['Tag_clean'] || '';
        const car    = r['Car_clean'] || r['Car'] || '';
        const key    = `${player}|${car}|${r['Direction']}|${r['Condition']}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Group by direction → condition, canonical order
    const byDir = {};
    courseTA.forEach(r => {
        const dir  = r['Direction'] || 'Unknown';
        const cond = r['Condition'] || 'Unknown';
        if (!byDir[dir]) byDir[dir] = {};
        if (!byDir[dir][cond]) byDir[dir][cond] = [];
        byDir[dir][cond].push(r);
    });
    const sortedDirs = Object.keys(byDir).sort(
        (a, b) => (DIR_ORDER.indexOf(a) + 1 || 999) - (DIR_ORDER.indexOf(b) + 1 || 999)
    );

    // ── Aggregated battle standings for this course ──
    // Derived from the published matches, so a scheduled upload's result never
    // shows up here early. Already sorted by wins, then win rate.
    const courseStandings = BattleEngine.deriveCourseStandings(matches, courseName);

    const metaDesc = `Time attack records and battle history for ${courseName} in Initial D Arcade Stage Version 3 — SF Bay Area community.`;

    const jsonLd = {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type'      : 'WebPage',
                '@id'        : `${SITE_URL}/courses/${courseSlug_}.html`,
                url          : `${SITE_URL}/courses/${courseSlug_}.html`,
                name         : `${courseName} — Initial D San Francisco`,
                description  : metaDesc,
                isPartOf     : { '@id': `${SITE_URL}/#website` },
            },
            {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Home',    item: `${SITE_URL}/` },
                    { '@type': 'ListItem', position: 2, name: 'Records', item: `${SITE_URL}/#records` },
                    { '@type': 'ListItem', position: 3, name: courseName, item: `${SITE_URL}/courses/${courseSlug_}.html` },
                ],
            },
        ],
    };

    // ── TA HTML ──
    let taHtml = '';
    if (sortedDirs.length) {
        taHtml = sortedDirs.map(dir => {
            const condMap     = byDir[dir];
            const sortedConds = Object.keys(condMap).sort(
                (a, b) => (COND_ORDER.indexOf(a) + 1 || 999) - (COND_ORDER.indexOf(b) + 1 || 999)
            );
            return sortedConds.map(cond => {
                const records = condMap[cond];
                return `
                <div class="cp-section">
                    <div class="cp-section-header">
                        <span class="cp-dir">${esc(dir.toUpperCase())}</span>
                        <span class="cond-badge cond-${cond.toLowerCase()}">${esc(cond)}</span>
                    </div>
                    <table class="leaderboard-table">
                        <thead><tr><th>RANK</th><th>PLAYER</th><th>CAR</th><th>TIME</th></tr></thead>
                        <tbody>
                        ${records.map((r, i) => {
                            const identity  = r['Identity'] || r['Player Tag'] || r['Tag_clean'] || '—';
                            const canonical = racerByNorm.get(norm(identity));
                            const playerCell = canonical
                                ? `<a href="../racers/${slug(canonical)}.html" class="cp-player-link"><strong>${esc(identity)}</strong></a>`
                                : `<strong>${esc(identity)}</strong>`;
                            return `<tr>
                                <td><span class="rank-badge rank-${i + 1}">${i + 1}</span></td>
                                <td>${playerCell}</td>
                                <td style="color:var(--muted);font-size:0.88em">${esc(r['Car_clean'] || r['Car'] || '—')}</td>
                                <td><span class="time-cell">${esc(r['Time'] || '—')}</span></td>
                            </tr>`;
                        }).join('')}
                        </tbody>
                    </table>
                </div>`;
            }).join('');
        }).join('');
    } else {
        taHtml = `<p class="detail-empty">No time attack records on file for ${esc(courseName)}.</p>`;
    }

    // ── Battle standings HTML ──
    let battleHtml = '';
    if (courseStandings.length) {
        battleHtml = `
        <table class="leaderboard-table">
            <thead><tr>
                <th>RANK</th><th>PLAYER</th><th>W</th><th>L</th><th>TOTAL</th><th>WIN%</th>
            </tr></thead>
            <tbody>
            ${courseStandings.map((r, i) => `<tr>
                <td><span class="rank-badge rank-${i + 1}">${i + 1}</span></td>
                <td>${racerByNorm.has(norm(r.name))
                    ? `<a href="../racers/${slug(racerByNorm.get(norm(r.name)))}.html" class="cp-player-link"><strong>${esc(r.name)}</strong></a>`
                    : `<strong>${esc(r.name)}</strong>`}</td>
                <td style="color:var(--green)">${r.wins ?? '—'}</td>
                <td style="color:var(--red)">${r.losses ?? '—'}</td>
                <td>${r.total ?? '—'}</td>
                <td style="color:var(--muted)">${fmtPct(r.winPct)}</td>
            </tr>`).join('')}
            </tbody>
        </table>`;
    } else {
        battleHtml = `<p class="detail-empty">No battle records on file for ${esc(courseName)}.</p>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(courseName)} — Initial D San Francisco</title>
    <meta name="description" content="${metaDesc}">
    <link rel="canonical" href="${SITE_URL}/courses/${courseSlug_}.html">
    <meta property="og:type"        content="website">
    <meta property="og:site_name"   content="Initial D San Francisco">
    <meta property="og:url"         content="${SITE_URL}/courses/${courseSlug_}.html">
    <meta property="og:title"       content="${esc(courseName)} — Initial D San Francisco">
    <meta property="og:description" content="${metaDesc}">
    <meta property="og:image"       content="${ogImage}">
    <meta name="twitter:card"       content="summary_large_image">
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="../css/style.css">
    <link rel="icon" type="image/png" href="../favicon.png">
    <link rel="apple-touch-icon" href="../favicon.png">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-F6HVQ6WFF1"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-F6HVQ6WFF1');</script>
    <style>
        .cp-hero { padding: 0; overflow: hidden; position: relative; min-height: 280px; display:flex; align-items:flex-end; }
        .cp-hero-img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; object-position:center; opacity:0.25; }
        .cp-hero-content { position:relative; z-index:1; padding:2.5rem 0; width:100%; }
        .cp-course-name { font-family:var(--font-display); font-size:clamp(3.5rem,10vw,7rem); letter-spacing:0.05em; line-height:1; text-transform:uppercase; }
        .cp-back { font-family:var(--font-mono); font-size:0.75rem; letter-spacing:0.15em; color:var(--muted); text-decoration:none; margin-bottom:1rem; display:inline-block; }
        .cp-back:hover { color:var(--orange); }
        .cp-section { margin-bottom:2.5rem; }
        .cp-section-header { display:flex; align-items:center; gap:1rem; margin-bottom:1rem; padding-bottom:0.5rem; border-bottom:1px solid var(--border); }
        .cp-dir { font-family:var(--font-mono); font-size:0.85rem; letter-spacing:0.12em; color:var(--cyan); }
        .cp-player-link { color:var(--text); text-decoration:none; }
        .cp-player-link:hover { color:var(--orange); }
        .cp-videos-link { display:inline-block; margin-top:0.5rem; font-family:var(--font-mono); font-size:0.78rem; letter-spacing:0.1em; color:var(--cyan); text-decoration:none; opacity:0.8; transition:opacity 0.15s,color 0.15s; }
        .cp-videos-link:hover { opacity:1; color:var(--orange); }
    </style>
</head>
<body>
    <div class="scanlines" aria-hidden="true"></div>
    <nav class="site-nav">
        <a href="../index.html" class="nav-logo">
            <img src="../Initial D San Francisco logo.png" alt="Initial D San Francisco" class="nav-logo-img" width="1920" height="1080">
        </a>
        <ul class="nav-links">
            <li><a href="../index.html">HOME</a></li>
            <li><a href="../videos.html">VIDEOS</a></li>
            <li><a href="../index.html#records">RECORDS</a></li>
            <li><a href="../courses.html" class="nav-active">COURSES</a></li>
            <li><a href="../index.html#battles">BATTLES</a></li>
            <li><a href="../index.html#racers">RACERS</a></li>
            <li><a href="../index.html#about">ABOUT</a></li>
            <li><a href="https://www.youtube.com/@InitialDSanFrancisco" target="_blank" rel="noopener" style="color:var(--orange)">YOUTUBE ↗</a></li>
        </ul>
        <button class="nav-toggle" aria-label="Toggle menu" aria-expanded="false">☰</button>
    </nav>

    <div class="dark-band">
        <section class="section cp-hero">
            ${imgSrc ? `<img class="cp-hero-img" src="${esc(imgSrc)}" alt="${esc(courseName)} course map">` : ''}
            <div class="cp-hero-content">
                <a href="../index.html#records" class="cp-back">← BACK TO RECORDS</a>
                <div class="section-tag">// INITIAL D ARCADE STAGE V3 · COURSE</div>
                <div class="cp-course-name">${esc(courseName)}</div>
            </div>
        </section>
    </div>

    <section class="section">
        <h2 class="detail-group-label" style="margin-bottom:1.5rem">TIME ATTACK RECORDS</h2>
        ${taHtml}
    </section>

    <div class="dark-band">
        <section class="section">
            <h2 class="detail-group-label" style="margin-bottom:1.5rem">BATTLE STANDINGS</h2>
            ${battleHtml}
        </section>
    </div>

    <section class="section" id="course-videos-section">
        <h2 class="detail-group-label" style="margin-bottom:1.5rem">VIDEOS</h2>
        <div class="video-grid video-grid-large" id="course-video-grid">
            <div class="loading">LOADING VIDEOS…</div>
        </div>
        <a href="../videos.html?course=${encodeURIComponent(courseName)}" class="cp-videos-link" style="margin-top:1.25rem;display:inline-block">
            VIEW ALL ${esc(courseName.toUpperCase())} VIDEOS →
        </a>
    </section>

    <footer class="site-footer">
        <img src="../Initial D San Francisco logo.png" alt="Initial D San Francisco" class="footer-logo-img" width="1920" height="1080">
        <p>San Francisco, CA &nbsp;·&nbsp; Initial D Arcade Stage V3 &nbsp;·&nbsp;
           <a href="https://www.youtube.com/@InitialDSanFrancisco" target="_blank" rel="noopener" style="color:var(--orange);text-decoration:none">YouTube ↗</a></p>
    </footer>
    <script src="../data/videos.js"></script>
    <script src="../js/youtube.js"></script>
    <script>
    (function () {
        // ── Nav toggle ──────────────────────────────────────────
        var toggle = document.querySelector('.nav-toggle');
        var links  = document.querySelector('.nav-links');
        if (toggle && links) {
            toggle.addEventListener('click', function () {
                var open = links.classList.toggle('open');
                toggle.setAttribute('aria-expanded', open);
            });
            links.querySelectorAll('a').forEach(function (a) {
                a.addEventListener('click', function () {
                    links.classList.remove('open');
                    toggle.setAttribute('aria-expanded', 'false');
                });
            });
        }

        // ── Course video feed ───────────────────────────────────
        var COURSE_NAME = ${JSON.stringify(courseName)};
        var grid        = document.getElementById('course-video-grid');
        if (typeof loadVideos !== 'function') { grid.innerHTML = ''; return; }

        loadVideos().then(function (result) {
            if (result.status !== 'ok' || !result.videos || !result.videos.length) {
                grid.innerHTML = '';
                return;
            }
            var courseVideos = result.videos.filter(function (v) {
                return v.title && v.title.toLowerCase().includes(COURSE_NAME.toLowerCase());
            }).slice(0, 12);

            if (!courseVideos.length) {
                grid.innerHTML = '';
                return;
            }

            grid.innerHTML = courseVideos.map(function (v) {
                var thumb   = v.thumbnail || 'https://img.youtube.com/vi/' + v.id + '/hqdefault.jpg';
                var dateStr = v.date
                    ? new Date(v.date).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' })
                    : '';
                var titleEsc = v.title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                return '<a class="video-card" href="https://youtube.com/watch?v=' + v.id +
                    '" target="_blank" rel="noopener">' +
                    '<div class="video-thumb"><img src="' + thumb + '" alt="" loading="lazy"></div>' +
                    '<div class="video-info">' +
                    '<div class="video-title">' + titleEsc + '</div>' +
                    (dateStr ? '<div class="video-meta"><span class="video-date">' + dateStr + '</span></div>' : '') +
                    '</div></a>';
            }).join('');
        }).catch(function () {
            grid.innerHTML = '';
        });
    })();
    </script>
</body>
</html>`;
}

/* ── Regenerate sitemap.xml ───────────────────────────────────────────────── */
function writeSitemap(racerSlugs, courseSlugs = []) {
    const today = new Date().toISOString().slice(0, 10);
    const urls  = [
        { loc: `${SITE_URL}/`,              priority: '1.0' },
        { loc: `${SITE_URL}/videos.html`,  priority: '0.8' },
        { loc: `${SITE_URL}/courses.html`, priority: '0.9' },
        ...courseSlugs.map(s => ({ loc: `${SITE_URL}/courses/${s}.html`, priority: '0.8' })),
        ...racerSlugs.map(s =>  ({ loc: `${SITE_URL}/racers/${s}.html`,  priority: '0.7' })),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `    <url>
        <loc>${u.loc}</loc>
        <lastmod>${today}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>${u.priority}</priority>
    </url>`).join('\n')}
</urlset>\n`;
    fs.writeFileSync(path.join(__dirname, 'sitemap.xml'), xml);
    console.log(`[build] sitemap.xml updated (${urls.length} URLs)`);
}

/* ── HTML marker injection ───────────────────────────────────────────────── */
function courseSort(a, b) {
    return (COURSE_ORDER.indexOf(a) + 1 || 999) - (COURSE_ORDER.indexOf(b) + 1 || 999);
}
function taPlayerName(row) {
    return (row['Identity'] || row['Tag_clean'] || row['Player Tag'] || '').trim();
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════════════════ */
/* -- Static data snapshot ------------------------------------------------- */
// The site reads every stat from docs.google.com at runtime via JSONP. Networks
// that block Google Workspace (a common corporate DLP rule) therefore render the
// whole site statless. Mirroring the sheets to a same-origin JSON file gives the
// client something to fall back to that no proxy can intercept.
function writeSnapshot(entries) {
    const file = path.join(__dirname, 'data', 'snapshot.json');

    let previous = {};
    try {
        previous = JSON.parse(fs.readFileSync(file, 'utf8')).sheets || {};
    } catch (e) { /* no snapshot yet, or it was never committed */ }

    // Sheets carry the spreadsheet's full used range, so trailing columns that are
    // empty in every row (M..AE on the TA tab) ride along as pure padding. Nothing
    // can read a column that is null in every row, so drop them.
    const prune = rows => {
        const live = new Set();
        for (const row of rows) {
            for (const k in row) {
                const v = row[k];
                if (v !== null && v !== undefined && v !== '') live.add(k);
            }
        }
        return rows.map(row => {
            const out = {};
            for (const k of live) if (k in row) out[k] = row[k];
            return out;
        });
    };

    const sheets = {};
    const stale  = [];
    for (const { gid, rows } of entries) {
        if (rows && rows.length) { sheets[gid] = prune(rows); continue; }
        // Never let a failed fetch blank out a good snapshot. A transient Google
        // hiccup during one deploy would otherwise ship an empty fallback to
        // precisely the visitors who depend on it.
        if (previous[gid] && previous[gid].length) {
            sheets[gid] = previous[gid];
            stale.push(gid);
        }
    }

    if (!Object.keys(sheets).length) {
        console.warn('[build] snapshot: no sheet data available, leaving data/snapshot.json untouched');
        return;
    }
    if (stale.length) {
        console.warn(`[build] snapshot: kept previous rows for gid ${stale.join(', ')} (fetch failed or empty)`);
    }

    fs.writeFileSync(file, JSON.stringify({ generated: new Date().toISOString(), sheets }));
    const counts = Object.entries(sheets).map(([g, r]) => `${g}:${r.length}`).join(' ');
    const kb     = (fs.statSync(file).size / 1024).toFixed(0);
    console.log(`[build] data/snapshot.json ${kb} KB (${counts})`);
}

async function main() {
    console.log('[build] Fetching data sources…');

    writeYouTubeConfigIfEnvSet();
    const { apiKey, channelId } = readYouTubeConfig();
    const racers = readRacers();
    console.log(`[build] RACERS array: ${racers.length} players`);

    // The first SNAPSHOT_SHEETS.length entries must stay aligned with
    // SNAPSHOT_SHEETS so writeSnapshot() can pair results back to their gid.
    const sheetLabels = ['TA records', 'Elo calc tab', 'battle log', 'YouTube'];
    const results = await Promise.allSettled([
        fetchSheet(LEADERBOARD_GID),
        fetchSheet(ELO_CALC_GID),
        fetchSheet(BATTLE_LOG_GID),
        (apiKey && channelId)
            ? fetchYouTubeVideos(apiKey, channelId)
            : Promise.resolve([]),
    ]);

    const [taRecords, calcRows, battleLogRows, ytVideos] = results.map((r, i) => {
        if (r.status === 'rejected') {
            console.warn(`[build] ${sheetLabels[i]} fetch failed: ${r.reason?.message ?? r.reason}`);
            return [];
        }
        return r.value;
    });

    writeSnapshot(SNAPSHOT_SHEETS.map((gid, i) => ({
        gid,
        rows: results[i].status === 'fulfilled' ? results[i].value : null,
    })));

    console.log(`[build] TA: ${taRecords.length} rows, Elo calc: ${calcRows.length} matches, Videos: ${ytVideos.length}`);

    // ── Battle stats: published matches only ───────────────────────────────
    // The battle log holds matches whose videos are still scheduled. Aggregating
    // all of them (as the Apps Script standings sheet does) spoils every pending
    // upload, so everything below is derived from the published subset instead.
    const allMatches = BattleEngine.parseMatches(calcRows);

    const outOfOrder = BattleEngine.checkChainOrder(allMatches);
    if (outOfOrder.length) {
        console.warn(`[build] WARNING: Elo calc tab is not date-ascending at rows ${outOfOrder.join(', ')}. ` +
            `The publish cut assumes chronological rows — ratings may read from an incomplete chain.`);
    }

    const { published: matches, withheld } = BattleEngine.splitByPublished(allMatches, {
        publishedIds: BattleEngine.publishedIdsFrom(ytVideos),
    });
    console.log(`[build] Battles: ${matches.length} published, ${withheld.length} awaiting upload (excluded)`);

    const battleStandings = BattleEngine.deriveStandings(matches);
    const battleStats     = BattleEngine.deriveByCourse(matches, COURSE_ORDER);
    const headToHead      = BattleEngine.deriveHeadToHead(matches);

    const knownPlayers = [...new Set([
        ...battleStandings.map(r => r.racer).filter(Boolean),
        ...taRecords.map(taPlayerName).filter(n => n && n.length <= 10),
    ])].sort();

    // ── Shared schema ──────────────────────────────────────────────────────
    const orgSchema = {
        '@type': 'SportsOrganization', '@id': `${SITE_URL}/#org`,
        name: 'Initial D San Francisco', url: SITE_URL, sport: 'Racing',
        description: 'Time attack records, battle standings, and race footage from a group of Initial D Arcade Stage Version 3 players in the SF Bay Area.',
        member: knownPlayers.map(name => ({ '@type': 'Person', name })),
    };
    const siteSchema = {
        '@type': 'WebSite', '@id': `${SITE_URL}/#website`,
        url: SITE_URL, name: 'Initial D San Francisco',
        description: 'Initial D Arcade Stage Version 3 time attack records and battle standings — SF Bay Area.',
        publisher: { '@id': `${SITE_URL}/#org` },
    };

    // ══════════════════════════════════════════════════════════════════
    //  index.html
    // ══════════════════════════════════════════════════════════════════
    const courses   = [...new Set(taRecords.map(r => r['Map']).filter(Boolean))].sort(courseSort);
    const indexJsonLd = { '@context': 'https://schema.org', '@graph': [orgSchema, siteSchema] };

    let indexNS = `<noscript>\n<div id="prerender-content" style="display:none" aria-hidden="true">\n`;
    indexNS += `<section><h2>Battle Standings — Initial D Arcade Stage Version 3</h2>\n<table><thead><tr><th>Rank</th><th>Player</th><th>ELO</th><th>Wins</th><th>Losses</th><th>Win %</th></tr></thead><tbody>\n`;
    battleStandings.forEach(r => {
        if (!r.racer) return;
        indexNS += `<tr><td>${r.rank}</td><td>${esc(r.racer)}</td><td>${r.elo == null ? '' : r.elo.toFixed(2)}</td><td>${r.wins}</td><td>${r.losses}</td><td>${(r.winPct*100).toFixed(1)}%</td></tr>\n`;
    });
    indexNS += `</tbody></table></section>\n<section><h2>Time Attack Records — Initial D Arcade Stage Version 3</h2>\n`;
    for (const course of courses) {
        const recs = taRecords.filter(r => r['Map'] === course);
        if (!recs.length) continue;
        indexNS += `<h3>${course}</h3>\n<table><thead><tr><th>Player</th><th>Direction</th><th>Condition</th><th>Car</th><th>Time</th></tr></thead><tbody>\n`;
        recs.forEach(r => {
            const name = taPlayerName(r);
            if (!name || !r['Time']) return;
            indexNS += `<tr><td>${name}</td><td>${r['Direction']??''}</td><td>${r['Condition']??''}</td><td>${r['Car']??''}</td><td>${r['Time']}</td></tr>\n`;
        });
        indexNS += `</tbody></table>\n`;
    }
    indexNS += `</section>\n</div>\n</noscript>`;

    let indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    indexHtml = injectMarker(indexHtml, 'JSONLD',   `<script type="application/ld+json">\n${JSON.stringify(indexJsonLd, null, 2)}\n</script>`);
    indexHtml = injectMarker(indexHtml, 'NOSCRIPT', indexNS);
    fs.writeFileSync(path.join(__dirname, 'index.html'), indexHtml);
    console.log('[build] index.html ✓');

    // ══════════════════════════════════════════════════════════════════
    //  videos.html
    // ══════════════════════════════════════════════════════════════════
    const videosJsonLd = {
        '@context': 'https://schema.org', '@graph': [orgSchema, siteSchema, {
            '@type': 'CollectionPage', '@id': `${SITE_URL}/videos.html`,
            url: `${SITE_URL}/videos.html`, name: 'Videos — Initial D San Francisco',
            description: 'Full archive of Initial D Arcade Stage V3 time attack runs and battle footage.',
            isPartOf: { '@id': `${SITE_URL}/#website` },
            ...(ytVideos.length ? { hasPart: ytVideos.map(v => ({
                '@type': 'VideoObject', name: v.title,
                url: `https://youtube.com/watch?v=${v.id}`,
                thumbnailUrl: `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
                uploadDate: v.date, publisher: { '@id': `${SITE_URL}/#org` },
            })) } : {}),
        }],
    };
    let videosNS = `<noscript>\n<div id="prerender-videos" style="display:none" aria-hidden="true">\n<h2>Video Archive — Initial D San Francisco</h2>\n`;
    if (ytVideos.length) {
        videosNS += `<ul>\n`;
        ytVideos.forEach(v => {
            videosNS += `<li><a href="https://youtube.com/watch?v=${v.id}">${esc(v.title)}</a></li>\n`;
        });
        videosNS += `</ul>\n`;
    }
    videosNS += `</div>\n</noscript>`;

    let videosHtml = fs.readFileSync(path.join(__dirname, 'videos.html'), 'utf8');
    videosHtml = injectMarker(videosHtml, 'VIDEOS_JSONLD',   `<script type="application/ld+json">\n${JSON.stringify(videosJsonLd, null, 2)}\n</script>`);
    videosHtml = injectMarker(videosHtml, 'VIDEOS_NOSCRIPT', videosNS);
    fs.writeFileSync(path.join(__dirname, 'videos.html'), videosHtml);
    console.log('[build] videos.html ✓');

    // ══════════════════════════════════════════════════════════════════
    //  Racer pages
    // ══════════════════════════════════════════════════════════════════
    const racersDir = path.join(__dirname, 'racers');
    if (!fs.existsSync(racersDir)) fs.mkdirSync(racersDir);

    const generatedSlugs = [];
    for (const racer of racers) {
        const taByCar   = getPlayerTA(taRecords, racer.name);
        const battle    = findPlayer(battleStats, racer.name);
        const h2h       = findPlayer(headToHead,  racer.name);
        const standing  = battleStandings.find(r => norm(r.racer) === norm(racer.name)) || null;
        const html      = generateRacerPage(racer, taByCar, battle, h2h, standing);
        const s         = slug(racer.name);
        fs.writeFileSync(path.join(racersDir, `${s}.html`), html);
        generatedSlugs.push(s);
        console.log(`[build] /racers/${s}.html ✓`);
    }

    // ══════════════════════════════════════════════════════════════════
    //  Courses index page
    // ══════════════════════════════════════════════════════════════════
    const coursesIndexHtml = generateCoursesIndex(taRecords, matches);
    fs.writeFileSync(path.join(__dirname, 'courses.html'), coursesIndexHtml);
    console.log('[build] courses.html ✓');

    // ══════════════════════════════════════════════════════════════════
    //  Course pages
    // ══════════════════════════════════════════════════════════════════
    const coursesDir = path.join(__dirname, 'courses');
    if (!fs.existsSync(coursesDir)) fs.mkdirSync(coursesDir);

    const generatedCourseSlugs = [];
    for (const course of COURSE_ORDER) {
        const html = generateCoursePage(course, taRecords, matches, racers);
        const s    = slug(course);
        fs.writeFileSync(path.join(coursesDir, `${s}.html`), html);
        generatedCourseSlugs.push(s);
        console.log(`[build] /courses/${s}.html ✓`);
    }

    // ══════════════════════════════════════════════════════════════════
    //  Sitemap
    // ══════════════════════════════════════════════════════════════════
    writeSitemap(generatedSlugs, generatedCourseSlugs);

    console.log(`\n[build] Done — ${racers.length} racer pages, ${COURSE_ORDER.length} course pages, ${ytVideos.length} videos, sitemap updated.`);
}

main().catch(err => {
    console.error('[build] FAILED:', err.message);
    process.exit(1);
});
