# REST API mode frontend architecture

This document covers `fileapi_ui/src/rest-api.tsx` and its colocated stylesheet `fileapi_ui/src/rest-api.css`. The meaning, fallback chain, and ownership of every shared CSS custom property are documented in [`css_tokens.md`](./css_tokens.md). The data contracts are in `rest-contracts.ts`; formatting, export, and Redfish traversal helpers are in `rest-utils.ts`; HPE IML polling is implemented by `iml-monitor.ts` and `rest-task.ts`. The application shell and entry CRUD remain in `main.tsx`.

## Loading and component boundary

`main.tsx` lazy-loads `RestApiWorkspace`:

```ts
const RestApiWorkspace = lazy(() =>
  import("./rest-api").then(({ RestApiWorkspace: component }) => ({ default: component }))
);
```

The workspace receives `workspaceName`, REST entries, the active entry id, secret values, session headers, the global collapse-pane preference, and callbacks for entry/secret/session-header updates. It imports `rest-api.css` itself, so the stylesheet is loaded only when REST mode is used.

```text
.rest-workspace
├─ .rest-entry-pane-shell
│  └─ RestEntries                       -- entry list, Add, Edit/Remove
├─ collapse controls OR PaneResizeHandle
└─ .rest-reader
   ├─ heading + vendor/session status
   ├─ Authentication panel
   ├─ raw request controls (method, URL, JSON body, query)
   ├─ GET history + breadcrumbs
   ├─ notices
   ├─ discovered links + Redfish Toolbox
   └─ response panel (Pretty / Raw / Headers)

Portaled overlays: action dialog, devices, hardware, IML, power, BIOS,
firmware, reset workflow, OpenBMC inventory/resource, and resource catalog.
```

`RestEntries` is deliberately stateless. It renders the active row, a `MobileChoiceMenu` quick switcher, and `EntryActionsMenu`; mutations are delegated to `main.tsx` so the Sessions manager and sidebar use the same persistence path.

## Data model and entry defaults

`RestApiEntry` contains:

- identity: `id`, `name`, `baseUrl`, `defaultPath`, `query`;
- transport: `ignoreTlsErrors`;
- authentication: `authMode`, `username`, `loginPath`, `loginMethod`, `loginBody`, `tokenPath`, `tokenHeader`, `tokenSendAs`;
- vendor hint: `none`, `hpe`, or `openbmc`.

`RestApiSecret` may contain `username`, `password`, `token`, `apiKey`, and `cookie`. Secret updates go through `onChangeSecret`; they are not serialized into the REST entry itself. `RestAuthMode` supports `none`, `basic`, `bearer`, `api-key`, `cookie`, and `login`. `defaultRequestPath()` uses `/redfish/v1` for session login and `/rest/v1` otherwise.

The REST entry editor in `main.tsx` owns identity and TLS fields. Authentication settings are intentionally operational fields edited in the Authentication panel after selecting an entry. Changing auth mode updates the entry defaults and clears the current response/error/message.

## URL, headers, and request safety

`normalizePath()` ensures a leading slash. `resolveUrl()` joins a base URL and relative path, while accepting an explicit `http://` or `https://` URL. `resolveEntryResource()` applies an origin check: a discovered Redfish link may only resolve to the configured entry origin. Cross-host resource links are rejected.

`makeHeaders()` builds credentials as follows:

| Auth mode | Request headers |
|---|---|
| `none` | No credential header. |
| `basic` | `Authorization: Basic ...` when username and password exist. |
| `bearer` | `Authorization: Bearer ...`. |
| `api-key` | Configured `tokenHeader` (default `X-API-Key`). |
| `cookie` | `Cookie: ...`. |
| `login` | Cookie, configured token header, or session headers as applicable. |

`requestRest()` calls the Tauri `api_request` command with native byte payloads and the entry TLS preference. Every request has a 30-second timeout. `parseBody()` decodes bytes as UTF-8; `parseJson()` is intentionally nullable so non-JSON responses remain viewable.

