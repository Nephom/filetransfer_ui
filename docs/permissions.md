# WebUI Permission Management

This document describes the WebUI permission model for server Locations. The desktop client does not provide permission administration; use the WebUI Admin Console or Super Panel.

The removed desktop `Upload Log` and `Session Path` features are not part of the current WebUI or nFterm workflow and are intentionally not referenced by the permission screens.

## Permission Sources

### Permission Role

A Permission Role is a named, reusable matrix of capabilities for each configured server Location. Assign a Role to a user when multiple users need the same access policy.

- Role changes take effect immediately for assigned users.
- A Role can grant different capabilities on different Locations.
- Disabled or read-only Location state is still enforced by the server.
- The Role list shows how many users currently use each Role.

### Fallback File Permissions

Fallback file permissions are the per-user capability list stored on the user account. They are used only when the user has no Permission Role.

The UI disables these controls while a Permission Role is selected to make the effective permission source clear. Existing fallback values are preserved and become active again when the Role is cleared.

### System Role

System Role is separate from file permissions:

- `admin`: the single system administrator from `config.ini`; full administration access.
- `superuser`: can manage regular users and Permission Roles, but not admin or superuser accounts.
- `user`: regular file access only.

Changing a System Role does not define Location file permissions.

## Capability Rules

The available capabilities are:

| Capability | Meaning |
|---|---|
| `list` | Browse a Location and list its entries. |
| `read` | Read or download files. |
| `upload` | Upload new files. |
| `write` | Modify file contents. |
| `delete` | Delete files or directories. |
| `rename` | Rename or move an entry within the supported operation. |
| `mkdir` | Create directories. |
| `copy` | Copy files or directories. |
| `move` | Move files or directories. |
| `share` | Create or manage share links. |

`copy` and `move` are composite operations. Granting either capability also grants `read`, `write`, and `delete` for that Location. A read-only Location blocks mutation capabilities regardless of the Role or user mapping.

## Admin Console Workflow

1. Open **Role Management** and create a named Role.
2. Select the capabilities for each Location in the permission matrix.
3. Open **User Management** and assign the Role when creating or editing a user.
4. Use **Fallback file permissions** only for users that do not have a Role.
5. Check the Permission Role column in the user list to confirm the current source.

Editing a Role updates every assigned user. Deleting a Role clears its `roleId` from assigned users; those users return to their fallback permissions.

## Bulk Edit

Bulk Edit intentionally has one primary permission operation: assign or clear a Permission Role. It can also change active status.

Use individual user editing for fallback permissions. This prevents a batch Location matrix from silently conflicting with a shared Permission Role.

Before applying a bulk change, use **Preview** to confirm the selected users and the Role transition. The server re-checks every target and reports succeeded, skipped, and failed users separately.

## API Summary

The permission administration endpoints are:

- `GET /api/admin/roles`
- `POST /api/admin/roles`
- `PUT /api/admin/roles/:id`
- `DELETE /api/admin/roles/:id`
- `POST /api/admin/users`
- `PUT /api/admin/users/:username`
- `POST /api/admin/users/bulk`

The complete request and response contract is documented in [API_REFERENCE.md](api/API_REFERENCE.md).
