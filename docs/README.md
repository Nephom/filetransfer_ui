# Technical Documentation

This index links to the maintained API, WebUI, server, and nFterm technical
references. For installation, upgrade, startup, and build commands, see the
[project README](../README.md).

## API Server

- [API Reference](./api/API_REFERENCE.md) — authoritative authentication,
  Location, browsing, transfer, sharing, administration, and TLS contracts.
- [API Documentation](./api/README.md) — API document map and protocol entry
  points.
- [Upload API](./api/upload.md) — reservations, resumable sessions, chunk
  manifests, multipart compatibility, publication, and cancellation.
- [Progress API](./api/progress.md) — transfer states, byte semantics,
  cancellation settlement, and retention.
- [Error Codes](./api/error-codes.md) — upload response errors and recovery
  behavior.

## WebUI and Server Features

- [Browser Frontend](./browser_frontend.md) — active browser modules, interface
  styles, build integration, navigation, and upload lifecycle.
- [Server Locations](./locations.md) — Location configuration, path safety,
  cache scope, NFS operations, and migration.
- [Permission Management](./permissions.md) — Permission Roles, fallback
  permissions, capabilities, and administration workflows.
- [AI Log Analysis](./ai-analysis.md) — provider configuration, request limits,
  archive handling, and analysis lifecycle.

## nFterm Desktop

- [Desktop Architecture](./desktop.md) — runtime boundaries, credentials,
  filesystem access, transfer queue, SSH/SFTP, and Proxmox behavior.
- [Location Mode Architecture](./location_tech.md) — LOCAL/REMOTE browsing,
  Locations, file operations, transfers, terminal, overlays, and CSS ownership.
- [REST API Mode Architecture](./restapi_tech.md) — authentication, native
  requests, Redfish workflows, vendor tools, and REST styling.
- [Proxmox VNC Architecture](./proxmox_vnc_tech.md) — VNC sessions, Direct
  VNC, VM transfer routes, workspace state, and styling.
- [Transfer Queue](./queue.md) — queue states, progress, retries, resumable
  uploads, failure handling, and retention.
- [Queue Maintenance](./queue-maintenance.md) — executor integration and
  lifecycle guidance for queue changes.

## Shared Frontend and Release Metadata

- [CSS Tokens](./css_tokens.md) — shared custom properties, profiles, themes,
  stacking layers, and stylesheet ownership.
- [Versioning](./versioning.md) — repository version metadata and displayed
  application version.
