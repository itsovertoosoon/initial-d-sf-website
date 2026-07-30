Check that all Google Sheets data sources for the Initial D SF website are reachable and returning well-formed data.

## Sheet endpoints to check

Read the current values from `js/main.js` and `js/battle-engine.js`:
- `SHEET_ID` (main.js)
- `LEADERBOARD_GID` (main.js — numeric GID)
- `ELO_CALC_GID` (battle-engine.js — numeric GID; the only battle source the site reads)
- `BATTLE_LOG_GID` (js/videos.js — numeric GID; used only to classify a video as a battle)

Construct URLs:
- GID:        `https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:json&gid={GID}`
- Sheet name: `https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:json&sheet={encoded name}`

Fetch all three in parallel with WebFetch.

## What to verify for each sheet

| Sheet | Expected columns | Min rows |
|---|---|---|
| Leaderboard (GID 0) | Player Tag, Map, Direction, Condition, Car, Time, Time_ms, Tag_clean, Identity | 50 |
| Elo calc tab | Match ID, Date, Video URL, Racer_A_norm, Racer_B_norm, Winner_norm, Loser_norm, Course_raw, Record_Status, Elo_A_after, Elo_B_after | 100 |
| Battle log | Match ID, Date, Video URL, Racer A, Racer B, Winner, Loser, Course | 100 |

## Also check on the Elo calc tab

These are the invariants the publish gate depends on (see "The publish gate" in CLAUDE.md):

1. **Chronological rows** — `Date` must be non-decreasing down the tab. Row order IS the Elo chain order, so out-of-order rows make the publish cut non-contiguous. Report the offending row numbers if any.
2. **Chain integrity** — for each player, `Elo_*_before` on a row should equal their `Elo_*_after` from their previous row. Report any mismatch over 0.02.
3. **Future rows present** — count rows dated after today (matches awaiting upload). Report the count and the earliest/latest such date. Zero when videos are known to be scheduled means the gate has nothing to withhold and something changed in the sheet.
4. **Record_Status** — flag any row that isn't `OK`; `parseMatches()` drops those.

## Report format

For each sheet, report one of:
- ✅ **OK** — columns match, row count looks healthy, first row sample
- ⚠️ **WARNING** — data returned but columns differ from expected (list the actual columns found)
- ❌ **FAIL** — empty response or HTTP error

Then report the four calc-tab invariants above, each ✅ or ⚠️ with specifics.

End with a summary line and, if anything is ⚠️ or ❌, recommend the specific fix:
- Missing/renamed sheet → update the constant in `js/main.js` / `js/battle-engine.js`
- Empty response → check that the sheet is published to web (File → Share → Publish to web)
- GID mismatch → switch to sheet name reference instead
- Out-of-order rows → sort the calc tab by Date (or Match ID) and re-run the Apps Script recalc