`execute()` sends GET/POST/PATCH/DELETE requests from the raw request editor. POST, PATCH, and DELETE require a browser confirmation. JSON content type is added for bodies; DELETE has no body. `runRequest()` updates the response and URL/path, records GET history, and turns HTTP errors into a Redfish-aware error. It receives a `workflowId` so multi-step tools can correlate their debug records.

Do not use `fetch()` directly from this component or concatenate untrusted discovered links without `resolveEntryResource()`. The native command is also responsible for TLS handling and byte transport.

## Authentication lifecycle

The Authentication panel is collapsible (`authOpen`). For non-login modes, **Login** calls `verifyAuthentication()` against the default request path. For `login` mode:

1. `login()` sends `loginMethod` to `loginPath`, replacing `{{username}}` and `{{password}}` in `loginBody`.
2. It reads the configured response token header, `Location`, optional JSON token path, and `Set-Cookie` headers.
3. It stores the token/session headers or cookie per entry, records session creation, and prevents duplicate concurrent login with `loginPromiseRef`.
4. `logout()` DELETEs the server session `Location` when one was returned, stops IML monitoring, and clears token/cookie/session headers.
5. A 401/403 notice offers **Re-login**.

`getJsonPath()` resolves dotted paths such as `data.token`. The Token JSON Path help popup explains that HPE iLO/OpenBMC normally return `X-Auth-Token`, so the JSON path can remain empty in that case. Session tokens, cookies, and token-like response headers are masked in the response Headers view.

The HPE, OpenBMC, and Generic Redfish presets share the SessionService login shape. `launchVendor()` selects the toolbar vendor and opens its tool set; vendor selection is a UI hint and does not silently change the entry's base URL.

## Request reader

The reader provides:

- HTTP method dropdown: GET, POST, PATCH, DELETE;
- editable absolute/relative URL and method button;
- JSON body editor for POST/PATCH;
- repeatable query parameter rows, persisted into `entry.query` and the URL;
- recent GET history, maximum 20 URLs per entry, stored under `rest-api-history:<entryId>`;
- path breadcrumbs that issue GET requests;
- TLS warning and success/error notices;
- response resizing with a vertical drag handle.

`collectRedfishLinks()` recursively finds `@odata.id`, `href`, URI, URL, and download-like fields. Resource links issue a GET; download links use the native `download_to_disk_at` flow after selecting a LOCAL destination. `collectRedfishActions()` discovers action targets under `Actions` or `#...` members and includes ActionInfo links when advertised.

The response view has three modes:

- **Pretty**: JSON objects become clickable rows; object links open a resource, otherwise the row is navigable by property path.
- **Raw**: the decoded response text exactly as received by the native response wrapper.
- **Headers**: response headers with authorization/cookie/token values masked.

## Redfish vendor tools

The toolbar exposes tools based on `vendor`.

### Generic resource navigation

`openPath()` GETs an origin-validated resource. `openResource()` opens a resource dialog. `openAllResources()` gets `/redfish/v1`, recursively catalogs advertised resources, and displays the resource catalog. `openAction()` loads ActionInfo when available, constructs a default body (`ResetType: ForceRestart` for reset-like actions), and opens the action dialog. `executeAction()` validates an object JSON body and POSTs the advertised target after warning that it may change server state.

### HPE

`discoverHpeTargets()` probes the service root and relevant Redfish collections. `openDevices()` shows discovered device members. `hardwareTools` define inventory tools for Processor, Memory, Ethernet, Storage, PCIe, Thermal, and related resources. `loadHardware()` reads one collection, normalizes rows, records duration/timestamp/raw data, and supports JSON/CSV export. `loadAllHardware()` runs the tool set and groups results in the All hardware inventory dialog.

IML is a separate live workflow:

