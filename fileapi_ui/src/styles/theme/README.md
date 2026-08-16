# styles/theme/ -- theme-sensitive override modules (T-202)

This directory replaces the former two monolithic files
`styles/theme-overrides.css` (383 lines) and `styles/surface-overrides.css`
(233 lines). Both files owned overlapping selectors with no documented
boundary between them (some selectors' color/background/box-shadow were
declared in *both* files with different values, relying entirely on import
order in `styles/index.css` to pick a winner) -- the split below gives every
themed surface exactly one home, grouped by the feature it belongs to
instead of by "which override file happened to add it first".

## Load order

`styles/index.css` imports these files, in this exact order, as the very
last stylesheets loaded (after every layout/component CSS) so they always
win the cascade for anything they target:

1. `base.css` -- generic explorer surface, buttons/inputs, titlebar/
   commandbar/navigation/statusbar, modal text, danger/log-level colors.
2. `location-controls.css` -- LocationControl, ContextPicker trigger,
   account trigger, and the shared dropdown-like popover family
   (`.location-menu` / `.context-menu` / `.context-picker-popover` /
   `.palette-select-menu`).
3. `location-panes.css` -- LOCAL/REMOTE panes, folder tree, terminal dock
   and SSH controls.
4. `rest.css` -- REST API mode (entry rail, request editor, response
   viewer, vendor toggle, actions, dialogs).
5. `vnc.css` -- VNC entry pane, reader, auth panel, display toolbar.
6. `help.css` -- HelpModal.
7. `log-view.css` -- LogView.
8. `dialogs.css` -- Queue/Viewer/Sessions/Share-links/Workspace dialogs,
   REST help popovers, generic `.modal`/`.modal-cover`, and the portaled
   `.account-menu` surface (background/blur/shadow -- this is the file that
   wins for `.account-menu`'s *background*; `location-controls.css`'s
   `.account-menu` rule only sets border-color/background as part of the
   shared dropdown-menu family and is intentionally shadowed here for that
   one property, by load order, the same way it always was pre-split).
9. `login.css` -- login screen (both the color-only rule block and the
   layout-with-color rule block that used to live in two separate files).

## Ownership rule going forward

- A selector's *color/background/border/box-shadow that must change when
  the active theme preset (theme.ts) or accent color changes* belongs in
  one of these files, and in exactly one of them.
- A selector's *layout* (flex/grid/width/height/padding/margin/position)
  belongs in the feature's own CSS file (e.g. `styles/explorer-parity.css`,
  `styles/rest-api.css` co-located with rest-api.tsx, etc.), not here.
- Before adding a new rule to any file in this directory, grep the other
  files in this directory for the same selector first. If it already
  exists elsewhere, add your property to the existing rule (or a new rule
  right next to it in the same file) instead of creating a second,
  differently-valued declaration for the same selector in a different file.

## Known pre-existing duplication not yet fully merged

`location-controls.css`'s shared dropdown-menu rule and `dialogs.css`'s
portaled `.account-menu` rule both still touch `.account-menu`'s
background, by design (see point 8 above) -- collapsing that into one
declaration is tracked separately (a true property-level merge across the
whole former file pair, rather than just relocating each rule to its
logical home) because it touches recently-fixed login/account-menu
rendering and needs a dedicated visual regression pass, not a
copy-and-move refactor. See the Phase 2 task list for the follow-up task.
