# Application Versioning

The repository root contains the manually maintained release metadata:

```text
 VERSION       4.0.2
 RELEASE_DATE  2026-10-19
```

The application appends the current short Git commit when the source is a Git checkout. For example:

```text
4.0.2-<short-commit> (2026-10-19)
```

If the source archive does not contain `.git`, the base version and release date remain valid:

```text
4.0.2 (2026-10-19)
```

The web UI version is resolved by the running server from the environment variable `APP_VERSION_CHANNEL`:

| Value | Shown version |
| --- | --- |
| `pre` (default) | `4.0.2-pre<short-commit> (2026-10-19)` |
| `ga` | `4.0.2 (2026-10-19)` |

`./build.sh upgrade [pre|ga]` saves the chosen value in the local, untracked `.env`; restart the service afterwards (`./restart.sh`, or `./start.sh` when it is stopped). `./build.sh upgrade` without a channel leaves the saved value unchanged.

The version resolver never contacts GitHub. A disconnected server still reports its local version. `VERSION` is the only file that changes the base version. Under the repository workflow, update `RELEASE_DATE` to the current date for every correction; it does not by itself increment `VERSION`.

WebUI and Tauri Desktop use the same resolved version. The Tauri build passes
the semver-safe value to its package metadata, while the desktop About and
login surfaces show the resolved build value. API compatibility covers
authentication, Locations, health/capabilities, browsing, refresh, search,
transfers, archive/share actions, mutations, permission/read-only behavior,
and user-facing storage errors.
