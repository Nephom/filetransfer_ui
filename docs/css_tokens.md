# Frontend CSS custom-property reference

This is the shared CSS variable contract for `fileapi_ui`. Location, REST API,
VNC, login, overlays, and shared controls consume the same tokens. The source
of truth is `fileapi_ui/src/styles/tokens.css`; `starship-bridge.css` supplies
the default `--bridge-*` palette, and `styles/theme/*.css` can override
semantic values when a theme is selected.

## Variable layers

1. **Bridge palette (`--bridge-*`)** contains the visual material values.
2. **Semantic tokens (`--color-*`, spacing, typography, controls, surfaces)**
   are what feature CSS should use.
3. **Profile aliases (`--ui-*`)** are set by `styles/mobile-ui.css` for the
   Large profile and otherwise fall back to the base tokens.
4. **Component-local runtime variables** are temporary layout values owned by
   a component (for example REST dialog offsets), not theme tokens.

Feature CSS should not hard-code a palette value when a semantic token exists.
A literal value is appropriate only for a feature-specific measurement or a
fallback that cannot be represented by the shared scale.

## Semantic color tokens

| Variable | Purpose |
|---|---|
| `--color-bg` | Darkest application/page background. |
| `--color-bg-panel` | Normal translucent panel surface: panes, cards, sidebars. |
| `--color-bg-panel-strong` | Dense/nested panel surface, toolbar wells, auth controls. |
| `--color-bg-popover` | Dropdown, context menu, and other floating popover surface. |
| `--color-text` | Primary readable text and headings. |
| `--color-text-muted` | Secondary text, labels, placeholders, help, and status details. |
| `--color-primary` | Main cyan accent: focus, links, active borders, and primary controls. |
| `--color-secondary` | Blue secondary accent, commonly used in gradients with primary. |
| `--color-success` | Positive state: online, authenticated, completed, readable capability. |
| `--color-warning` | Caution/active state: TLS warning, destructive tool, retry, session state. |
| `--color-danger` | Error/destructive state: unavailable, failed request, delete action. |
| `--color-border` | Normal panel/control 1px border. |
| `--color-border-strong` | Brighter emphasized border; use when normal border is insufficient. |

These aliases point to `--bridge-void`, `--bridge-panel`, `--bridge-panel-strong`,
`--bridge-popover`, `--bridge-text`, `--bridge-muted`, `--bridge-cyan`,
`--bridge-blue`, `--bridge-green`, `--bridge-amber`, `--bridge-red`,
`--bridge-line`, and `--bridge-line-bright`, respectively.

## Bridge material variables

Defined in `styles/starship-bridge.css`, these are the default theme's visual
source values. Theme code may replace them; feature/layout CSS should generally
consume the semantic aliases above.

| Variable | Purpose |
|---|---|
| `--bridge-void` | Page void/background. |
| `--bridge-space` | Deep secondary space color used by the Bridge visual layer. |
| `--bridge-panel` | Standard glass panel fill. |
| `--bridge-panel-soft` | Lighter/softer panel fill for nested surfaces. |
| `--bridge-panel-strong` | Opaque/strong glass panel fill. |
| `--bridge-popover` | Popover fill. |
| `--bridge-account-popover` | Account-menu-specific popover fill. |
| `--bridge-popover-border` | Popover border emphasis. |
| `--bridge-popover-shadow` | Popover elevation, inset highlight, and glow. |
| `--bridge-popover-blur` | Popover backdrop-filter value. |
| `--bridge-glass-shadow` | Standard panel glass shadow. |
| `--bridge-inset` | Inset highlight/shadow used on glass surfaces. |
| `--bridge-glow-shadow` | Accent glow shadow. |
| `--bridge-line` | Normal Bridge border line. |
| `--bridge-line-bright` | Bright Bridge border/accent line. |
| `--bridge-text` / `--bridge-muted` | Primary and muted Bridge text. |
| `--bridge-cyan` / `--bridge-blue` | Primary and secondary accent colors. |
| `--bridge-green` / `--bridge-amber` / `--bridge-red` | Success, warning, and danger colors. |
| `--bridge-radius` / `--bridge-radius-sm` | Standard and compact Bridge radii. |
| `--bridge-transition` | Default Bridge transition duration/easing. |

