# Application Versioning

The repository root contains the manually maintained release metadata:

```text
 VERSION       3.3.3
 RELEASE_DATE  2026-08-14
```

The application appends the current short Git commit when the source is a Git checkout. For example:

```text
3.3.3-<short-commit> (2026-08-14)
```

If the source archive does not contain `.git`, the base version and release date remain valid:

```text
3.3.3 (2026-08-14)
```

The version resolver never contacts GitHub. A disconnected server still reports its local version. `VERSION` is the only file that changes the base version; update `RELEASE_DATE` only for the corresponding release.

WebUI and Tauri Desktop use the same resolved version. The Tauri build passes
the semver-safe value to its package metadata, while the desktop About and
login surfaces show the resolved build value. API compatibility covers
authentication, Locations, health/capabilities, browsing, refresh, search,
transfers, archive/share actions, mutations, permission/read-only behavior,
and user-facing storage errors.
