Run a roster QA check — cross-reference the RACERS array against the site's Google Sheets data sources to find gaps, missing players, and name mismatches.

## Step 1 — Read the RACERS array

Read `js/main.js` and extract every `name` value from the `RACERS` array. This is the canonical player list.

## Step 2 — Fetch the sheets the site actually reads

Read the current constants from `js/main.js` and `js/battle-engine.js`:
- `SHEET_ID` (main.js)
- `LEADERBOARD_GID` (main.js — use `&gid=`)
- `ELO_CALC_GID` (battle-engine.js — use `&gid=`)

Fetch both in parallel using WebFetch with `?tqx=out:json`.

Extract player names:
- **TA Leaderboard**: unique values from `Identity` column (falling back to `Tag_clean` or `Player Tag`)
- **Battle roster**: unique values from `Racer_A_norm` and `Racer_B_norm` on the Elo calc tab

Split the calc tab rows into **published** (video live, or `Date` strictly before today) and **awaiting upload** — the same gate `js/battle-engine.js` applies. A player who appears only in awaiting-upload rows is not on the live board yet; call that out separately rather than treating it as a gap.

Do **not** use `Battle Records by Racer`, `Racers by Course` or `Head_to_Head` — nothing on the site reads them and they include unpublished matches.

## Step 3 — Normalize names for comparison

Apply the same logic as `normalizeName()` in main.js: uppercase, strip all non-alphanumeric characters.
e.g. `CHON!` → `CHON`, `(.Y.)` → `Y`, `H-T` → `HT`, `:v` → `V`

Use normalized names for matching, but display the original names in the report.

## Step 4 — Run these checks

### A. Battle roster players not in RACERS
Names that appear in published calc-tab rows but have no match in RACERS (normalized).
These players show up in the leaderboard but can't be clicked through to a profile.
→ **Action: run `/add-player` for each**

Check the roster exceptions in CLAUDE.md first — MJ and KAY are intentionally excluded.

### B. TA leaderboard players not in RACERS
Names that appear as `Identity` in the TA sheet but have no match in RACERS (normalized).
These players have time attack records but no profile card.
→ **Action: run `/add-player` for each**

### C. RACERS with no data anywhere
Players in RACERS who appear in neither sheet (normalized match).
They have a profile card but no records or battle history.
→ **Note only** — may be newly added players

### C2. Players whose battles are all awaiting upload
Players who appear only in unpublished calc-tab rows. They're correctly absent from the live board until their videos go out.
→ **Note only** — expected behaviour, not a gap

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

Published battles: [N]   Awaiting upload: [M]

─── A. In battle roster, not in RACERS ───
[name] (rank X, ELO Y)
... or "None ✓"

─── B. In TA leaderboard, not in RACERS ───
[name] (N records in TA sheet)
... or "None ✓"

─── C. In RACERS, no data in either sheet ───
[name]
... or "None ✓"

─── C2. Battles all awaiting upload ───
[name] (N unpublished matches, first goes live [date])
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