## Spacing, typography, and font tokens

| Variable | Purpose/value |
|---|---|
| `--space-1` | Smallest spacing step (3.2px). |
| `--space-2` | Small spacing step (6.4px), common control gap. |
| `--space-3` | Medium spacing step (9.6px), common panel padding. |
| `--space-4` | Large spacing step (12.8px). |
| `--space-5` | Extra-large spacing step (19.2px), outer margins. |
| `--space-6` | Largest spacing step (25.6px), roomy dialog/panel spacing. |
| `--font-size-base` | Fluid Auto-profile body/control text (`clamp`). |
| `--font-size-small` | Fluid helper/label/small text. |
| `--font-size-heading` | Fluid section/reader heading text. |
| `--font-size-mobile-base` | Fixed 12.8px Large-profile base text. |
| `--font-size-mobile-small` | Fixed 11.2px Large-profile small text. |
| `--font-size-mobile-heading` | Fixed 22.4px Large-profile heading text. |
| `--font-size-mobile-narrow-small` | Narrow/short Large-profile small-text floor (9.6px). |
| `--font-family-ui` | UI font stack: Segoe UI/system sans. |
| `--font-family-mono` | Code/path/terminal font stack. |

`ui-layout-mobile` means the project's **Large** profile. It enlarges the
normal desktop UI; it is not a phone breakpoint. Actual stacking still uses
media queries in the relevant layout files.

## Control, panel, and icon tokens

| Variable | Purpose |
|---|---|
| `--control-height-base` | Fluid Auto-profile button/input height (24–32px). |
| `--button-height-base` | Alias of `--control-height-base` for button rules. |
| `--control-gap-base` | Fluid standard gap between controls. |
| `--panel-padding-base` | Fluid standard panel padding. |
| `--control-height-mobile` | Fixed 32px common toolbar/control height. |
| `--control-height-mobile-lg` | Fixed 35.2px comfortable Large-profile target. |
| `--control-focus-ring` | Shared focus ring (`2px solid --color-primary`). |
| `--icon-size` | Normal inline icon size (14.4px). |
| `--icon-size-lg` | Large pane-collapse/toolbar icon size (27.2px). |
| `--app-mark-width` / `--app-mark-height` | Titlebar app-mark dimensions. |
| `--terminal-min-height-mobile` | Minimum terminal height in Large profile. |
| `--pane-min-size-mobile` | Minimum Location split-pane footprint (208px). |
| `--file-table-header-height-mobile` | Large-profile file-table header height (33.6px). |
| `--file-row-padding-inline-mobile` | Large-profile file-row horizontal padding (8px). |
| `--folder-tree-max-height-mobile-narrow` | Folder-tree height ceiling in narrow Large windows (176px). |
| `--radius-sm` / `--radius-md` | Compact control and normal panel radii. |
| `--shadow-panel` / `--shadow-inset` / `--shadow-glow` | Shared panel elevation, inset highlight, and accent glow. |
| `--transition-fast` | Shared fast interaction transition. |
| `--motion-fast` / `--motion-base` | Named fast/base animation scales. |

## Popover and stacking tokens

| Variable | Purpose |
|---|---|
| `--dropdown-menu-gap` | Gap between trigger and dropdown menu (4.8px). |
| `--dropdown-trigger-radius` | Radius of a dropdown-like trigger. |
| `--dropdown-menu-radius` | Radius of its floating menu. |
| `--dropdown-border` | Shared dropdown border declaration. |
| `--dropdown-surface` | Shared dropdown surface alias. |
| `--dropdown-option-radius` | Option-row radius. |
| `--dropdown-option-padding` | Option-row padding. |
| `--dropdown-focus-ring` | Dropdown option focus ring. |
| `--z-dropdown` | Ordinary dropdown layer (400). |
| `--z-context` | Context/help popover layer (450). |
| `--z-modal` | Modal/floating dialog layer (500). |
| `--z-toast` | Notification/toast layer (600). |

