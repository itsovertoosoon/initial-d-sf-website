// ═══════════════════════════════════════════════════════════════
// VIDEO CONFIG — Fill in your API key and Channel ID below
// ═══════════════════════════════════════════════════════════════
//
//  STEP 1 — Get a free YouTube API key (one-time setup, ~5 min):
//
//   1. Go to: console.cloud.google.com
//   2. Click "Select a project" at the top → "New Project"
//      Name it anything (e.g. "Initial D SF") → click Create
//   3. In the search bar at the top, type: YouTube Data API v3
//      Click it in the results → click the blue "Enable" button
//   4. In the left sidebar, click "Credentials"
//   5. Click "+ Create Credentials" at the top → choose "API key"
//   6. Copy the key that appears → paste it below as API_KEY
//   7. (Optional but smart) Click on the key you just created,
//      scroll to "API restrictions", select "Restrict key",
//      tick "YouTube Data API v3" → Save
//
//  STEP 2 — Find your Channel ID:
//
//   1. Go to YouTube Studio: studio.youtube.com
//   2. Click the gear icon (Settings) at the bottom left
//   3. Click "Channel" → "Advanced settings"
//   4. Copy the "Channel ID" (it starts with UC...) → paste below
//
// ═══════════════════════════════════════════════════════════════

const YOUTUBE_CONFIG = {
    API_KEY:    'AIzaSyD7OCuHlxuHY48LpiQVW3TUqWqkhrh7-TE',   // ← paste your API key here (in the quotes)
    CHANNEL_ID: 'UCIpzydbJbZoAUFM8g8rgt2Q',   // ← paste your Channel ID here (starts with UC...)
};

// ═══════════════════════════════════════════════════════════════
// VIDEO TAGS — optional category labels for the filter system
// ═══════════════════════════════════════════════════════════════
//
//  Videos show up automatically once you add your API key above.
//  Tags are optional — they power the filter buttons on the Videos page.
//
//  HOW TO TAG A VIDEO:
//   1. Find the video's ID in the YouTube URL (the part after "?v=")
//      Example: youtube.com/watch?v=ABC123XYZ  →  "ABC123XYZ"
//   2. Add a line below:
//      'ABC123XYZ': ['street', 'drift'],
//
//  AVAILABLE TAGS:
//   'street'  — Street driving / SF runs
//   'arcade'  — Cabinet gameplay
//   'drift'   — Drift technique / highlight clips
//   'battle'  — Head-to-head / ghost battles
//   'record'  — New personal best / time attack record
//
// ═══════════════════════════════════════════════════════════════

const VIDEO_TAGS = {
    // 'VIDEO_ID': ['tag1', 'tag2'],
    // 'VIDEO_ID': ['arcade', 'record'],
};
