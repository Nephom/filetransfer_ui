# Application Versioning

The repository root contains the manually maintained release metadata:

```text
 VERSION       4.0.1
 RELEASE_DATE  2026-10-19
```

The application appends the current short Git commit when the source is a Git checkout. For example:

```text
4.0.1-<short-commit> (2026-10-19)
```

If the source archive does not contain `.git`, the base version and release date remain valid:

```text
4.0.1 (2026-10-19)
```

The version resolver never contacts GitHub. A disconnected server still reports its local version. `VERSION` is the only file that changes the base version. Under the repository workflow, update `RELEASE_DATE` to the current date for every correction; it does not by itself increment `VERSION`.

WebUI and Tauri Desktop use the same resolved version. The Tauri build passes
the semver-safe value to its package metadata, while the desktop About and
login surfaces show the resolved build value. API compatibility covers
authentication, Locations, health/capabilities, browsing, refresh, search,
transfers, archive/share actions, mutations, permission/read-only behavior,
and user-facing storage errors.
