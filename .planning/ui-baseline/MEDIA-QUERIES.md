# Viewport Media-Query Audit (T-005)

`grep -rn "@media" src/ --include="*.css"` in `fileapi_ui/` — every `max-width`/`max-height`
rule below, grouped by why it exists.

## Group A — Profile-boundary rule (mirrors the shared JS mobile resolver)

The shared resolver in `styles/breakpoints.ts` treats `width <= 1024 || height <= 768` as
Mobile. The CSS-side mirror of that exact boundary appears in exactly one place:

- `login.css:40` — `@media (max-width: 1023px), (max-height: 767px)`
  (referenced by a comment in `tls.css:43`)

This is the literal target of **T-036** ("Replace the 1023px login breakpoint with the
shared profile class") — it's a duplicate, hand-maintained mirror of `breakpoints.ts` and
should become a `.ui-layout-mobile`-style class check instead, same as `DesktopApp` already
does via the shared resolver (T-026, done).

## Group B — Generic "stack layout at 720px" rules (component-intrinsic, NOT profile rules)

`720px` shows up as a de-facto shared narrow-layout breakpoint across unrelated components.
These do **not** currently reference the shared resolver at all -- they fire purely off
raw CSS viewport width, independent of whether the user picked Mobile/Auto/Desktop profile:

| File:line | Rule |
|---|---|
| `explorer-parity.css:10` | `.desktop-workspace` column stack |
| `explorer-parity.css:329` | `.sessions-layout` single column |
| `explorer-parity.css:330` | `.terminal-header` stack |
| `explorer-parity.css:331` | `.split-workspace` stack |
| `login.css:32` | (login layout narrow adjustments) |
| `settings.css:46` | (Settings panel narrow adjustments) |
| `styles/overlays.css:49` | (overlay narrow adjustments) |
| `styles/mode-switcher.css:104` | (mode switcher narrow adjustments) |
| `desktop-ui.css:39`, `desktop-ui.css:177` | (desktop shell narrow adjustments) |
| `starship-bridge.css:485` | (bridge narrow adjustments) |
| `help/help.css:45` | `.help-modal` narrow width |
| `log-view.css:32` | `.log-view-modal` narrow width |
| `location-control.css:24` | `.location-control` narrow adjustments |
| `proxmox-vnc.css:22` | `.vnc-workspace` column stack |
| `rest-api.css:174` | `.rest-workspace` column stack |
| `explorer-parity.css:113` | `.vnc-entry-modal .vnc-form-grid` single column |

**T-038** ("Replace explorer profile media rules with layout classes") targets the subset of
these that exist purely to detect "are we in the Mobile profile" and duplicate what
`.explorer.ui-layout-mobile` (an existing class already driven by the shared resolver, see
`proxmox-vnc.css`'s own `.explorer.ui-layout-mobile .vnc-*` rules) already expresses more
directly. Rules that are genuinely about "this specific component ran out of horizontal
room" (independent of profile, e.g. a modal on a narrow desktop window) are explicitly kept
raw per **T-039**.

## Group C — Modal/overlay overflow rules at (900px, 640px) — explicitly NOT profile rules

The exact same compound query, verbatim, appears in 4 unrelated files -- this is a shared
"this modal doesn't fit in a short/narrow desktop window" rule, unrelated to Mobile-profile
detection:

- `rest-api.css:249` — `@media (max-width: 900px), (max-height: 640px)`
- `explorer-parity.css:341` — same
- `desktop-ui.css:198` — same
- `proxmox-vnc.css:46` — same

This is exactly what **T-039** ("Retain only genuine narrow-height login media rules" /
"modal overflow media rules that are not profile rules") means to keep as-is: a real desktop
window can be 900px wide and still need a modal to reflow, regardless of Mobile-profile
selection.

## Group D — Other narrow-width modal/grid rules, independent of profile

| File:line | Rule |
|---|---|
| `rest-api.css:173` | `max-width: 900px` — `.rest-auth-fields`/`.rest-login-config` 2-col grid |
| `rest-api.css:175` | `max-width: 540px` — `.rest-reader-heading` stack |
| `rest-api.css:227` | `max-width: 600px` — `.rest-bios-grid` single column |
| `styles/commandbar.css:92` | `max-width: 900px` |
| `styles/commandbar.css:97` | `max-width: 640px` |
| `styles/surface-overrides.css:195` | `max-width: 640px` |
| `styles/surface-overrides.css:200` | `max-height: 760px` **and** `min-width: 641px` (compound, deliberately excludes the ≤640px case already handled by the rule above) |
| `styles/surface-overrides.css:208` | `max-height: 620px` |
| `log-view.css:33` | `max-width: 540px` — `.log-view-modal` very narrow |
| `help/help.css:52` | `max-width: 540px` — `.help-modal` very narrow |

## Group E — Non-viewport media rules (accessibility, not a breakpoint)

- `rest-api.css:272` — `@media (prefers-reduced-motion: reduce)`
- `starship-bridge.css:481` — `@media (prefers-reduced-motion: reduce)`

These satisfy the accessibility rule selected in T-001 (#5, `prefers-reduced-motion`
respected) but only 2 of the ~9 files that add hover/transition effects have one. Not part
of this task's scope to expand, noted for awareness only.

## Disposition summary

- **1** rule (Group A) is a duplicate profile-boundary mirror → replace with shared class (T-036).
- **~16** rules (Group B) are candidates for `.ui-layout-mobile`-class replacement where they
  duplicate profile detection, kept raw where they're genuinely about component width (T-038).
- **~14** rules (Groups C+D) are genuine "not enough room for this modal/grid" rules,
  unrelated to profile selection, explicitly retained (T-039).