- `ensureImlSession()` creates/reuses the HPE session;
- `fetchIml()` reads and filters records;
- `startImlPolling`/`stopImlPolling` are delegated through `ImlMonitorController`;
- keyword, severity, newest/oldest, and 3/5/10-second interval controls affect the view;
- records are rendered in a fixed-height terminal-like stream;
- `createImlCsvSession()` and `appendImlCsvRows()` maintain an export CSV;
- after a manual stop, `downloadAhs()` can download the complete Active Health System log.

`discoverPower()` finds system/reset/PowerButton capabilities. `runPowerAction()` performs On, Off, ForceOff, or Reset and verifies state afterward. `pressPowerButton()` posts the advertised `PushType`. These controls are capability-driven and disabled when the service does not advertise a supported action.

`loadBios()` reads BIOS attributes and metadata. The BIOS editor searches attributes, displays current/pending values, supports allowable values/boolean/number/text controls, shows the exact `{ Attributes: ... }` PATCH preview, and `applyBios()` sends only changed attributes. `enterBiosSetup()` schedules the next boot through the advertised system resource and clearly reports when a reboot is required.

`loadFirmware()` reads FirmwareInventory and UpdateService capabilities. `startFirmware()` only builds a preview; `applyFirmware()` requires an explicit confirmation and posts the selected SimpleUpdate/AddFromUri payload. Long-running Redfish tasks are monitored by `monitorRedfishTask()` through the returned task location at three-second intervals, with progress state/percentage shown in the dialog. TPM override, target, repository, URI, and endpoint fields are only shown when advertised.

`resetLogs()` is a multi-step clear-log/reset workflow. It discovers the relevant log services, posts clear actions, updates each step, and leaves a visible result rather than treating a partial failure as success.

### OpenBMC

`discoverOpenBmc()` inspects `/redfish/v1` and records Systems/Managers/Chassis capabilities. `openBmcInventory()` walks System collections, flattens values into resource/property/value rows, retains a raw snapshot, and exports the normalized specification CSV. `openBmcResource()` opens a selected resource with both normalized rows and raw JSON. `runOpenBmcPower()` discovers the system reset target, posts the selected reset type, and verifies the resulting PowerState.

The OpenBMC resource/inventory dialogs use the same table and raw-response conventions as HPE hardware dialogs, but do not assume HPE-specific paths or capabilities.

## State and effects

The main state groups are:

| Group | State |
|---|---|
| Request | `path`, `urlDraft`, `method`, `bodyDraft`, `response`, `responseText`, `loading`, `error`, `message`, `view`. |
| Auth | session token refs, remote `Location`, creation timestamp, `authOpen`, help popup state. |
| Entry UI | pane width/collapsed state, vendor, history, toolbar/raw-request visibility. |
| Redfish | links/actions/catalog, action form/body/info, devices. |
| HPE tools | hardware rows/raw/error/timing, IML rows/filter/polling/retry/CSV, power capabilities, BIOS draft, firmware preview. |
| Dialogs | each tool has an explicit open/loading/error state; Escape closes the top-level dialog and stops IML when required. |

Effects reset path/request/response when the active entry or auth mode changes; restore toolbar vendor; load and persist per-entry GET history; reposition the portaled Token JSON Path popup; focus trap active dialogs; clean up IML and remote sessions on entry switch/unmount; and persist pane width under `fileapi-rest-entry-pane-width`.

## CSS architecture (`rest-api.css`)

`rest-api.css` is feature-local and imported by `rest-api.tsx`. It uses the global tokens from `styles/tokens.css`; it does not define a second theme system. The stylesheet is intentionally documented by ownership rather than by line number so a selector can be moved between CSS modules without changing the contract.

