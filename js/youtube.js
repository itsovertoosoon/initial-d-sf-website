/* ============================================================
   INITIAL D SF — YouTube API loader
   Shared by both index.html (homepage preview) and videos.html
   ============================================================ */

const YT_CACHE_KEY = 'idsf_yt_cache';
const YT_CACHE_TTL = 60 * 60 * 1000; // 1 hour — refresh after upload

/* ── Public function: call this to get videos ─────────────────
   Returns an array of video objects, or null on error.
   Results are cached in localStorage for 1 hour.

   Each video object:
   {
     id:          string  — YouTube video ID
     title:       string
     date:        string  — ISO date, e.g. "2025-04-21T18:00:00Z"
     description: string
     thumbnail:   string  — URL of the best available thumbnail
     tags:        string[] — from VIDEO_TAGS in data/videos.js
   }
   ─────────────────────────────────────────────────────────── */
async function loadVideos() {
    const { API_KEY, CHANNEL_ID } = YOUTUBE_CONFIG;

    // Not configured yet — show setup prompt
    if (!API_KEY || !CHANNEL_ID) return { status: 'unconfigured' };

    // Return cached data if fresh
    const cached = readYTCache();
    if (cached) return { status: 'ok', videos: applyTags(cached) };

    try {
        // 1. Resolve the channel's "uploads" playlist ID
        const chRes  = await fetch(
            `https://www.googleapis.com/youtube/v3/channels` +
            `?part=contentDetails&id=${CHANNEL_ID}&key=${API_KEY}`
        );
        const chData = await chRes.json();

        if (chData.error) throw new Error(chData.error.message);
        if (!chData.items?.length) throw new Error('Channel not found. Double-check your CHANNEL_ID.');

        const uploadsId = chData.items[0].contentDetails.relatedPlaylists.uploads;

        // 2. Fetch videos from that playlist (up to 50 per page, max 2 pages = 100 videos)
        let videos    = [];
        let pageToken = '';
        let pages     = 0;

        do {
            const url =
                `https://www.googleapis.com/youtube/v3/playlistItems` +
                `?part=snippet&playlistId=${uploadsId}&maxResults=50` +
                (pageToken ? `&pageToken=${pageToken}` : '') +
                `&key=${API_KEY}`;

            const res  = await fetch(url);
            const data = await res.json();

            if (data.error) throw new Error(data.error.message);

            const batch = (data.items || []).map(item => ({
                id:          item.snippet.resourceId.videoId,
                title:       item.snippet.title,
                date:        item.snippet.publishedAt,
                description: item.snippet.description,
                thumbnail:
                    item.snippet.thumbnails?.high?.url     ||
                    item.snippet.thumbnails?.medium?.url   ||
                    item.snippet.thumbnails?.default?.url  || '',
            }));

            videos    = videos.concat(batch);
            pageToken = data.nextPageToken || '';
            pages++;
        } while (pageToken); // fetch all videos — no page cap

        writeYTCache(videos);
        return { status: 'ok', videos: applyTags(videos) };

    } catch (err) {
        console.error('[YouTube] Load failed:', err.message);
        // Fall back to stale cache if available, rather than showing nothing
        const stale = readYTCache(true);
        if (stale) return { status: 'ok', videos: applyTags(stale) };
        return { status: 'error', message: err.message };
    }
}

/* ── Merge VIDEO_TAGS into the video list ─────────────────── */
function applyTags(videos) {
    return videos.map(v => ({
        ...v,
        tags: VIDEO_TAGS[v.id] || [],
    }));
}

/* ── localStorage cache helpers ──────────────────────────── */
function readYTCache(allowStale = false) {
    try {
        const raw = localStorage.getItem(YT_CACHE_KEY);
        if (!raw) return null;
        const { timestamp, videos } = JSON.parse(raw);
        if (!allowStale && Date.now() - timestamp > YT_CACHE_TTL) return null;
        return videos;
    } catch {
        return null;
    }
}

function writeYTCache(videos) {
    try {
        localStorage.setItem(YT_CACHE_KEY, JSON.stringify({
            timestamp: Date.now(),
            videos,
        }));
    } catch {
        // localStorage full or unavailable — just skip caching
    }
}

/* ── Utility: force a cache refresh (call from browser console) ─
   Type  clearVideoCache()  in DevTools to reload immediately.
   ─────────────────────────────────────────────────────────── */
function clearVideoCache() {
    localStorage.removeItem(YT_CACHE_KEY);
    console.log('[YouTube] Cache cleared. Reload the page.');
}
