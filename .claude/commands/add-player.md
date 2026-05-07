Add a new player to the Initial D SF website.

## What to ask for

If the player name wasn't provided as an argument, ask:
1. **Player tag** — the exact display name as it appears on their card (e.g. `GONZO`, `WHAT?`, `:v`)
2. **Headshot image** — do they have one ready to add? If yes, what filename did they drop into `Headshots/`?

## Steps

### 1. Determine alphabetical position in RACERS

The `RACERS` array in `js/main.js` is sorted roughly alphabetically. Letters come first (A–Z, case-insensitive), then punctuation/symbol names like `(.Y.)` and `:v` at the end.

Find the correct insertion point by comparing the new name against the existing list.

### 2. Add to RACERS array

In `js/main.js`, insert a new entry at the correct position:

- **With image:**
  ```js
  { name: 'PLAYERNAME', img: 'Headshots/FILENAME.EXT' },
  ```
- **Without image (placeholder avatar will be shown):**
  ```js
  { name: 'PLAYERNAME', img: null                      },
  ```

Keep the column alignment consistent with surrounding entries.

### 3. Check the headshot file (if provided)

- Confirm the file exists at `Headshots/<filename>` with the correct extension (`.JPG`, `.jpg`, `.png`, etc.)
- Warn if the file is missing — the site uses `onerror` to fall back to initials, but it's better to have the image present

### 4. Check the Google Sheet

Remind the user to verify:
- The player's tag appears in the **Time Trial Records** sheet under `Player Tag` or `Identity` if they use a card name different from their display name
- The player's tag appears in **Racers by Course** and **Head_to_Head** sheets if they have battle records

### 5. Confirm

Report what was changed:
- File edited: `js/main.js`
- Insertion position (between which two players)
- Image status: linked / null (initials fallback)
- Any warnings (missing image file, sheet check reminder)
