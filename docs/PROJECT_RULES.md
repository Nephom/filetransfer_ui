# Project Rules

These rules apply to every change in this repository.

## Issue Workflow

1. Read the open GitHub issues for `Nephom/filetransfer_ui` before beginning work.
2. Implement work only when it has an open GitHub issue. Create an issue first when approved work has none.
3. Keep issues open after automated sandbox verification. Add the `verified` label only when the relevant tests pass.
4. Only the user closes issues after validating the change in the target environment.
5. Keep the epic issue updated when a change affects multiple child issues.

## Change Requirements

1. Update `README.md`, `docs/`, and the API reference for every API, client, or behaviour change.
2. Treat upload, download, archive, and progress APIs as compatibility-sensitive. Add or update sandbox integration tests before changing them.
3. Tests must create temporary storage and configuration. Do not require this development machine's production storage layout.
4. The deprecated `fileapi.sh` client is not a supported API consumer and must not determine API compatibility.
5. Preserve the API contract documented in [API_REFERENCE.md](./api/API_REFERENCE.md), or document and test an approved contract change.
6. Do not add real internal addresses, private DNS names, credentials, tokens, or certificate material to tracked files or GitHub communications. Use neutral examples such as `files.example.internal`; actual values belong in ignored local configuration.
7. Before publishing, scan staged content for private network addresses and sensitive configuration. Existing Git history is not rewritten unless the user explicitly requests it.

## Verification Labels

- `verified`: sandbox and automated checks passed; awaiting user environment verification.
- Open issue without `verified`: not ready for user verification.
- Closed issue: user has validated the result.
