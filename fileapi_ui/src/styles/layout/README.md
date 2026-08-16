# styles/layout/ -- Location/Explorer layout modules (T-202 follow-up)

This directory replaces the former monolithic `styles/explorer-parity.css`
(543 lines covering the folder tree, file table/grid, terminal dock,
Workspace Manager dialogs, Queue/Settings/Viewer dialogs, LOCAL/REMOTE
Split panes, pane-collapse controls, and generic button semantics all in
one file). Each module below owns one coherent feature area instead of
"whatever got added to explorer-parity.css next".

## Load order

`styles/index.css` imports these files, in this exact order, matching the
original file's top-to-bottom rule order exactly (so the cascade is
byte-for-byte unchanged from before the split):

1. `folder-tree.css` -- workspace shell, REMOTE folder tree, search, view
   switch (Details/Grid), file grid/tile.
2. `context-menu.css` -- right-click context menu, marquee/text-selection
   suppression.
3. `workspace-dialogs.css` -- Workspace Manager (Sessions modal), share
   links, SSH/REST/VNC entry editor dialogs.
4. `file-table.css` -- Details-view file table, column sorting, the
   directory-first toggle.
5. `terminal.css` -- SSH terminal dock, tabs, quick list, profile
   selector.
6. `queue-settings-dialogs.css` -- Queue modal, Settings modal, Viewer
   modal, archive-format and log-name dialogs.
7. `panes.css` -- persistent scrollbar rail, Split mode's LOCAL pane
   (breadcrumbs/actions/tree/file list/privileged styling), Mobile/Large
   narrow-window stacking rules.
8. `collapse-controls.css` -- Location's [<]/[>] pane-collapse rail,
   native `<select>` styling, the generic `.modal`/`.modal-cover` shell.
9. `buttons.css` -- generic desktop button semantics (confirm/danger/
   ghost) and the shared modal-actions/ssh-entry-actions button family.

These load in the *middle* tier of `styles/index.css` (after tokens/
overlays, before the `styles/theme/` override modules), same position the
original `explorer-parity.css` import held.

## Ownership rule going forward

- This directory owns *layout* (flex/grid/width/height/padding/margin/
  position) for Location's Explorer surface and its dialogs.
- Theme-sensitive color/background/border/box-shadow for these same
  selectors lives in `styles/theme/` instead (see
  `styles/theme/README.md`), not here -- if you're setting a *color* that
  should change with the active theme preset, it likely belongs there.
- Before adding a new rule, check which of the 9 files above the
  selector's feature area matches, and add it there. Only create a new
  file in this directory if none of the 9 existing modules are a good fit
  for a genuinely new feature area.
