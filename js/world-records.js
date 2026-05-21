/* ══════════════════════════════════════════════════════════════
   world-records.js
   Fetches world record times from idrankings.com API and caches
   them in localStorage (24h TTL). Exposes getWorldRecord() and
   formatWrMs() for use by filterAndRender() in main.js.
   ══════════════════════════════════════════════════════════════ */

const WR_CACHE_KEY = 'wr_records_v1';
const WR_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// "CourseName|DirAbbr|Condition" → time_ms  (null until loadWorldRecords resolves)
let _wrData = null;

async function loadWorldRecords() {
    // 1. Try localStorage cache first
    try {
        const cached = JSON.parse(localStorage.getItem(WR_CACHE_KEY) || 'null');
        if (cached && (Date.now() - cached.ts) < WR_CACHE_TTL) {
            _wrData = cached.data;
            return;
        }
    } catch { /* corrupted cache — discard and re-fetch */ }

    // 2. Fetch course metadata + all rankings in parallel
    try {
        const [gameRes, rankRes] = await Promise.all([
            fetch('https://idrankings.com/api/games/byName/initiald/v3'),
            fetch('https://idrankings.com/api/games/3/rankings/top'),
        ]);
        const [gameData, rankings] = await Promise.all([gameRes.json(), rankRes.json()]);

        // Build courseId → { name, dir (abbr), cond }
        const courseMap = {};
        for (const c of (gameData.courses || [])) {
            courseMap[c.id] = { name: c.name, dir: c.direction, cond: c.condition };
        }

        // Reduce 1,333 records → fastest time per courseId (client-side — API doesn't filter)
        const bestByCourse = {};
        for (const r of rankings) {
            const cid = r.course?.id;
            if (!cid || !courseMap[cid]) continue;
            if (!bestByCourse[cid] || r.time < bestByCourse[cid]) {
                bestByCourse[cid] = r.time;
            }
        }

        // Build final lookup: "CourseName|DirAbbr|Cond" → time_ms
        const wrMap = {};
        for (const [cid, time_ms] of Object.entries(bestByCourse)) {
            const c = courseMap[cid];
            wrMap[`${c.name}|${c.dir}|${c.cond}`] = time_ms;
        }

        _wrData = wrMap;
        localStorage.setItem(WR_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: wrMap }));

        // Re-render leaderboard now that WR data is available (activeTrack is a main.js global)
        if (typeof filterAndRender === 'function' && typeof activeTrack !== 'undefined' && activeTrack) {
            filterAndRender();
        }
    } catch (err) {
        console.warn('[WorldRecords] Failed to load:', err.message);
        // Fail silently — WR strip just won't show
    }
}

/**
 * Returns the world record time in ms for a given course/direction/condition,
 * or null if data isn't loaded or the combo isn't found.
 * @param {string} courseName  e.g. "Akagi"
 * @param {string} dirAbbr     e.g. "DH"  (from DIR_TO_ABBR in main.js)
 * @param {string} condition   e.g. "Dry"
 */
function getWorldRecord(courseName, dirAbbr, condition) {
    if (!_wrData) return null;
    return _wrData[`${courseName}|${dirAbbr}|${condition}`] ?? null;
}

/**
 * Formats a millisecond time value as "M'SS\"mmm" (same format as sheet times).
 * @param {number} ms
 */
function formatWrMs(ms) {
    const min   = Math.floor(ms / 60000);
    const sec   = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    return `${min}'${String(sec).padStart(2, '0')}"${String(milli).padStart(3, '0')}`;
}
