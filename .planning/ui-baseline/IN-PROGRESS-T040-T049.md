# In-progress status (uncommitted at time of writing)

**Last commit:** `56ff8dd` (T-038/T-039, explorer profile layout classes)
**Backup checkpoints at that commit:** tag `checkpoint/issue-194-pre-t040`,
branch `backup/issue-194-pre-t040`.

**Verified just now, working tree still uncommitted:**
```
npm run lint   -> tsc --noEmit: clean
npm run build  -> vite build: succeeds, dist/ produced normally
```

## What this batch does (T-040, T-041, T-043 through T-049)

### `fileapi_ui/src/ui/icons.tsx`
- T-041: `base()` no longer hardcodes a pixel default (was 14 for
  chevrons/close/check, 8 for the dot). Every icon except `DotIcon` now
  defaults to `var(--icon-size)` (18px, tokens.css) via inline `style`,
  and only falls back to a literal pixel `size` prop when a call site
  explicitly passes one (used at several call sites below to keep an icon
  visually proportionate to a small badge/button it sits inside, same as
  before -- e.g. `<DiamondIcon size={10} />` next to 12px text).
- T-040 + closing the "no dedicated task" gaps GLYPH-INVENTORY.md
  recorded: added `ChevronUpIcon`, `ExpandIcon`/`CollapseIcon` (terminal
  maximize/restore), `WarningIcon` (⚠), `DiamondIcon` (◆), `SortAscIcon`/
  `SortDescIcon` (▲/▼), alongside the pre-existing `ChevronDownIcon`/
  `ChevronLeftIcon`/`ChevronRightIcon`/`CloseIcon`/`CheckIcon`/`DotIcon`.

### Glyph replacement call sites (one edit per GLYPH-INVENTORY.md row)
- `main.tsx`: login profile trigger (T-043), Settings back/close/panel-menu
  chevrons (T-044/T-045), "⚠ ROOT" badge and remote sort arrows (T-049),
  plus every gap item GLYPH-INVENTORY.md folded into "no dedicated task,
  swap opportunistically": commandbar-overflow-trigger chevron,
  clear-search ×, LOCAL tree toggle, Location main-pane collapse controls,
  Share Links close, SSH tab close, SSH terminal maximize/collapse/
  restore-hint. Two helper-text strings that referenced literal `[‹]`/`[›]`
  glyphs in prose were reworded ("collapse/restore pane controls") since
  those glyphs no longer exist for the prose to point at.
- `context-picker.tsx` (T-046): trigger chevron, selected-option dot.
- `rest-api.tsx` (T-047): all 16 `×` close buttons (single `replaceAll`,
  every occurrence was `>×</button>`, verified before replacing), entry-pane
  collapse controls, path breadcrumb separator, Redfish Toolbox disclosure
  chevron.
- `proxmox-vnc.tsx` (T-048): entry-pane collapse controls.
- `log-view.tsx` (gap, folded into T-129's surface): column sort arrows,
  row expand/collapse chevrons, close button. `sortLabel()`'s return type
  changed from `string` to `JSX.Element | null` since it's spliced directly
  into button text content.
- `app/DesktopTitlebar.tsx`, `features/help/HelpModal.tsx`,
  `ui/MobileChoiceMenu.tsx` (gap, folded into T-040/041 generically):
  account-menu chevron, Help close button, MobileChoiceMenu trigger
  chevron (only the glyph -- MobileChoiceMenu's own CSS restyle to match
  Dropdown tokens is T-076, separately scoped, not touched here).

### What's deliberately NOT touched
Per GLYPH-INVENTORY.md's disposition: breadcrumb `›` separators in
`main.tsx` (Location path), `·` prose separators, `—`/`…` prose
punctuation, and the `→` hint-text arrow in REST/VNC empty-state copy.
These are typographic punctuation, not icons.

## CSV status

Marked **DONE**: T-040, T-041, T-043, T-044, T-045, T-046, T-047, T-048,
T-049.

Still **PENDING**, not started this batch: T-050 onward (Dropdown
component deepening + native-`<select>` migration), T-056 (login profile
menu → Dropdown, which is why T-057/T-058/T-059 stay blocked-by-T-056
rather than closed even though the current hand-rolled menu already
satisfies their literal wording), T-076 (MobileChoiceMenu CSS restyle,
distinct from the glyph swap done here), T-081 onward.

## Next action

Not yet committed. Next step is `git add` the 9 files above + this status
doc + the CSV, write the commit message, commit, `codegraph sync`, then
continue with T-050 (shared Dropdown component deepening) per the
existing plan -- unless told otherwise first.
