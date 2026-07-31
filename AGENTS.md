# Repository Instructions

Read [docs/PROJECT_RULES.md](docs/PROJECT_RULES.md) before changing this repository.

Every implementation must have an open GitHub issue in `Nephom/filetransfer_ui`. Run `gh issue list --state open` before work. Keep an issue open after automated sandbox tests pass; add `verified` and wait for user validation before it is closed.

Treat [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md) as the API contract. Update the README and documentation with every client, API, or behaviour change. Upload, download, archive, and progress changes require sandbox integration tests that do not use production storage.

`fileapi.sh` is deprecated and is not a compatibility target.

Never add real internal addresses, private DNS names, credentials, tokens, or certificate material to tracked files, commit messages, GitHub issues, comments, pull requests, or release notes. Use neutral hostnames such as `files.example.internal`; actual deployment values belong in ignored local configuration.
