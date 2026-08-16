# Dropdown / Custom Menu Inventory (T-006)

## Native `<select>` elements — 11 total

### `main.tsx` (3) — target: replace with `Dropdown`
| Line | Purpose | Owning task |
|---|---|---|
| 6755 | Settings → color theme | T-061 |
| 6812 | Settings → default share-link expiration | T-062 |
| 6835 | Settings → operation log level | T-063 |

### `rest-api.tsx` (8) — target: replace with `Dropdown`
| Line | Purpose | Owning task |
|---|---|---|
| 1285 | Authentication mode | T-064 |
| 1303 | HTTP method (GET/POST/PATCH) | T-065 |
| 1220 (1st) | BIOS attribute picker | T-066 |
| 1220 (2nd) | BIOS allowable-values editor | T-067 |
| 1314 | Redfish action parameter (allowable values) | T-068 |
| 1319 (1st) | IML severity filter | T-069 |
| 1319 (2nd) | IML polling interval | T-070 |
| 1322 | Firmware update target | T-071 |

### `proxmox-vnc.tsx` (0) — already migrated to `Dropdown` this session (PVE version,
Node, VM selects were the original T-072/T-073/T-074 targets; verified via grep, zero
`<select` remain in this file). **T-072/T-073/T-074 already satisfied.**

## Custom (non-native) menu/dropdown implementations — 5 total

| Component | File | Used for | Owning task |
|---|---|---|---|
| `PaletteSelect` | `main.tsx:432` | SSH Workspace picker, SSH entry picker (inside terminal panel) | Chevron icon already migrated (T-042, done); not itself a target of T-050 (already keyboard/outside-click/focus capable, predates this issue) |
| Login profile menu | `main.tsx:928` (inline, not a component) | Login screen profile switch (Auto/Mobile) | T-056 (replace with `Dropdown`), T-057/T-058 (keep Auto/Mobile options), T-059 (remove helper paragraph) |
| `ContextPicker` | `context-picker.tsx` | Location mode context switch | T-075 (restyle with Dropdown tokens); not a native-select replacement target since it's already a custom listbox |
| `MobileChoiceMenu` | `ui/MobileChoiceMenu.tsx` | REST entry choice, REST vendor choice, VNC entry choice, mobile app-mode switch (`DesktopTitlebar.tsx`) | T-076 (restyle with Dropdown tokens); satisfies T-099/T-103/T-115 (one current-choice menu per concern) already |
| `Dropdown` (shared) | `ui/Dropdown.tsx` | Already used for Proxmox VNC's version/Node/VM selects | T-050 (create), T-051-T-053 (behavior), T-054 (stylesheet) — created this session, is the *target* component every native `<select>` above migrates to |

## Verification

```
grep -n "<select" src/*.tsx src/**/*.tsx     # 11 matches, 0 in proxmox-vnc.tsx
grep -rn "role=\"menu\"\|role=\"listbox\"" src/  # 5 files with custom menu/listbox roles
```

## Disposition

- 11 native selects → migrate to shared `Dropdown` (T-061 through T-071; T-072-074 already done).
- `PaletteSelect`/`ContextPicker`/`MobileChoiceMenu` are pre-existing custom implementations,
  not native selects — they get *stylesheet* alignment with the new Dropdown's shared tokens
  (T-075, T-076) rather than a full component swap, since they already have their own
  keyboard/focus/outside-click handling suited to their specific UX (SSH picker needs
  `menuPlacement`, MobileChoiceMenu needs the "current choice + tap to change" mobile pattern
  ContextPicker needs grouped options) that a single generic `Dropdown` doesn't cover 1:1.
