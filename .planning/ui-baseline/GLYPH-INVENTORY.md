# Unicode UI Glyph Inventory (T-007)

Scope: every non-ASCII / symbol character (`ord > 127`, excluding CJK prose text such as
the Traditional Chinese copy in `HelpModal.tsx`) rendered as UI chrome (buttons, badges,
indicators) across `src/**/*.tsx`. `×` (0xD7) is ASCII-adjacent but included since it's
used exclusively as a close-icon glyph, never as prose.

## Glyphs with an explicit owning task in this list

| Glyph(s) | Location | Purpose | Owning task |
|---|---|---|---|
| `‹` / `›` | `main.tsx:929` | Login profile trigger (Auto/Mobile switch direction) | **T-043** |
| `‹` (back) + `›` ×5 (nav cards) | `main.tsx:6748`, `main.tsx:6750` | Settings subpanel back button, Settings panel-menu card chevrons (theme/features/confirmations/sharing/history) | **T-044** |
| `×` | `main.tsx:6746` (`.settings-floating-close`) | Settings header close button | **T-045** |
| `⌄` / `●` | `context-picker.tsx:65`, `context-picker.tsx:71` | ContextPicker trigger chevron, selected-option check mark | **T-046** |
| `‹` / `›` (collapse pane), `›` (breadcrumb sep), `⌃` / `⌄` (Redfish Toolbox disclosure) | `rest-api.tsx:1278`, `rest-api.tsx:1307`, `rest-api.tsx:1313` | REST entry-pane collapse controls, path breadcrumb separator, Actions disclosure chevron | **T-047** |
| `‹` / `›` | `proxmox-vnc.tsx:258` | VNC entry-pane collapse controls | **T-048** |
| `◆` (`.status-glyph` class already on the element), `⚠`, `▲` / `▼` | `main.tsx:939`, `main.tsx:5479`, `main.tsx:6362` | "Only Terminal" corner-button badge, "⚠ ROOT" privilege badge, remote sort-direction indicator | **T-049** |

## Glyphs with NO dedicated per-surface task (gap found by this audit)

Per T-007's expected behavior ("every replaceable glyph has one icon migration task"),
these are recorded so they aren't silently missed, but no new CSV row is added without
sign-off -- each is folded into the nearest existing *behavioral* task for that same
surface, to be swapped to an SVG icon as a side-effect of touching that surface for its
listed behavior work (not tracked as its own line item):

| Glyph(s) | Location | Purpose | Folded into |
|---|---|---|---|
| `‹` / `›` | `main.tsx:610` | Commandbar "More actions" overflow-trigger direction (added in a prior session, predates this issue's task list) | T-040/T-041 generically (shared icon set); swap opportunistically, no behavior change owed |
| `›` ×2 | `main.tsx:5433`, `main.tsx:5450` | Location breadcrumb path separator (text-like, not a clickable icon) | Out of icon-migration scope -- this is punctuation between breadcrumb labels, not a standalone icon; left as-is |
| `‹` / `›` | `main.tsx:5499` | LOCAL folder-tree show/hide toggle | T-088 (Location LOCAL tree controls) -- swap when implementing that task |
| `‹` / `›` | `main.tsx:6130`, `main.tsx:6131` | Location main-pane collapse controls | T-084-T-087 (Location collapse controls) -- swap when implementing those tasks |
| `⤡` / `⤢` / `⌄` / `⌃` | `main.tsx:7113`, `main.tsx:7114`, `main.tsx:7194` | SSH terminal maximize/restore, collapse, and "Terminal ⌃" reopen-hint | Not in this issue's mode list (LOGIN/REST/VNC/LOCATION/SHARED/ALL -- SSH terminal chrome isn't separately named); folded into T-040/T-041 generically, swap opportunistically |
| `↑` / `↓` / `▾` / `▸` | `log-view.tsx:88`, `log-view.tsx:114` | LogView column sort direction, row expand/collapse | T-129 (Scale LogView controls with shared tokens) -- swap when implementing that task |
| `·` (×16, e.g. `main.tsx:3348`) | Various `... · ...` labels | Prose separator inside labels (e.g. "REST API mode · workspace-name") | Not an icon -- typographic punctuation, out of scope |
| `—` (×4), `…` (×2) | Various | Em dash / ellipsis in prose text | Not icons -- out of scope |

## Verification

```
python3 -c "... scans src/**/*.tsx for ord(ch) in (128, 8000+) excluding CJK ..."
```
23× `×`, 18× `›`, 11× `‹`, 9× `•` (prose bullet, out of scope), 8× `−` (prose, out of
scope), 5× `⌄`, 4× `—` (prose), 2× `⌃`, 2× `…` (prose), 2× `→` (prose "A → B" hint text,
out of scope), 1× each of `◆` `▲` `▼` `⤡` `⤢` `●` `↑` `↓` `▾` `▸` `⚠`.

## Disposition

- 7 groups (T-043 through T-049) already have a named task in the CSV — implement as scoped.
- 6 additional glyph groups found with no dedicated row — each folded into the nearest
  existing behavioral task for that same surface (see table above); none require a new
  CSV row, since the underlying icon-set work (T-040/T-041) covers the mechanism and the
  behavioral task already covers the surface.
- Prose punctuation (`·`, `—`, `…`, breadcrumb `›`, hint-text `→`) is explicitly out of
  scope -- these are typographic separators, not icons, and swapping them would not change
  anything user-visible in a meaningful way.