`Dropdown`, `ContextPicker`, `MobileChoiceMenu`, and
`CommandBarOverflowMenu` must use this contract so their popovers remain
visually interchangeable.

## Profile aliases and feature-local variables

`styles/desktop-ui.css` defines the Auto profile's fluid `--ui-*` values on
`:root`; `styles/mobile-ui.css` replaces them with fixed Large-profile values.
These aliases let all features use one sizing vocabulary:

| Variable | Purpose |
|---|---|
| `--ui-font-size`, `--ui-small-font-size`, `--ui-heading-font` | Large-profile body, small, and heading text. |
| `--ui-control-height`, `--ui-control-gap` | Large-profile control height and gap. |
| `--ui-button-height`, `--ui-button-padding-x`, `--ui-button-padding-y` | Large-profile button geometry. |
| `--ui-panel-padding`, `--ui-section-gap` | Large-profile panel/section spacing. |
| `--ui-terminal-min-height` | Large-profile terminal minimum. |
| `--mobile-ui-background`, `--mobile-ui-border`, `--mobile-ui-control-height`, `--mobile-ui-focus` | Mobile/large component background, border, height, and focus aliases. |
| `--mobile-ui-font`, `--mobile-ui-secondary-font`, `--mobile-ui-heading-font` | Large-profile typography aliases. |
| `--mobile-ui-gap`, `--mobile-ui-padding` | Large-profile gap and padding aliases. |
| `--mobile-ui-menu-z` | Large-profile popup stacking alias. |

`--ui-x` is mentioned in an old explanatory comment in `desktop-ui.css` but
is not defined or consumed by the current stylesheet; it is not a supported
custom-property token.

`--controls-row` and `--screen-row` are optional fallback variables consumed
by `styles/vnc-interactions.css` to divide the VNC display between controls and
the screen. They are not normally set by Location or REST mode.

Some component styles define a variable only within their own selector:

| Variable | Owner/use |
|---|---|
| `--controls-row` | Shared layout value for controls arranged in a row. |
| `--screen-row` | VNC screen/display row sizing. |
| `--iml-control-height` | REST IML toolbar's compact 26px controls. |
| `--rest-dialog-x`, `--rest-dialog-y` | REST action/hardware dialog drag offsets, set inline at runtime. |

These local variables are not global theme API. Preserve their owner and
fallback when editing the component CSS.

## Theme runtime mapping

`styles/theme.ts` exposes four presets: `bridge` (blue/cyan), `graphite`
(violet), `emerald` (green), and `tech-silver` (silver/blue). `themeStyle()`
converts the selected preset and optional validated `#rrggbb` accent into
inline custom properties on `AppShell` and the document root. The accent
replaces `--bridge-cyan` and `--bridge-line-bright`, and becomes
`--color-primary`/`--color-border-strong`; warning, danger, success, text,
and muted remain the preset semantic colors. This is why portaled menus,
modals, REST help, and Location panes recolor together: they inherit from
`document.documentElement` even when rendered outside `AppShell`.

`accentCollidesWithSemanticColor()` compares the selected accent with the
preset warning/danger colors and is only a usability warning; it does not
bypass or change action permissions.

## Ownership rules

- `styles/tokens.css`: semantic tokens and shared scales.
- `styles/starship-bridge.css` and `styles/theme/*.css`: theme-sensitive
  colors, surfaces, borders, shadows, and final theme overrides.
- `styles/layout/*.css`: Location/Explorer geometry and component layout.
- `rest-api.css` and `proxmox-vnc.css`: feature-local geometry and states.
- `mobile-ui.css`: Large profile aliases/overrides.

When adding a CSS variable, document its purpose here and add it at the layer
that owns it. Do not create a feature-specific color alias when an existing
semantic color token is sufficient.