| Selector family | Responsibility |
|---|---|
| `.mode-switcher`, `.mode-switch-button`, `.rest-active` | Global mode switch styling and active REST status dot. |
| `.rest-mode .commandbar` | Hides Location command actions and reserves slots for REST toolbar/context picker. |
| `.rest-workspace`, `.rest-entry-pane-shell`, `.rest-entry-pane`, `.rest-entry-*` | Two-column workspace, resizable entry sidebar, active rows, empty state, Add, and mobile quick switcher. |
| `.rest-main-pane-collapse-controls` | 48px collapse/restore rail used instead of `PaneResizeHandle` when the global preference is enabled. |
| `.rest-reader`, `.rest-reader-heading`, `.rest-reader-tools`, `.rest-session-status` | Main reader surface, title, vendor capsule, and authentication status. |
| `.rest-toolbar*`, `.rest-vendor-*` | Portaled command-bar tools, vendor buttons, and HPE/OpenBMC tool launch controls. |
| `.rest-auth-panel`, `.rest-auth-fields`, `.rest-login-config`, `.rest-session-help`, `.token-path-help*` | Authentication fields, session configuration, help popups, and token-path positioning. |
| `.rest-url-row`, `.rest-body-editor`, `.rest-query-*`, `.rest-history*`, `.rest-breadcrumbs` | Raw request controls, query editor, GET history, and path navigation. |
| `.rest-warning`, `.rest-success`, `.rest-error`, `.rest-iml-notification` | TLS, success, error, and IML toast semantics. |
| `.rest-links*`, `.rest-actions*`, `.rest-toolbox-*`, `.rest-action-*` | Discovered links, Redfish action groups, action dialog, and destructive-action presentation. |
| `.rest-debug-*` | Debug workflow presentation. |
| `.rest-response*`, `.rest-view-tabs`, `.rest-code`, `.rest-json-*`, `.rest-headers` | Resizable response panel and Pretty/Raw/Headers views. |
| `.rest-hardware-*`, `.hardware-summary-*`, `.rest-resource-catalog*` | Resizable inventory/resource dialogs, tables, raw JSON sections, and exports. |
| `.rest-iml-*`, `.rest-power-*`, `.rest-bios-*`, `.rest-firmware-*`, `.rest-reset-*` | Tool-specific controls and fixed live IML terminal. |
| `.explorer.ui-layout-mobile .rest-*` | Large profile sizing and compact single-column behaviour; this is not a phone breakpoint. |

The stylesheet has responsive rules at 900px, 720px, 600px, and 540px. At 720px the reader is shown first and the entry list moves below it; at 540px the heading/tools stack. The explicit Large profile uses the same layout until a narrow viewport/short height also requires stacking. `ui-layout-mobile` means the project’s Large profile, not a separate phone design.

### CSS dependencies and layering

REST mode also consumes shared styles loaded by `styles/index.css`:

- `tokens.css`, `starship-bridge.css`, and `styles/theme/*.css`: tokens, palette, and final theme overrides;
- `desktop-ui.css`, `mobile-ui.css`, `mode-switcher.css`, `commandbar.css`: shell, profile, mode, and command bar;
- `location-control.css`, `context-picker.css`, `settings.css`, `account-menu.css`, `tls.css`: shared shell controls and modal semantics;
- `styles/layout/buttons.css`, `workspace-dialogs.css`, `collapse-controls.css`, and `panes.css`: shared controls and pane conventions;
- `ui/dropdown.css`, `ui/mobile-choice-menu.css`, `ui/entry-actions-menu.css`: shared popup and entry action controls.

Do not duplicate global token, dropdown, popup, or modal rules in `rest-api.css`. Feature-specific selectors belong here; cross-feature rules belong in the shared module or in the appropriate final theme override. `rest-api.css` is loaded before no additional REST theme overrides because the theme layer is already loaded last through `styles/index.css`.

## Failure and debugging contract

`parseRedfishError()` extracts `error.code`, `error.message`, and `@Message.ExtendedInfo` (`MessageId`, message, severity, resolution). `describeRestFailure()` classifies failures as HTTP, timeout, TLS, network, parse, or request and retains an error cause chain. The visible message remains user-readable while `debugRest()` records workflow, request id, correlation id, target path, status, duration, sanitized body, and response metadata.

A new REST workflow should call `runRequest()` rather than bypassing the request/error path; if it has multiple requests, reuse one `workflowId` and expose progress/partial failure in its dialog state.
