Run a roster QA check — cross-reference the RACERS array against all four Google Sheets to find gaps, missing players, and name mismatches.

## Step 1 — Read the RACERS array

Read `js/main.js` and extract every `name` value from the `RACERS` array. This is the canonical player list.

## Step 2 — Fetch all four sheets

Read `js/main.js` for the current constants:
- `SHEET_ID`
- `LEADERBOARD_GID` (use `&gid=`)
- `BATTLE_STATS_SHEET` (use `&sheet=`)
- `HEAD_TO_HEAD_SHEET` (use `&sheet=`)
- `BATTLE_LEADERBOARD_SHEET` (use `&sheet=`, with `&range=A4:I`)

Fetch all four in parallel using WebFetch with `?tqx=out:json`.

Extract player names from each sheet:
- **TA Leaderboard**: unique values from `Identity` column (falling back to `Tag_clean` or `Player Tag`)
- **Battle Stats (Racers by Course)**: player section header rows — first cell of rows where the rest are null
- **Head to Head**: same pattern as Battle Stats
- **Battle Standings**: values from the `Racer` (or `Player`) column, skipping blanks

## Step 3 — Normalize names for comparison

Apply the same logic as `normalizeName()` in main.js: uppercase, strip all non-alphanumeric characters.
e.g. `CHON!` → `CHON`, `(.Y.)` → `Y`, `H-T` → `HT`, `:v` → `V`

Use normalized names for matching, but display the original names in the report.

## Step 4 — Run these checks

### A. Battle standings players not in RACERS
Names that appear in the Battle Standings sheet but have no match in RACERS (normalized).
These players show up in the leaderboard but can't be clicked through to a profile.
→ **Action: run `/add-player` for each**

### B. TA leaderboard players not in RACERS
Names that appear as `Identity` in the TA sheet but have no match in RACERS (normalized).
These players have time attack records but no profile card.
→ **Action: run `/add-player` for each**

### C. RACERS with no data anywhere
Players in RACERS who don't appear in any of the four sheets (normalized match).
They have a profile card but no records or battle history.
→ **Note only** — may be newly added players

### D. Name mismatches (fuzzy catches)
Players who matched only via normalization (i.e. the raw names differ).
e.g. sheet has `H-T`, RACERS has `HT` — normalized both to `HT` so they match, but raw names differ.
List these so they can be corrected at the source if desired.

## Step 5 — Report

Use this format:

```
ROSTER QA — [date]
═══════════════════════════════════════

RACERS array: [N] players
[list all names]

─── A. In battle standings, not in RACERS ───
[name] (battle standings: rank X, ELO Y)
... or "None ✓"

─── B. In TA leaderboard, not in RACERS ───
[name] (N records in TA sheet)
... or "None ✓"

─── C. In RACERS, no data in any sheet ───
[name]
... or "None ✓"

─── D. Name mismatches (normalized match only) ───
Sheet: "[raw name]"  →  RACERS: "[raw name]"  (both normalize to "[normalized]")
... or "None ✓"

═══════════════════════════════════════
[X issue(s) found — run /add-player for: NAME1, NAME2]
  or
[All clear ✓]
```

If any players are flagged in A or B, offer to run `/add-player` for them immediately.
