# Accessibility & Interaction Rules Selected for nFterm (dark file-transfer desktop app)

Source: `ui-ux-pro-max` design-system search, `.opencode/skills/ui-ux-pro-max/scripts/search.py`
Full raw output: `MASTER.md` in this directory (generic marketing-site scaffold; colors/
typography/landing-page pattern in that file do NOT apply to this project and are ignored --
this app already has its own dark theme tokens in `fileapi_ui/src/styles/tokens.css` and
`theme-overrides.css`). Only the accessibility/interaction rules below are adopted, because
they are stack-agnostic and match issue-194's stated goals (touch targets, keyboard nav,
reduced motion, focus visibility).

## Selected rules (apply across all issue-194 tasks)

1. **No emoji-as-icon.** Every icon must be an SVG (matches T-040 shared icon set).
2. **Visible focus states on every interactive control**, including custom Dropdown
   triggers and menu items (matches T-078).
3. **Pointer cursor on every clickable element**, including custom Dropdown triggers,
   collapse controls, and overflow-menu items (matches T-079).
4. **Transitions on hover/state changes, 150-300ms**, not instant flips -- applies to
   Dropdown open/close, collapse-pane show/hide, overflow-menu open/close.
5. **`prefers-reduced-motion` respected** for any new transition/animation added by this
   issue (Dropdown, collapse panes, overflow menu).
6. **Minimum contrast 4.5:1** for text against its background, re-checked wherever new
   dark-theme tokens are introduced (T-008 central token file).
7. **No content hidden behind fixed chrome** -- relevant to keeping the commandbar
   overflow menu (T-153) and portaled dropdowns (T-077) from covering interactive content
   they didn't replace.
8. **Keyboard navigation must work end-to-end** for every menu that replaces a native
   `<select>` (matches T-051/T-133): Arrow keys move selection, Enter/Space commits,
   Escape closes and returns focus to the trigger (T-052).
9. **Responsive checks at explicit breakpoints** -- adapted for this project's own
   breakpoints (defined in `fileapi_ui/src/styles/breakpoints.ts`), not the generic
   375/768/1024/1440 set, since T-024/T-025 already replaced ad-hoc comparisons with the
   shared mobile resolver.

## Explicitly NOT adopted from the raw search output

- Color palette (`#1C1917` / `#CA8A04` / etc.) -- this project already has its own
  dark-theme color tokens; do not introduce a second palette.
- Typography choice ("Atkinson Hyperlegible") -- out of scope for issue-194, which only
  asks to centralize whatever font is already in use (T-016), not change it.
- "Video-First Hero" landing-page pattern, button/card/modal component CSS snippets --
  this is a desktop file-transfer utility, not a marketing landing page; not applicable.
