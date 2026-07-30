/* ============================================================
   INITIAL D SF — Battle engine
   Shared by the browser (index.html, racers/*.html) and build.js
   ============================================================

   WHY THIS EXISTS
   ---------------
   Battle videos are uploaded on a schedule, so the battle log contains rows
   dated in the FUTURE — matches that have already been played and logged, but
   whose video hasn't gone live yet. The Apps Script standings sheet
   ('Battle Records by Racer') aggregates every row regardless of date, so it
   leaks the outcome of every scheduled upload: ELO, W/L, streak and rank all
   reflect battles nobody has watched.

   This module rebuilds all battle-derived stats from the ELO calc tab,
   filtered to matches whose video is actually public. Because the calc tab
   holds a running Elo chain in publish order, "ELO as of the last posted
   video" is a lookup, not a recomputation: take Elo_*_after from a player's
   most recent published row. No Elo math is duplicated here — the Google
   engine stays the single source of truth for the rating itself.

   Consequences worth knowing:
   - The board advances on its own as videos go live. No script run needed.
   - A player whose only battles are unpublished simply doesn't appear yet.
   - Row order in the calc tab IS the Elo chain order, so rows are never
     re-sorted here. checkChainOrder() warns if the tab stops being
     date-ascending, which would make the publish cut non-contiguous.
   ============================================================ */

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.BattleEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

    /* The ELO calc tab — one row per match with the full audit trail
       (Elo_A_before/after, Expected_*, Session_* …) written by Apps Script. */
    const ELO_CALC_GID = '20260409';

    /* ── Normalisation ──────────────────────────────────────── */
    // Mirrors normalizeName() in main.js / norm() in build.js.
    function normName(s) {
        return String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    /* ── Dates ──────────────────────────────────────────────── */
    // gviz hands dates over as "Date(YYYY,M,D)" (month is 0-based) in JSON and
    // as "M/D/YYYY" in CSV; sheets edited by hand can also yield ISO strings.
    function parseSheetDate(v) {
        if (v == null || v === '') return null;
        if (v instanceof Date) return startOfDay(v);

        const s = String(v).trim();
        let m = s.match(/^Date\((\d+),(\d+),(\d+)/);
        if (m) return new Date(+m[1], +m[2], +m[3]);

        m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
        if (m) {
            const year = +m[3] < 100 ? +m[3] + 2000 : +m[3];
            return new Date(year, +m[1] - 1, +m[2]);
        }

        const d = new Date(s);
        return isNaN(d.getTime()) ? null : startOfDay(d);
    }

    function startOfDay(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    /* ── Video IDs ──────────────────────────────────────────── */
    // Older log rows hold a pasted video TITLE rather than a URL — those
    // return null and fall back to the date rule in isPublished().
    function extractVideoId(v) {
        const m = String(v || '').match(
            /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
        );
        return m ? m[1] : null;
    }

    // Build the "this is live on the channel" set from a YouTube API result.
    function publishedIdsFrom(videos) {
        const list = Array.isArray(videos) ? videos : (videos && videos.videos) || [];
        return new Set(list.map(v => v && v.id).filter(Boolean));
    }

    /* ── Canonical match shape ──────────────────────────────── */
    // Accepts rows from the calc tab (preferred — carries Elo) or from the raw
    // battle log (no Elo). Row ORDER is preserved: it is the Elo chain order.
    function parseMatches(rawRows) {
        return (rawRows || []).map((r, i) => {
            const pick = (...keys) => {
                for (const k of keys) if (r[k] != null && r[k] !== '') return r[k];
                return null;
            };
            const a      = pick('Racer_A_norm', 'Racer A_raw', 'Racer A');
            const b      = pick('Racer_B_norm', 'Racer B_raw', 'Racer B');
            const winner = pick('Winner_norm', 'Winner_raw', 'Winner');
            const loser  = pick('Loser_norm', 'Loser_raw', 'Loser');
            const url    = pick('Video URL', 'Video');

            return {
                row      : i,
                matchId  : pick('Match ID', 'MatchID'),
                date     : parseSheetDate(pick('Date')),
                videoUrl : url,
                videoId  : extractVideoId(url),
                a        : a      ? String(a).trim()      : null,
                b        : b      ? String(b).trim()      : null,
                winner   : winner ? String(winner).trim() : null,
                loser    : loser  ? String(loser).trim()  : null,
                course   : pick('Course_raw', 'Course'),
                direction: pick('Direction_raw', 'Direction'),
                condition: pick('Conditions_raw', 'Conditions', 'Condition'),
                status   : pick('Record_Status'),
                eloAAfter: toNum(pick('Elo_A_after')),
                eloBAfter: toNum(pick('Elo_B_after')),
            };
        }).filter(m =>
            m.a && m.b && m.winner &&
            (m.status == null || String(m.status).toUpperCase() === 'OK')
        );
    }

    function toNum(v) {
        if (v == null || v === '') return null;
        const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
        return isNaN(n) ? null : n;
    }

    /* ── The publish gate ───────────────────────────────────── */
    // A match counts once EITHER test passes:
    //   1. its video ID is live on the channel right now — exact, and instant
    //      the moment a scheduled upload goes public; or
    //   2. it is dated strictly before today — covers legacy rows that store a
    //      title instead of a URL, and keeps working if the YouTube fetch dies.
    //
    // Rule 2 is deliberately strict (< today, not <= today) so a row scheduled
    // for later today stays hidden until its video is confirmed live. Without
    // the video list a same-day upload therefore lags until midnight — the
    // conservative direction, since the alternative is spoiling it early.
    function isPublished(match, opts) {
        const { publishedIds = null, now = new Date() } = opts || {};
        if (publishedIds && publishedIds.size && match.videoId && publishedIds.has(match.videoId)) {
            return true;
        }
        if (!match.date) return true; // undated legacy row — nothing to withhold
        return match.date < startOfDay(now);
    }

    function splitByPublished(matches, opts) {
        const published = [], withheld = [];
        (matches || []).forEach(m => (isPublished(m, opts) ? published : withheld).push(m));
        return { published, withheld };
    }

    // Convenience: raw sheet rows → published matches, in chain order.
    function publishedMatches(rawRows, opts) {
        return splitByPublished(parseMatches(rawRows), opts).published;
    }

    /* ── Standings (ELO, W/L, streak, last active) ──────────── */
    // ELO is read from the chain, never recalculated: each player's rating is
    // Elo_*_after on their most recent published row.
    function deriveStandings(matches) {
        const acc = new Map(); // normalised name → record

        const touch = (name, elo, date) => {
            const key = normName(name);
            let p = acc.get(key);
            if (!p) {
                p = { racer: name, wins: 0, losses: 0, matches: 0, elo: null, lastActive: null, form: [] };
                acc.set(key, p);
            }
            p.matches++;
            if (elo != null) p.elo = elo;                        // later row wins
            if (date && (!p.lastActive || date > p.lastActive)) p.lastActive = date;
            return p;
        };

        (matches || []).forEach(m => {
            const pa = touch(m.a, m.eloAAfter, m.date);
            const pb = touch(m.b, m.eloBAfter, m.date);
            const winnerKey = normName(m.winner);

            [pa, pb].forEach(p => {
                const won = normName(p.racer) === winnerKey;
                if (won) p.wins++; else p.losses++;
                p.form.push(won ? 'W' : 'L');
            });
        });

        const rows = [...acc.values()].map(p => ({
            racer     : p.racer,
            elo       : p.elo,
            wins      : p.wins,
            losses    : p.losses,
            matches   : p.matches,
            winPct    : p.matches ? p.wins / p.matches : 0,
            streak    : trailingStreak(p.form),
            lastActive: p.lastActive,
        }));

        // Unrated players (no Elo in the chain) sink to the bottom rather than
        // sorting as 0 and displacing everyone.
        rows.sort((x, y) => (y.elo ?? -Infinity) - (x.elo ?? -Infinity));
        rows.forEach((r, i) => { r.rank = i + 1; });
        return rows;
    }

    // "W4" / "L2" — the run of identical results at the end of the list.
    function trailingStreak(form) {
        if (!form || !form.length) return '';
        const last = form[form.length - 1];
        let n = 0;
        for (let i = form.length - 1; i >= 0 && form[i] === last; i--) n++;
        return last + n;
    }

    /* ── Per-player breakdowns ──────────────────────────────── */
    // Shapes match what the sheet parsers used to return, so the existing
    // renderers in main.js / build.js need no reshaping.

    // { 'NEMUI': { overall: '27W 26L (51.0% overall)', courses: [ … ] } }
    function deriveByCourse(matches, courseOrder) {
        const players = groupPerPlayer(matches, m => m.course || 'Unknown');
        const order   = courseOrder || [];
        const rank    = name => {
            const i = order.findIndex(c => normName(c) === normName(name));
            return i === -1 ? 999 : i;
        };

        const out = {};
        players.forEach(p => {
            const courses = [...p.buckets.values()]
                .map(b => tally(b.label, b))
                .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

            out[p.name] = { overall: overallLabel(p), courses };
        });
        return out;
    }

    // { 'NEMUI': [ { opponent, wins, losses, total, winPct } … ] }
    function deriveHeadToHead(matches) {
        const players = groupPerPlayer(matches, null, true);
        const out = {};
        players.forEach(p => {
            out[p.name] = [...p.buckets.values()]
                .map(b => tally(b.label, b))
                .sort((a, b) => b.total - a.total || b.wins - a.wins)
                .map(({ name, ...rest }) => ({ opponent: name, ...rest }));
        });
        return out;
    }

    // [ { name, wins, losses, total, winPct } ] for one course — used by course pages.
    function deriveCourseStandings(matches, courseName) {
        const target = normName(courseName);
        const scoped = (matches || []).filter(m => normName(m.course) === target);
        const acc    = new Map();

        scoped.forEach(m => {
            const winnerKey = normName(m.winner);
            [m.a, m.b].forEach(name => {
                const key = normName(name);
                if (!acc.has(key)) acc.set(key, { label: name, wins: 0, losses: 0 });
                const p = acc.get(key);
                if (key === winnerKey) p.wins++; else p.losses++;
            });
        });

        return [...acc.values()]
            .map(p => tally(p.label, p))
            .sort((a, b) => b.wins - a.wins || b.winPct - a.winPct);
    }

    /* ── Grouping helpers ───────────────────────────────────── */
    // For each player, bucket their matches by a key (course) or by opponent.
    function groupPerPlayer(matches, keyFn, byOpponent = false) {
        const players = new Map();

        const ensure = name => {
            const key = normName(name);
            if (!players.has(key)) {
                players.set(key, { name, wins: 0, losses: 0, buckets: new Map() });
            }
            return players.get(key);
        };

        (matches || []).forEach(m => {
            const winnerKey = normName(m.winner);
            [[m.a, m.b], [m.b, m.a]].forEach(([self, opp]) => {
                const p     = ensure(self);
                const won   = normName(self) === winnerKey;
                const label = byOpponent ? opp : keyFn(m);
                const bKey  = normName(label);

                if (!p.buckets.has(bKey)) p.buckets.set(bKey, { label, wins: 0, losses: 0 });
                const b = p.buckets.get(bKey);

                if (won) { p.wins++; b.wins++; } else { p.losses++; b.losses++; }
            });
        });

        return players;
    }

    function tally(name, b) {
        const total = b.wins + b.losses;
        return { name, wins: b.wins, losses: b.losses, total, winPct: total ? b.wins / total : 0 };
    }

    function overallLabel(p) {
        const total = p.wins + p.losses;
        const pct   = total ? ((p.wins / total) * 100).toFixed(1) : '0.0';
        return `${p.wins}W ${p.losses}L (${pct}% overall)`;
    }

    /* ── Safety net ─────────────────────────────────────────── */
    // The publish cut is only a clean prefix of the Elo chain while the calc
    // tab stays date-ascending. If a backdated match ever gets inserted below
    // later rows, a player's rating can be read from a row whose Elo_before
    // came from a still-withheld match. Returns the offending row indexes.
    function checkChainOrder(matches) {
        const bad = [];
        for (let i = 1; i < matches.length; i++) {
            const prev = matches[i - 1].date, cur = matches[i].date;
            if (prev && cur && cur < prev) bad.push(matches[i].row);
        }
        return bad;
    }

    return {
        ELO_CALC_GID,
        normName,
        parseSheetDate,
        startOfDay,
        extractVideoId,
        publishedIdsFrom,
        parseMatches,
        isPublished,
        splitByPublished,
        publishedMatches,
        deriveStandings,
        deriveByCourse,
        deriveHeadToHead,
        deriveCourseStandings,
        checkChainOrder,
    };
});
