# CSV catch-up audit (T-042, T-050..T-054, T-072..T-074)

**Context:** T-040..T-049 was committed as `5be4451` after re-verifying
lint/build. While confirming that batch against the CSV, found the CSV was
also missing an earlier already-committed batch: `56e421e` ("feat(ui): add
shared Dropdown component and migrate Proxmox VNC selects (T-013, T-040,
T-042, T-050..054, T-072..074)"), landed before `2081018`/`9ad9356`/`56ff8dd`.
That commit was never reflected in the CSV because at the time it was made
the CSV wasn't updated (same class of gap the T-040..T-049 doc flagged, just
one batch further back).

## Verified against each task's acceptance criteria, current tree

- **T-042** -- `main.tsx` `PaletteSelect` trigger renders `<ChevronDownIcon
  className="location-chevron" />` (not a literal glyph). Confirmed at
  `fileapi_ui/src/main.tsx:465` (post `5be4451`).
- **T-050** -- `fileapi_ui/src/ui/Dropdown.tsx` exists: single-select
  component with `label`/`value`/`options`/`onChange` (+ `disabled`,
  `placeholder`, `className`).
- **T-051** -- Keyboard nav lives in `Dropdown.tsx`'s menu `onKeyDown`:
  ArrowDown/ArrowUp moves focus among `[role=option]` buttons, Home/End jump
  to first/last, Escape closes, and the trigger's own `onKeyDown` opens on
  ArrowDown/Enter/Space.
- **T-052** -- `closeMenu()` calls `triggerRef.current?.focus()`; used by
  both Escape and option `onClick`.
- **T-053** -- `document.addEventListener("click", close)` effect closes the
  menu when a pointer event's target isn't inside `rootRef`/`menuRef`,
  without touching `value`.
- **T-054** -- `fileapi_ui/src/ui/dropdown.css` exists and reads
  `--dropdown-border`, `--dropdown-trigger-radius`, `--dropdown-menu-radius`,
  `--dropdown-surface`, `--dropdown-option-padding`, `--dropdown-option-radius`,
  `--dropdown-focus-ring` from `styles/tokens.css` (T-013's contract), styles
  trigger/menu/option hover/selected/disabled/focus states.
- **T-072** -- `main.tsx:7071`, VNC entry editor's "PVE version" field uses
  `<Dropdown label="PVE version" value={vncEntryDraft.proxmoxVersion} ...>`.
- **T-073** -- `proxmox-vnc.tsx`, Node field uses `<Dropdown label="Node"
  value={selectedNode} onChange={chooseNode} ...>`.
- **T-074** -- `proxmox-vnc.tsx`, VM field uses `<Dropdown label="VM"
  value={...} onChange={chooseVm} ...>`.

All nine flipped from `PENDING` to `DONE` in
`issue-194-mobile-ui-task-list.csv`. Backed up the pre-edit CSV to
`/tmp/csv-backup-<epoch>.csv` before the in-place edit (not committed --
CSV is gitignored, `issue*` pattern).

## Also spot-checked while auditing (confirmed still correctly PENDING,
no change needed)

- **T-055** (extract `PaletteSelect` into `Dropdown` for SSH controls) --
  `main.tsx:7143`/`7150` still call the hand-rolled `PaletteSelect`
  function, not `Dropdown`. Genuinely not done yet.
- **T-056..T-059** (login profile menu -> Dropdown) -- `LoginScreen`'s
  profile trigger (`main.tsx:925-928`) is still a hand-rolled
  `.login-profile-menu`/`.login-profile-options`, not `Dropdown`. Genuinely
  not done yet (consistent with the T-040..T-049 doc's note that T-057/058/
  059 stay blocked-by-T-056 even though their literal wording is already
  satisfied by the current hand-rolled menu).
- **T-060** (persist selected UI profile) -- functionally already true
  today (`uiProfile` read from/written to `localStorage` under
  `desktopSettingsKey`, `main.tsx:975-989`, landed in `f0273c0`, well before
  this batch) but left PENDING since it's declared blocked-by-T-056 in the
  CSV's own dependency column, same reasoning as T-057..T-059. Not changed.
- **T-061/T-062/T-063** (Settings theme/share-expiration/log-level ->
  Dropdown) -- all three still native `<select>` at `main.tsx:6752/6809/6832`.
  Genuinely not done.
- **T-064..T-071** (REST auth-mode/method/BIOS attribute/BIOS allowable
  value/action parameter/IML severity/IML interval/firmware target ->
  Dropdown) -- all eight still native `<select>` in `rest-api.tsx`.
  Genuinely not done.
- **T-075/T-076** (ContextPicker/MobileChoiceMenu restyle with Dropdown
  tokens) -- both only reuse `--z-dropdown`; no other `--dropdown-*` tokens
  referenced in `context-picker.css`/`ui/mobile-choice-menu.css`. Genuinely
  not done (T-076's glyph-only swap was T-040/041's job, separately noted in
  the T-040..T-049 doc; the CSS restyle itself is still open).

## Next action

CSV now matches the tree through T-054/T-072..T-074 plus the T-040..T-049
batch. Next open work per CSV order is **T-055** (extract `PaletteSelect`
into `Dropdown` for the two SSH controls in `main.tsx`), then continue down
through T-056 (login profile menu -> Dropdown) and the Settings/REST select
migrations (T-061..T-071), unless told otherwise first.
