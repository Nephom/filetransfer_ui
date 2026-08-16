# Superseded tasks: density tiers removed (T-030, T-031, T-032, T-152, T-141)

**Decision date:** this session, before issue-194 CSV work began.
**Confirmed by user:** explicit question asked, user chose "標記為 WONT_DO (Recommended)".

## What happened

Earlier in this session (before issue-194 CSV execution started), the user explicitly
requested removing the manual "Interface Size" control (`uiDensity`: compact/standard/
comfortable, 80/100/120%) and replacing it with continuous `clamp()`/`vmin`-based
auto-scaling driven by window size. This shipped in commit `a82e1b3` (`feat(ui): replace
manual Interface Size with continuous window-size-based font scaling`). All
`uiDensity`/`compact`/`comfortable` code is gone from `desktop-ui.css` and `main.tsx`.

The issue-194 CSV task list, written before that decision, still contains 5 tasks that
assume density tiers exist as a fixed-multiplier feature:

- **T-030** "Keep compact density as a fixed multiplier"
- **T-031** "Keep standard density as the shared base"
- **T-032** "Keep comfortable density as a fixed multiplier"
- **T-152** "Make the density tiers visibly different sizes"
- **T-141** "Verify manual density remains independent from profile selection"

These directly contradict the shipped decision (there is no manual density control to keep
tiers for, or to verify independence against). Re-introducing density tiers now would
directly reverse work the user explicitly asked for and already has in production.

## Resolution

All 5 marked **WONT_DO** in the CSV, not DONE and not PENDING -- they describe a feature
that was deliberately removed, not a feature that's unimplemented. T-028/T-029 (Auto fluid
typography/control scale) are unaffected and remain the correct, current mechanism.

## Dependency cleanup

- **T-033** ("Keep Mobile controls above the minimum touch size") listed
  `T-022; T-030; T-031; T-032` as `blocked_by`. Its actual dependency is only on T-022 (the
  mobile control-height floor already being in tokens, done) -- it does not need density
  tiers to exist, since Mobile's minimum touch size comes from `--control-height-mobile`
  regardless of density. Updated `blocked_by` to `T-022` only.
- **T-141**'s own `blocked_by` (`T-030; T-031; T-032; T-060`) is moot since T-141 itself is
  now WONT_DO.
