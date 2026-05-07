Check that all Google Sheets data sources for the Initial D SF website are reachable and returning well-formed data.

## Sheet endpoints to check

Read the current values from `js/main.js`:
- `SHEET_ID`
- `LEADERBOARD_GID` (numeric GID)
- `BATTLE_STATS_SHEET` (sheet name)
- `HEAD_TO_HEAD_SHEET` (sheet name)
- `BATTLE_LEADERBOARD_SHEET` (sheet name, fetch with `&range=A4:I` to skip title rows)

Construct URLs:
- GID:        `https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:json&gid={GID}`
- Sheet name: `https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:json&sheet={encoded name}`
- Sheet name with range: `https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:json&sheet={encoded name}&range=A4:I`

Fetch all four in parallel with WebFetch.

## What to verify for each sheet

| Sheet | Expected columns | Min rows |
|---|---|---|
| Leaderboard (GID 0) | Player Tag, Map, Direction, Condition, Car, Time, Time_ms, Tag_clean, Identity | 50 |
| Racers by Course | Course, Wins, Losses, Total, Win % | 10 |
| Head_to_Head | Opponent, Wins, Losses, Total, Win % | 5 |
| Battle Records by Racer | Racer, ELO, Wins, Losses, Matches, Win %, Streak, Last Active | 5 |

## Report format

For each sheet, report one of:
- ✅ **OK** — columns match, row count looks healthy, first row sample
- ⚠️ **WARNING** — data returned but columns differ from expected (list the actual columns found)
- ❌ **FAIL** — empty response or HTTP error

End with a summary line and, if anything is ⚠️ or ❌, recommend the specific fix:
- Missing/renamed sheet → update the constant in `js/main.js`
- Empty response → check that the sheet is published to web (File → Share → Publish to web)
- GID mismatch → switch to sheet name reference instead
