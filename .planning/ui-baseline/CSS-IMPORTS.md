# Global Stylesheet Import Audit (T-004)

23 CSS files exist under `fileapi_ui/src/`; all 23 are imported somewhere (no orphans).

## Eager-loaded from `main.tsx` (18 files, load order matters -- later files win on
conflicting selectors)

| # | File | Primary owner in this task list |
|---|------|----------------------------------|
| 1 | `styles/tokens.css` | T-008 (central design tokens) |
| 2 | `styles/overlays.css` | T-015 (overlay z-index tokens), T-077 (portaled dropdown surfaces) |
| 3 | `login.css` | T-036/T-037 (login breakpoints), T-056-T-059 (login profile Dropdown) |
| 4 | `location-control.css` | T-081-T-098 (Location collapse controls, commandbar overflow) |
| 5 | `context-picker.css` | T-046 (direction glyphs), T-075 (ContextPicker restyle) |
| 6 | `settings.css` | T-044/T-045 (Settings glyphs), T-061-T-063 (Settings Dropdowns), T-127 (scale tokens) |
| 7 | `account-menu.css` | T-124 (scale account control) |
| 8 | `tls.css` | not directly touched by this task list |
| 9 | `webui-shell.css` | not directly touched by this task list |
| 10 | `explorer-parity.css` | T-050/T-054 (Dropdown), SSH/REST/VNC entry-modal styling (prior work) |
| 11 | `desktop-ui.css` | T-028-T-034 (fluid typography/control scale, density tiers, T-152) |
| 12 | `starship-bridge.css` | not directly touched by this task list |
| 13 | `styles/theme-overrides.css` | T-139 (four color themes) |
| 14 | `styles/surface-overrides.css` | not directly touched by this task list |
| 15 | `styles/mode-switcher.css` | T-123 (titlebar mode controls scale) |
| 16 | `styles/vnc-interactions.css` | T-119-T-122 (VNC collapse/toolbar) |
| 17 | `styles/commandbar.css` | T-092-T-098, T-125, T-153-T-159 (commandbar overflow menu) |
| 18 | `styles/mobile-ui.css` | T-020-T-023, T-033-T-034 (shared mobile floors) |

## Lazy-loaded, scoped to their own feature chunk (5 files -- own dialogs/menus must not
depend on chunk having loaded already if opened from elsewhere, see prior REST/VNC entry
dialog fix)

| File | Loaded by | Owner in this task list |
|------|-----------|--------------------------|
| `rest-api.css` | `rest-api.tsx` (React.lazy chunk) | T-064-T-071, T-099-T-114 (REST Dropdowns/menus/disclosures) |
| `proxmox-vnc.css` | `proxmox-vnc.tsx` (React.lazy chunk) | T-072-T-074, T-115-T-122 (VNC Dropdowns/menus/collapse) |
| `log-view.css` | `log-view.tsx` (React.lazy chunk) | T-129 (LogView controls scale) |
| `help/help.css` | `HelpModal.tsx` (React.lazy chunk) | T-128 (Help controls scale) |
| `ui/mobile-choice-menu.css` | `MobileChoiceMenu.tsx` (imported wherever the component is used) | T-076 (restyle with Dropdown tokens) |
| `ui/dropdown.css` | `Dropdown.tsx` (imported wherever the component is used) | T-054 (already created this session) |

## Verification

```
grep -rn '^import.*\.css' src/       # 23 import statements
find src help -iname '*.css'         # 23 files
```
Both lists match 1:1 -- no unimported CSS file, no import pointing at a missing file.
