import React, { useEffect, useMemo, useRef, useState } from "react";
import "./rest-api.css";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { PaneResizeHandle } from "./resizable-pane";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, CloseIcon } from "./ui/icons";
import { Dropdown } from "./ui/Dropdown";
import { MobileChoiceMenu } from "./ui/MobileChoiceMenu";
import { ImlMonitorController } from "./iml-monitor";
import { monitorRedfishTask } from "./rest-task";
import type { ImlMonitorState, JsonValue, NativeApiResponse, RestApiEntry, RestApiSecret, RestAuthMode, RestFailureType, RestMethod, RestSession, RestVendor } from "./rest-contracts";
export type { RestApiEntry, RestApiSecret, RestAuthMode, RestMethod, RestVendor } from "./rest-contracts";
import { buildOpenBmcSpecRows, csvCell, debugRest, downloadText, hardwareTools, jsonCell, openBmcInventoryTableRows, openBmcSpecCsv, sanitizeHeaders, sanitizeJson, sanitizeText, tableCell, type HardwareTool, type OpenBmcInventorySnapshot, type OpenBmcSpecRow } from "./rest-utils";
type RestHistoryItem = { url: string; timestamp: number };
type RestAuditItem = { id: string; timestamp: number; method: RestMethod; url: string; status: number | null; durationMs: number; body: string; error?: string };
type BiosAttributeMetadata = { type?: string; allowableValues?: string[]; description?: string; readOnly?: boolean; format?: string };
type RestDialogDragSession = {
  onMove: (event: PointerEvent) => void;
  onUp: () => void;
};

type Props = {
  workspaceName: string;
  entries: RestApiEntry[];
  activeEntryId: string;
  secrets: Record<string, RestApiSecret>;
  sessionHeaders: Record<string, string>;
  collapseMainPaneEnabled: boolean;
  onSelectEntry: (id: string) => void;
  onChangeEntries: (entries: RestApiEntry[]) => void;
  onChangeSecret: (entryId: string, secret: RestApiSecret) => void;
  onChangeSessionHeaders: (entryId: string, headers: Record<string, string>) => void;
};

const authLabels: Record<RestAuthMode, string> = {
  none: "None",
  basic: "Basic Auth",
  bearer: "Bearer token",
  "api-key": "API key",
  cookie: "Cookie header",
  login: "Session Auth",
};

const vendorPresets: Record<RestVendor, { label: string; referenceJson: string; loginPath: string; loginBody: string }> = {
  none: {
    label: "Generic Redfish",
    referenceJson: '{\n  "UserName": "{{username}}",\n  "Password": "{{password}}"\n}',
    loginPath: "/redfish/v1/SessionService/Sessions",
    loginBody: '{"UserName":"{{username}}","Password":"{{password}}"}',
  },
  hpe: {
    label: "HPE",
    referenceJson: '{\n  "UserName": "{{username}}",\n  "Password": "{{password}}"\n}',
    loginPath: "/redfish/v1/SessionService/Sessions",
    loginBody: '{"UserName":"{{username}}","Password":"{{password}}"}',
  },
  openbmc: {
    label: "OpenBMC",
    referenceJson: '{\n  "UserName": "{{username}}",\n  "Password": "{{password}}"\n}',
    loginPath: "/redfish/v1/SessionService/Sessions",
    loginBody: '{"UserName":"{{username}}","Password":"{{password}}"}',
  },
};

const sessionAuthPreset = vendorPresets.hpe;

const normalizePath = (value: string) => {
  const path = value.trim() || "/";
  return path.startsWith("/") ? path : `/${path}`;
};

const defaultRequestPath = (authMode: RestAuthMode) => authMode === "login" ? "/redfish/v1" : "/rest/v1";

const resolveUrl = (baseUrl: string, path: string) => {
  const value = path.trim();
  if (/^https?:\/\//i.test(value)) return value;
  const base = baseUrl.trim().replace(/\/+$/, "");
  return `${base}${normalizePath(value)}`;
};
const joinUrl = resolveUrl;

const resolveEntryResource = (entry: RestApiEntry, target: string) => {
  const base = new URL(entry.baseUrl);
  const url = new URL(resolveUrl(entry.baseUrl, target));
  if (url.origin !== base.origin) throw new Error("Resource links to another host are blocked for safety.");
  return url.toString();
};

const getJsonPath = (value: unknown, path: string): unknown => {
  if (!path.trim()) return value;
  return path.split(".").filter(Boolean).reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
};

const parseBody = (body: number[]) => new TextDecoder().decode(new Uint8Array(body));
const parseJson = (text: string): JsonValue | null => {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
};

const prettyJson = (value: unknown) => JSON.stringify(value, null, 2);

const makeHeaders = (entry: RestApiEntry, secret: RestApiSecret, session: Record<string, string>) => {
  const headers: [string, string][] = [];
  if (entry.authMode === "basic" && entry.username && secret.password) {
    headers.push(["Authorization", `Basic ${btoa(`${entry.username}:${secret.password}`)}`]);
  }
  if (entry.authMode === "bearer" && secret.token) headers.push(["Authorization", `Bearer ${secret.token}`]);
  if (entry.authMode === "api-key" && secret.apiKey) headers.push([entry.tokenHeader || "X-API-Key", secret.apiKey]);
  if (entry.authMode === "cookie" && secret.cookie) headers.push(["Cookie", secret.cookie]);
  if (entry.authMode === "login" && secret.cookie) headers.push(["Cookie", secret.cookie]);
  if (entry.authMode === "login" && secret.token) headers.push([entry.tokenSendAs || "X-Auth-Token", secret.token]);
  if (entry.authMode === "login" && !secret.token) Object.entries(session).forEach(([name, value]) => headers.push([name, value]));
  return headers;
};

export type RedfishErrorDetails = {
  status: number;
  code: string;
  message: string;
  extendedInfo: { messageId: string; message: string; severity: string; resolution: string }[];
};

export const parseRedfishError = (status: number, text: string): RedfishErrorDetails => {
  const parsed = parseJson(text);
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, JsonValue> : {};
  const error = root.error && typeof root.error === "object" && !Array.isArray(root.error)
    ? root.error as Record<string, JsonValue>
    : root;
  const readString = (value: JsonValue | undefined) => typeof value === "string" ? value : "";
  const rawInfo = error["@Message.ExtendedInfo"];
  const extendedInfo = Array.isArray(rawInfo)
    ? rawInfo.filter((item): item is Record<string, JsonValue> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({
      messageId: readString(item.MessageId),
      message: readString(item.Message),
      severity: readString(item.Severity),
      resolution: readString(item.Resolution),
    }))
    : [];
  return {
    status,
    code: readString(error.code) || `HTTP_${status}`,
    message: readString(error.message) || text.trim() || `HTTP ${status}`,
    extendedInfo,
  };
};

const formatRedfishError = (details: RedfishErrorDetails) => {
  const info = details.extendedInfo.map((item) => [item.messageId, item.message, item.severity, item.resolution].filter(Boolean).join(" · ")).filter(Boolean);
  return `[${details.code}] ${details.message}${info.length ? ` | ExtendedInfo: ${info.join("; ")}` : ""}`;
};

type RestFailureDetails = {
  failureType: RestFailureType;
  error: string;
  cause: string;
  causeChain: string[];
  status?: number;
  statusText?: string;
  redfishCode?: string;
  redfishMessage?: string;
  extendedInfo?: RedfishErrorDetails["extendedInfo"];
};

const errorCauseChain = (error: unknown) => {
  const chain: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    const message = current.message.trim();
    if (message && !chain.includes(message)) chain.push(message);
    current = current.cause;
  }
  return chain;
};

const describeRestFailure = (error: unknown, response?: NativeApiResponse, responseText = ""): RestFailureDetails => {
  const message = error instanceof Error ? error.message : String(error);
  const causeChain = errorCauseChain(error);
  const cause = causeChain[1] || causeChain[0] || message;
  if (response && response.status >= 400) {
    const redfish = parseRedfishError(response.status, responseText);
    return { failureType: "http", error: message, cause, causeChain, status: response.status, statusText: response.statusText || "", redfishCode: redfish.code, redfishMessage: redfish.message, extendedInfo: redfish.extendedInfo };
  }
  const lower = message.toLowerCase();
  const failureType: RestFailureType = /timed out|timeout/.test(lower)
    ? "timeout"
    : /tls|ssl|certificate|handshake/.test(lower)
      ? "tls"
      : /json|parse|unexpected token|syntaxerror/.test(lower)
        ? "parse"
        : /network|fetch|connect|dns|socket|host/.test(lower)
          ? "network"
          : "request";
  return { failureType, error: message, cause, causeChain };
};

const REST_REQUEST_TIMEOUT_MS = 30_000;

const requestRest = async (
  entry: RestApiEntry,
  secret: RestApiSecret,
  session: Record<string, string>,
  method: RestMethod,
  requestUrl: string,
  body?: string,
  requestHeaders = makeHeaders(entry, secret, session),
) => {
  if (!/^https?:\/\//i.test(requestUrl)) throw new Error("REST URL must start with http:// or https://.");
  let timeoutId: number | undefined;
  try {
    const responseValue = await Promise.race([
      invoke<NativeApiResponse>("api_request", {
        url: requestUrl,
        method,
        headers: requestHeaders,
        body: body === undefined || body === "" ? null : Array.from(new TextEncoder().encode(body)),
        ignoreTlsErrors: entry.ignoreTlsErrors,
      }),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(`REST request timed out after ${REST_REQUEST_TIMEOUT_MS / 1000} seconds.`)), REST_REQUEST_TIMEOUT_MS);
      }),
    ]);
    return { responseValue, text: parseBody(responseValue.body) };
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
};

const extractCookies = (headers: [string, string][] = []) => headers
  .filter(([name]) => name.toLowerCase() === "set-cookie")
  .map(([, value]) => value.split(";", 1)[0])
  .filter(Boolean)
  .join("; ");

const responseEntryName = (value: unknown, fallback: string) => {
  return fallback;
};

type RedfishAction = { name: string; target: string; title: string; actionInfo?: string };
type RedfishLink = { name: string; target: string; kind: "resource" | "download" };

const collectRedfishActions = (value: unknown, parent = ""): RedfishAction[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectRedfishActions(item, `${parent}[${index}]`));
  const actions: RedfishAction[] = [];
  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const target = (child as Record<string, unknown>).target;
      if (typeof target === "string" && (parent === "Actions" || key.startsWith("#"))) {
        const actionValue = child as Record<string, unknown>;
        const actionInfo = typeof actionValue["@Redfish.ActionInfo"] === "string" ? String(actionValue["@Redfish.ActionInfo"]) : typeof actionValue.ActionInfo === "string" ? String(actionValue.ActionInfo) : undefined;
        actions.push({ name: key, target, title: typeof actionValue.title === "string" ? String(actionValue.title) : key.replace(/^#/, ""), actionInfo });
      }
    }
    actions.push(...collectRedfishActions(child, key));
  });
  return actions;
};

const collectRedfishLinks = (value: unknown, parent = ""): RedfishLink[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectRedfishLinks(item, `${parent}[${index}]`));
  const links: RedfishLink[] = [];
  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    if (typeof child === "string" && /^(https?:\/\/|\/)/.test(child) && (/^@odata\.id$/i.test(key) || /(?:href|downloaduri|downloadurl|uri|url)$/i.test(key))) {
      links.push({ name: parent ? `${parent}.${key}` : key, target: child, kind: /download/i.test(key) ? "download" : "resource" });
    }
    links.push(...collectRedfishLinks(child, parent ? `${parent}.${key}` : key));
  });
  return links;
};

const defaultActionBody = (action: RedfishAction) => /reset/i.test(`${action.name} ${action.title}`)
  ? '{\n  "ResetType": "ForceRestart"\n}'
  : "{\n  \n}";

// Entry management (add/edit/remove) lives in the Sessions/Workspace
// Manager, not here -- this sidebar only lists and selects among entries
// the Workspace already owns, exactly like the SSH terminal panel's own
// sidebar has no add/edit UI of its own either.
function RestEntries({ entries, activeEntryId, onSelectEntry }: Pick<Props, "entries" | "activeEntryId" | "onSelectEntry">) {
  return <aside className="rest-entry-pane">
    <div className="rest-entry-heading">
      <span className="sidebar-label">REST API ENTRIES</span>
    </div>
    <MobileChoiceMenu className="rest-entry-choice" label="REST API entry" currentId={activeEntryId} options={entries.map((entry) => ({ id: entry.id, label: entry.name }))} onSelect={onSelectEntry} />
    <div className="rest-entry-list">
      {!entries.length && <div className="rest-empty">No REST API entries yet. Add one from Sessions → Workspace.</div>}
      {entries.map((entry) => <button type="button" key={entry.id} className={`rest-entry${entry.id === activeEntryId ? " active" : ""}`} onClick={() => onSelectEntry(entry.id)}>
        <span className="rest-entry-dot" />
        <span className="rest-entry-copy"><strong>{entry.name}</strong><small>{entry.baseUrl}</small><small>{normalizePath(entry.defaultPath)}</small></span>
      </button>)}
    </div>
  </aside>;
}

export function RestApiWorkspace(props: Props) {
  const entry = props.entries.find((item) => item.id === props.activeEntryId) || props.entries[0];
  const [toolbarVendor, setToolbarVendor] = useState<RestVendor>(entry?.vendor || "none");
  const vendor: RestVendor = toolbarVendor;
  const secret = entry ? props.secrets[entry.id] || {} : {};
  const sessionTokenRef = useRef<Record<string, string>>({});
  const loginPromiseRef = useRef<Promise<void> | null>(null);
  const sessionLocationRef = useRef<Record<string, string | undefined>>({});
  const sessionCreatedAtRef = useRef<Record<string, number>>({});
  const sessionToken = entry ? props.sessionHeaders[entry.id] || secret.token || sessionTokenRef.current[entry.id] || "" : "";
  const activeSession: RestSession | null = sessionToken
    ? { token: sessionToken, location: entry ? sessionLocationRef.current[entry.id] : undefined, createdAt: entry ? sessionCreatedAtRef.current[entry.id] || 0 : 0 }
    : null;
  const isSessionAuthenticated = entry?.authMode === "login" && Boolean(sessionToken || secret.cookie);
  const session: Record<string, string> = entry && sessionToken
    ? { "X-Auth-Token": sessionToken }
    : {};
  const [path, setPath] = useState(entry?.defaultPath || "/");
  const [urlDraft, setUrlDraft] = useState("");
  const [method, setMethod] = useState<RestMethod>("GET");
  const [bodyDraft, setBodyDraft] = useState("{\n  \n}");
  const [authOpen, setAuthOpen] = useState(true);
  const [view, setView] = useState<"pretty" | "raw" | "headers">("pretty");
  const [response, setResponse] = useState<NativeApiResponse | null>(null);
  const [responseText, setResponseText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<Record<string, RestHistoryItem[]>>({});
  const [toolsOpen, setToolsOpen] = useState(false);
  const [openBmcCapabilities, setOpenBmcCapabilities] = useState<Record<string, string>>({});
  const [openBmcPowerState, setOpenBmcPowerState] = useState("Unknown");
  const [openBmcMessage, setOpenBmcMessage] = useState("");
  const [openBmcInventoryOpen, setOpenBmcInventoryOpen] = useState(false);
  const [openBmcInventoryLoading, setOpenBmcInventoryLoading] = useState(false);
  const [openBmcInventoryError, setOpenBmcInventoryError] = useState("");
  const [openBmcInventorySnapshot, setOpenBmcInventorySnapshot] = useState<OpenBmcInventorySnapshot>({});
  const [openBmcInventoryRows, setOpenBmcInventoryRows] = useState<Record<string, JsonValue>[]>([]);
  const [openBmcSpecRows, setOpenBmcSpecRows] = useState<OpenBmcSpecRow[]>([]);
  const [openBmcResourceOpen, setOpenBmcResourceOpen] = useState(false);
  const [openBmcResourceTarget, setOpenBmcResourceTarget] = useState("");
  const [openBmcResourceRows, setOpenBmcResourceRows] = useState<Record<string, JsonValue>[]>([]);
  const [openBmcResourceRaw, setOpenBmcResourceRaw] = useState<JsonValue | null>(null);
  const [openBmcResourceLoading, setOpenBmcResourceLoading] = useState(false);
  const [resourceCatalogOpen, setResourceCatalogOpen] = useState(false);
  const [resourceCatalog, setResourceCatalog] = useState<RedfishLink[]>([]);
  const [rawRequestOpen, setRawRequestOpen] = useState(true);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [selectedAction, setSelectedAction] = useState<RedfishAction | null>(null);
  const [actionBody, setActionBody] = useState("{\n  \n}");
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [devicesData, setDevicesData] = useState<JsonValue | null>(null);
  const [hardwareOpen, setHardwareOpen] = useState(false);
  const [hardwareTool, setHardwareTool] = useState<HardwareTool | null>(null);
  const [hardwareRows, setHardwareRows] = useState<Record<string, JsonValue>[]>([]);
  const [hardwareRaw, setHardwareRaw] = useState<JsonValue | null>(null);
  const [hardwareLoading, setHardwareLoading] = useState(false);
  const [hardwareError, setHardwareError] = useState("");
  const [hardwareUpdatedAt, setHardwareUpdatedAt] = useState<number | null>(null);
  const [hardwareDurationMs, setHardwareDurationMs] = useState<number | null>(null);
  const [hardwareSummaryOpen, setHardwareSummaryOpen] = useState(false);
  const [hardwareSummaryGroups, setHardwareSummaryGroups] = useState<{ tool: HardwareTool; rows: Record<string, JsonValue>[] }[]>([]);
  const [imlOpen, setImlOpen] = useState(false);
  const [imlRows, setImlRows] = useState<Record<string, JsonValue>[]>([]);
  const [imlKeyword, setImlKeyword] = useState("");
  const [imlSeverity, setImlSeverity] = useState("all");
  const [imlNewestFirst, setImlNewestFirst] = useState(true);
  const [imlPolling, setImlPolling] = useState(false);
  const [imlState, setImlState] = useState<ImlMonitorState>("stopped");
  const [imlError, setImlError] = useState("");
  const [imlNotice, setImlNotice] = useState("");
  const [imlRetryCount, setImlRetryCount] = useState(0);
  const [imlLastFetchAt, setImlLastFetchAt] = useState<number | null>(null);
  const [imlCsvError, setImlCsvError] = useState("");
  const [imlNextRetryAt, setImlNextRetryAt] = useState<number | null>(null);
  const [imlInterval, setImlInterval] = useState(5000);
  const [imlManualStopped, setImlManualStopped] = useState(false);
  const [ahsTarget, setAhsTarget] = useState("");
  const [ahsMessage, setAhsMessage] = useState("");
  const ahsTimerRef = useRef<number | null>(null);
  const imlControllerRef = useRef<ImlMonitorController<Record<string, JsonValue>> | null>(null);
  const imlStateRef = useRef<ImlMonitorState>("stopped");
  const imlTargetsRef = useRef<HpeTargets | null>(null);
  const imlCsvPathRef = useRef<string | null>(null);
  const imlCsvKeysRef = useRef<Set<string>>(new Set());
  const imlSnapshotRef = useRef<{ keys: Set<string>; count: number; newestTimestamp: number } | null>(null);
  const [powerOpen, setPowerOpen] = useState(false);
  const [powerState, setPowerState] = useState("Unknown");
  const [powerActions, setPowerActions] = useState<string[]>([]);
  const [powerResetTarget, setPowerResetTarget] = useState("");
  const [powerSystemTarget, setPowerSystemTarget] = useState("");
  const [powerResetTypes, setPowerResetTypes] = useState<string[]>([]);
  const [powerButtonTarget, setPowerButtonTarget] = useState("");
  const [powerButtonTypes, setPowerButtonTypes] = useState<string[]>([]);
  const [biosOpen, setBiosOpen] = useState(false);
  const [biosRaw, setBiosRaw] = useState<Record<string, JsonValue> | null>(null);
  const [biosDraft, setBiosDraft] = useState<Record<string, JsonValue>>({});
  const [biosSearch, setBiosSearch] = useState("");
  const [biosCompare, setBiosCompare] = useState<Record<string, JsonValue> | null>(null);
  const [selectedBiosAttribute, setSelectedBiosAttribute] = useState("");
  const [biosMessage, setBiosMessage] = useState("");
  const [firmwareOpen, setFirmwareOpen] = useState(false);
  const [firmwareInventory, setFirmwareInventory] = useState<Record<string, JsonValue>[]>([]);
  const [firmwareAction, setFirmwareAction] = useState("");
  const [firmwareUri, setFirmwareUri] = useState("");
  const [firmwareMessage, setFirmwareMessage] = useState("");
  const [firmwareFilter, setFirmwareFilter] = useState("");
  const [firmwarePreview, setFirmwarePreview] = useState<Record<string, JsonValue> | null>(null);
  const [firmwareRaw, setFirmwareRaw] = useState<JsonValue | null>(null);
  const [firmwareTarget, setFirmwareTarget] = useState("");
  const [firmwareTpmOverride, setFirmwareTpmOverride] = useState(false);
  const [firmwareUpdateRepository, setFirmwareUpdateRepository] = useState("");
  const [firmwareSupportsTpm, setFirmwareSupportsTpm] = useState(false);
  const [firmwareSupportsTarget, setFirmwareSupportsTarget] = useState(false);
  const [firmwareSupportsRepository, setFirmwareSupportsRepository] = useState(false);
  const [auditItems, setAuditItems] = useState<RestAuditItem[]>([]);
  const [actionInfo, setActionInfo] = useState<JsonValue | null>(null);
  const [actionForm, setActionForm] = useState<Record<string, JsonValue>>({});
  const [resetOpen, setResetOpen] = useState(false);
  const [resetSteps, setResetSteps] = useState<{ name: string; status: string }[]>([]);
  const [resetMessage, setResetMessage] = useState("");
  const [powerBusy, setPowerBusy] = useState(false);
  const [powerMessage, setPowerMessage] = useState("");
  const [powerLastRequest, setPowerLastRequest] = useState<{ target: string; payload: string; status: number } | null>(null);
  const responseResizeRef = useRef<{ pointerY: number; height: number } | null>(null);
  const [sessionHelpOpen, setSessionHelpOpen] = useState(false);
  const [tokenPathHelpOpen, setTokenPathHelpOpen] = useState(false);
  const [tokenPathHelpPosition, setTokenPathHelpPosition] = useState({ top: -999, left: -999 });
  const [tokenPathHelpPopupStyle, setTokenPathHelpPopupStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  const tokenPathHelpButtonRef = useRef<HTMLButtonElement>(null);
  const [entryPaneWidth, setEntryPaneWidth] = useState(() => Number(localStorage.getItem("fileapi-rest-entry-pane-width")) || 380);
  const [entryPaneCollapsed, setEntryPaneCollapsed] = useState(false);
  const entryPaneResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  const restDialogDragRef = useRef<RestDialogDragSession | null>(null);

  const stopEntryPaneResize = () => {
    entryPaneResizeRef.current = null;
    window.removeEventListener("pointermove", resizeEntryPane);
    window.removeEventListener("pointerup", stopEntryPaneResize);
  };
  const resizeEntryPane = (event: PointerEvent) => {
    const start = entryPaneResizeRef.current;
    if (!start) return;
    const maxWidth = Math.max(220, Math.min(720, window.innerWidth - 300));
    setEntryPaneWidth(Math.max(220, Math.min(maxWidth, start.startWidth + event.clientX - start.startX)));
  };
  const beginEntryPaneResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    entryPaneResizeRef.current = { startX: event.clientX, startWidth: entryPaneWidth };
    window.addEventListener("pointermove", resizeEntryPane);
    window.addEventListener("pointerup", stopEntryPaneResize);
  };
  useEffect(() => {
    localStorage.setItem("fileapi-rest-entry-pane-width", String(entryPaneWidth));
  }, [entryPaneWidth]);
  useEffect(() => {
    setToolbarHost(document.querySelector<HTMLElement>(".commandbar"));
    return () => setToolbarHost(null);
  }, []);
  useEffect(() => {
    const stopDragging = () => {
      const active = restDialogDragRef.current;
      if (!active) return;
      window.removeEventListener("pointermove", active.onMove);
      window.removeEventListener("pointerup", active.onUp);
      window.removeEventListener("pointercancel", active.onUp);
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("cursor");
      restDialogDragRef.current = null;
    };

    const startDragging = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      const header = target?.closest<HTMLElement>(".rest-editor-heading, .rest-action-dialog-heading");
      if (!header || target?.closest("button, input, select, textarea, a, [role=button]")) return;
      const dialog = header.closest<HTMLElement>("[role=dialog]");
      if (!dialog) return;

      event.preventDefault();
      event.stopPropagation();
      stopDragging();

      const rect = dialog.getBoundingClientRect();
      const handleHeight = Math.max(header.getBoundingClientRect().height, 32);
      const minVisibleWidth = Math.min(160, rect.width);
      const minLeft = -rect.width + minVisibleWidth;
      const maxLeft = window.innerWidth - minVisibleWidth;
      const minTop = 8;
      const maxTop = Math.max(minTop, window.innerHeight - handleHeight - 8);
      const startX = Number.parseFloat(dialog.style.getPropertyValue("--rest-dialog-x")) || 0;
      const startY = Number.parseFloat(dialog.style.getPropertyValue("--rest-dialog-y")) || 0;

      const onMove = (moveEvent: PointerEvent) => {
        const nextLeft = Math.max(minLeft, Math.min(maxLeft, rect.left + moveEvent.clientX - event.clientX));
        const nextTop = Math.max(minTop, Math.min(maxTop, rect.top + moveEvent.clientY - event.clientY));
        dialog.style.setProperty("--rest-dialog-x", `${startX + nextLeft - rect.left}px`);
        dialog.style.setProperty("--rest-dialog-y", `${startY + nextTop - rect.top}px`);
      };
      const onUp = () => stopDragging();

      restDialogDragRef.current = { onMove, onUp };
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointerdown", startDragging, true);
    return () => {
      window.removeEventListener("pointerdown", startDragging, true);
      stopDragging();
    };
  }, []);
  useEffect(() => () => stopEntryPaneResize(), []);
  const previousEntryIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previousEntryId = previousEntryIdRef.current;
    if (previousEntryId && previousEntryId !== entry?.id) {
      imlControllerRef.current?.stop("entry-switch");
      setImlPolling(false);
      void cleanupRemoteSessionForEntry(previousEntryId);
    }
    previousEntryIdRef.current = entry?.id;
  }, [entry?.id]);
  useEffect(() => () => {
    imlControllerRef.current?.stop("unmount");
    clearAhsTimer();
    void cleanupRemoteSessionForEntry(entry?.id);
  }, []);

  useEffect(() => {
    const nextPath = entry ? defaultRequestPath(entry.authMode) : "/";
    setPath(nextPath);
    setUrlDraft(entry ? joinUrl(entry.baseUrl, nextPath) : "");
    setResponse(null);
    setResponseText("");
    setError("");
    setMessage("");
  }, [entry?.id, entry?.authMode]);

  useEffect(() => {
    setToolbarVendor(entry?.vendor || "none");
  }, [entry?.id, entry?.vendor]);

  useEffect(() => {
    const loaded: Record<string, RestHistoryItem[]> = {};
    props.entries.forEach((item) => {
      try {
        const saved = JSON.parse(localStorage.getItem(`rest-api-history:${item.id}`) || "[]");
        loaded[item.id] = Array.isArray(saved)
          ? saved.filter((value): value is RestHistoryItem => Boolean(value?.url && Number.isFinite(value?.timestamp))).slice(0, 20)
          : [];
      } catch {
        loaded[item.id] = [];
      }
    });
    setHistory(loaded);
  }, [props.entries.map((item) => item.id).join(",")]);

  useEffect(() => {
    Object.entries(history).forEach(([entryId, items]) => {
      localStorage.setItem(`rest-api-history:${entryId}`, JSON.stringify(items.slice(0, 20)));
    });
  }, [history]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const start = responseResizeRef.current;
      if (!start) return;
      const reader = document.querySelector<HTMLElement>(".rest-reader");
      const panel = document.querySelector<HTMLElement>(".rest-response");
      const minimumHeight = 180;
      const maximumHeight = Math.max(minimumHeight, (reader?.clientHeight || start.height) - 180);
      const nextHeight = start.height - (event.clientY - start.pointerY);
      const height = Math.min(maximumHeight, Math.max(minimumHeight, nextHeight));
      if (panel) panel.style.height = `${height}px`;
    };
    const stopResize = () => {
      responseResizeRef.current = null;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopResize);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopResize);
    };
  }, []);

  const beginResponseResize = (event: React.MouseEvent<HTMLDivElement>) => {
    const panel = document.querySelector<HTMLElement>(".rest-response");
    if (!panel) return;
    responseResizeRef.current = { pointerY: event.clientY, height: panel.getBoundingClientRect().height };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    event.preventDefault();
  };

  useEffect(() => {
    if (!sessionHelpOpen) return undefined;
    const closeHelp = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".rest-session-help") && !target.closest(".rest-help-button")) setSessionHelpOpen(false);
    };
    document.addEventListener("click", closeHelp);
    return () => document.removeEventListener("click", closeHelp);
  }, [sessionHelpOpen]);

  useEffect(() => {
    if (!tokenPathHelpOpen) return undefined;
    const closeHelp = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".token-path-help") && !target.closest(".token-path-help-popup")) setTokenPathHelpOpen(false);
    };
    document.addEventListener("click", closeHelp);
    return () => document.removeEventListener("click", closeHelp);
  }, [tokenPathHelpOpen]);

  useEffect(() => {
    // Portaled to document.body (mirrors ContextPicker/Dropdown/
    // CommandBarOverflowMenu) because .rest-reader has overflow:auto,
    // which was clipping/hiding this popup instead of letting it float
    // above the rest of the REST workspace.
    if (!tokenPathHelpOpen) return undefined;
    const reposition = () => {
      const rect = tokenPathHelpButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(440, window.innerWidth - 24);
      const gap = 8;
      const belowTop = rect.bottom + gap;
      const aboveTop = rect.top - gap;
      const placeAbove = aboveTop >= 160 || belowTop + 160 > window.innerHeight - 12;
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      setTokenPathHelpPopupStyle({
        position: "fixed",
        top: placeAbove ? undefined : belowTop,
        bottom: placeAbove ? window.innerHeight - aboveTop : undefined,
        left,
        width,
        visibility: "visible",
      });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [tokenPathHelpOpen]);

  useEffect(() => {
    const hasDialog = devicesOpen || hardwareOpen || hardwareSummaryOpen || openBmcInventoryOpen || openBmcResourceOpen || resourceCatalogOpen || imlOpen || powerOpen || biosOpen || firmwareOpen || resetOpen || actionOpen;
    if (!hasDialog) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const focusDialog = () => {
      const dialog = document.querySelector<HTMLElement>(".floating-dialog-layer [role='dialog'], .rest-action-dialog");
      dialog?.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (imlOpen) stopImlPolling("close");
        setDevicesOpen(false); setHardwareOpen(false); setHardwareSummaryOpen(false); setOpenBmcInventoryOpen(false); setOpenBmcResourceOpen(false); setResourceCatalogOpen(false); setImlOpen(false); setPowerOpen(false); setBiosOpen(false); setFirmwareOpen(false); setResetOpen(false); setActionOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".floating-dialog-layer [role='dialog'], .rest-action-dialog");
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")).filter((item) => !item.hasAttribute("disabled"));
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current + 1) % focusable.length;
      event.preventDefault(); focusable[next].focus();
    };
    document.addEventListener("keydown", onKeyDown);
    window.setTimeout(focusDialog, 0);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [devicesOpen, hardwareOpen, hardwareSummaryOpen, openBmcInventoryOpen, openBmcResourceOpen, resourceCatalogOpen, imlOpen, powerOpen, biosOpen, firmwareOpen, resetOpen, actionOpen]);

  useEffect(() => {
    const updateTokenHelpPosition = () => {
      const panel = document.querySelector<HTMLElement>(".rest-auth-panel");
      const labels = document.querySelectorAll<HTMLElement>(".rest-login-config > label");
      const tokenLabel = labels[1];
      const textNode = tokenLabel?.firstChild;
      if (!panel || !tokenLabel || !textNode) return;
      // Measure the actual rendered width of the "Token JSON path" text
      // (via Range, not a fixed px offset) so the (?) button sits right
      // after the label at any font size -- Auto's clamp() scale and the
      // Large profile's larger fixed text size both change how wide this
      // text renders, and a literal px offset only matched one size.
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const textRect = range.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      setTokenPathHelpPosition({
        top: textRect.top - panelRect.top - 2,
        left: textRect.right - panelRect.left + 6,
      });
    };
    updateTokenHelpPosition();
    window.addEventListener("resize", updateTokenHelpPosition);
    return () => window.removeEventListener("resize", updateTokenHelpPosition);
  }, [entry?.id, entry?.authMode, authOpen, tokenPathHelpOpen]);

  const crumbs = useMemo(() => {
    const parts = normalizePath(path).split("/").filter(Boolean);
    return [{ label: "/", value: "/" }, ...parts.map((part, index) => ({ label: part, value: `/${parts.slice(0, index + 1).join("/")}` }))];
  }, [path]);

  const updateSecret = (patch: RestApiSecret) => entry && props.onChangeSecret(entry.id, { ...secret, ...patch });
  const resetRequestPath = (authMode: RestAuthMode) => {
    if (!entry) return;
    const nextPath = defaultRequestPath(authMode);
    setPath(nextPath);
    setUrlDraft(joinUrl(entry.baseUrl, nextPath));
  };
  const changeAuthMode = (authMode: RestAuthMode) => {
    if (!entry) return;
    const sessionFields = authMode === "login"
      ? { loginPath: sessionAuthPreset.loginPath, tokenPath: "", tokenHeader: "X-Auth-Token", tokenSendAs: "X-Auth-Token", loginBody: sessionAuthPreset.loginBody }
      : {};
    props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, authMode, defaultPath: defaultRequestPath(authMode), ...sessionFields } : item));
    resetRequestPath(authMode);
    setResponse(null);
    setResponseText("");
    setError("");
    setMessage("");
  };
  const launchVendor = (nextVendor: RestVendor) => {
    if (nextVendor === "none") return;
    setToolbarVendor(nextVendor);
    setToolsOpen(true);
  };
  const setSessionHeader = (value: string) => {
    if (!entry) return;
    sessionTokenRef.current[entry.id] = value;
    props.onChangeSecret(entry.id, { ...secret, token: value });
    props.onChangeSessionHeaders(entry.id, value ? { "X-Auth-Token": value } : {});
  };

  const clearSessionForEntry = (entryId: string | undefined) => {
    if (!entryId) return;
    delete sessionTokenRef.current[entryId];
    delete sessionLocationRef.current[entryId];
    delete sessionCreatedAtRef.current[entryId];
    props.onChangeSecret(entryId, { ...(props.secrets[entryId] || {}), token: undefined, cookie: undefined });
    props.onChangeSessionHeaders(entryId, {});
  };
  const cleanupRemoteSessionForEntry = async (entryId: string | undefined) => {
    if (!entryId) return;
    const targetEntry = props.entries.find((item) => item.id === entryId);
    const token = sessionTokenRef.current[entryId] || props.sessionHeaders[entryId] || props.secrets[entryId]?.token || "";
    const location = sessionLocationRef.current[entryId];
    try {
      if (targetEntry && token && location) {
        await requestRest(targetEntry, { ...props.secrets[entryId], token }, {}, "DELETE", resolveEntryResource(targetEntry, location), undefined, makeHeaders(targetEntry, { ...props.secrets[entryId], token }, {}));
      }
    } catch (cleanupError) {
      debugRest({ event: "iml.monitor.session_cleanup", entry: targetEntry?.name, entryId, cleanupFailure: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
    } finally {
      clearSessionForEntry(entryId);
    }
  };
  const clearSession = () => clearSessionForEntry(entry?.id);

  const logout = async () => {
    if (!entry) return;
    setLoading(true);
    setError("");
    setMessage("");
    imlControllerRef.current?.stop("manual");
    setImlPolling(false);
    const location = sessionLocationRef.current[entry.id];
    try {
      await cleanupRemoteSessionForEntry(entry.id);
      setMessage("REST session logged out.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  };
  const updateQuery = (query: { name: string; value: string }[]) => {
    if (!entry) return;
    props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, query } : item));
    try {
      const nextUrl = new URL(urlDraft || joinUrl(entry.baseUrl, path));
      nextUrl.search = "";
      query.filter((item) => item.name.trim()).forEach((item) => nextUrl.searchParams.append(item.name.trim(), item.value));
      setUrlDraft(nextUrl.toString());
    } catch { /* keep the editable URL untouched until it becomes valid */ }
  };

  const recordHistory = (requestMethod: RestMethod, requestUrl: string) => {
    if (!entry || requestMethod !== "GET") return;
    setHistory((current) => ({
      ...current,
      [entry.id]: [{ url: requestUrl, timestamp: Date.now() }, ...(current[entry.id] || []).filter((item) => item.url !== requestUrl)].slice(0, 20),
    }));
  };

  const runRequest = async (requestMethod: RestMethod, requestUrl = urlDraft.trim() || (entry ? joinUrl(entry.baseUrl, path) : ""), requestBody?: string, requestHeaders = entry ? makeHeaders(entry, secret, session) : [], workflowId = crypto.randomUUID(), throwHttpError = true) => {
    if (!entry) return;
    if (!requestUrl) throw new Error("Select or create a REST API entry first.");
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const auditBody = requestBody ? sanitizeText(requestBody) : "";
    const operation = /Bios|BIOS/i.test(requestUrl) ? "BIOS" : /Firmware|UpdateService|SimpleUpdate|AddFromUri/i.test(requestUrl) ? "firmware" : /LogServices|ClearLog|ActiveHealthSystem/i.test(requestUrl) ? "clear-log/reset" : /Processor|Memory|Ethernet|Storage|PCIe|Thermal|Power/i.test(requestUrl) ? "hardware inventory" : /TaskService/i.test(requestUrl) ? "polling" : "REST";
    debugRest({ event: "workflow.step.start", requestId, workflowId, correlationId: workflowId, workflow: operation, step: "request", nextStep: "response", entry: entry.name, vendor, method: requestMethod, url: requestUrl.split("?")[0], targetPath: (() => { try { return new URL(requestUrl).pathname; } catch { return requestUrl; } })(), tlsInsecure: entry.ignoreTlsErrors, headers: requestHeaders, body: requestBody || "", timestamp: new Date().toISOString() });
    let failedResponse: NativeApiResponse | undefined;
    let failedResponseText = "";
    try {
      const result = await requestRest(entry, secret, session, requestMethod, requestUrl, requestBody, requestHeaders);
      const { responseValue, text } = result;
      failedResponse = responseValue;
      failedResponseText = text;
      const contentType = responseValue.headers?.find(([name]) => name.toLowerCase() === "content-type")?.[1] || "";
      const textual = /json|text|xml|javascript|yaml|html/i.test(contentType);
      debugRest({ event: "workflow.step.result", requestId, workflowId, correlationId: workflowId, workflow: operation, step: "response", nextStep: responseValue.status >= 400 ? "failure" : "complete", entry: entry.name, vendor, method: requestMethod, status: responseValue.status, statusText: responseValue.statusText || "", durationMs: Math.round(performance.now() - started), headers: responseValue.headers || [], contentType, bodyBytes: responseValue.body.length, body: textual ? text : `[binary response omitted; content-type=${contentType || "unknown"}; bytes=${responseValue.body.length}]` });
      setAuditItems((items) => [{ id: requestId, timestamp: Date.now(), method: requestMethod, url: requestUrl, status: responseValue.status, durationMs: Math.round(performance.now() - started), body: auditBody }, ...items].slice(0, 100));
    setResponse(responseValue);
    setResponseText(text);
    setUrlDraft(requestUrl);
    recordHistory(requestMethod, requestUrl);
      if (throwHttpError && responseValue.status >= 400) {
        const failure = new Error(formatRedfishError(parseRedfishError(responseValue.status, text))) as Error & { status?: number };
        failure.status = responseValue.status;
        throw failure;
      }
    try {
      const parsed = new URL(requestUrl);
      setPath(parsed.pathname || "/");
    } catch { /* the request helper validates the URL */ }
      return { responseValue, text };
    } catch (requestError) {
      const failure = describeRestFailure(requestError, failedResponse, failedResponseText);
      debugRest({ event: "workflow.step.failure", requestId, workflowId, correlationId: workflowId, workflow: operation, step: "failure", nextStep: "complete", entry: entry.name, vendor, method: requestMethod, url: requestUrl.split("?")[0], targetPath: (() => { try { return new URL(requestUrl).pathname; } catch { return requestUrl; } })(), durationMs: Math.round(performance.now() - started), ...failure });
      setAuditItems((items) => [{ id: requestId, timestamp: Date.now(), method: requestMethod, url: requestUrl, status: failure.status ?? null, durationMs: Math.round(performance.now() - started), body: auditBody, error: failure.error }, ...items].slice(0, 100));
      throw requestError;
    }
  };

  const execute = async () => {
    if (!entry) return;
    setLoading(true); setError(""); setMessage("");
    try {
      if ((method === "POST" || method === "PATCH" || method === "DELETE") && !window.confirm(`${method} may modify remote data. Send this request?`)) return;
      const requestUrl = urlDraft.trim() ? resolveEntryResource(entry, urlDraft.trim()) : joinUrl(entry.baseUrl, path);
      const requestBody = method === "GET" || method === "DELETE" ? undefined : bodyDraft;
      await runRequest(method, requestUrl, requestBody, method === "DELETE" ? makeHeaders(entry, secret, session) : [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally { setLoading(false); }
  };

  const login = async (force = false, throwOnError = false) => {
    if (force) clearSessionForEntry(entry?.id);
    if (loginPromiseRef.current) return loginPromiseRef.current;
    const operation = (async () => {
    if (!entry) return;
    setLoading(true); setError(""); setMessage("");
    try {
      const body = entry.loginBody.replace(/\{\{username\}\}/g, entry.username).replace(/\{\{password\}\}/g, secret.password || "");
      let loginResult = await runRequest(entry.loginMethod, joinUrl(entry.baseUrl, entry.loginPath), body, [["Content-Type", "application/json"]], crypto.randomUUID(), false);
        if (!loginResult) return;
       if (loginResult.responseValue.status >= 400) {
         const failure = new Error(formatRedfishError(parseRedfishError(loginResult.responseValue.status, loginResult.text))) as Error & { status?: number };
         failure.status = loginResult.responseValue.status;
         throw failure;
       }
       const tokenHeader = (loginResult.responseValue.headers || []).find(([name]) => name.toLowerCase() === entry.tokenHeader.toLowerCase())?.[1] || "";
       const location = (loginResult.responseValue.headers || []).find(([name]) => name.toLowerCase() === "location")?.[1] || "";
       if (location) sessionLocationRef.current[entry.id] = location;
       sessionCreatedAtRef.current[entry.id] = Date.now();
       const json = parseJson(loginResult.text);
       const token = tokenHeader || (json ? String(getJsonPath(json, entry.tokenPath) || getJsonPath(json, "data.token") || getJsonPath(json, "token") || "") : "");
      const cookie = extractCookies(loginResult.responseValue.headers);
      if (entry.tokenSendAs.toLowerCase() === "cookie" && cookie) updateSecret({ cookie });
      else if (token) setSessionHeader(token);
      else if (cookie) updateSecret({ cookie });
      else throw new Error("Login succeeded but no configured token or cookie was found.");
      setMessage("REST session established for this entry.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
      if (throwOnError) throw requestError;
    }
    finally { setLoading(false); }
    })();
    loginPromiseRef.current = operation;
    void operation.finally(() => { loginPromiseRef.current = null; }).catch(() => {});
    return operation;
  };

  const verifyAuthentication = async () => {
    if (!entry) return;
    const nextPath = defaultRequestPath(entry.authMode);
    const requestUrl = joinUrl(entry.baseUrl, nextPath);
    setPath(nextPath);
    setUrlDraft(requestUrl);
    setLoading(true); setError(""); setMessage("");
    try {
      await runRequest("GET", requestUrl, undefined, makeHeaders(entry, secret, session));
      setMessage("Authentication verified for this entry.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally { setLoading(false); }
  };
  const authenticate = () => entry?.authMode === "login" ? login() : verifyAuthentication();

  const openPath = async (nextPath: string) => {
    if (!entry) return;
    setLoading(true);
    setError("");
    try {
      const nextUrl = resolveEntryResource(entry, nextPath);
      await runRequest("GET", nextUrl);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  };
  const downloadResource = async (target: string) => {
    if (!entry) return;
    setLoading(true); setError(""); setMessage("");
    try {
      const destinationFolder = await invoke<string | null>("pick_local_directory", { path: "" });
      if (destinationFolder === null) return;
       const url = resolveEntryResource(entry, target);
      const parsed = new URL(url);
      const fileName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "redfish-download.bin").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-");
      const saved = await invoke<string>("download_to_disk_at", {
        transferId: crypto.randomUUID(),
        url,
        method: "GET",
        headers: makeHeaders(entry, secret, session),
        body: null,
        destinationFolder,
        relativePath: fileName,
        ignoreTlsErrors: entry.ignoreTlsErrors,
      });
      setMessage(`Downloaded ${fileName} to ${saved}.`);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    } finally { setLoading(false); }
  };
  const executeAction = async () => {
    if (!entry || !selectedAction) return;
    const actionPayload = actionBody.trim() ? parseJson(actionBody) : {};
    if (!actionPayload || typeof actionPayload !== "object" || Array.isArray(actionPayload)) { setError("Action body must be a JSON object."); return; }
    if (actionInfo && typeof actionInfo === "object" && !Array.isArray(actionInfo) && Array.isArray(actionInfo.Parameters)) {
      const missing = actionInfo.Parameters.filter((item) => item && typeof item === "object" && !Array.isArray(item) && item.Required === true && typeof item.Name === "string" && !(item.Name in actionPayload)).map((item) => String((item as Record<string, JsonValue>).Name));
      if (missing.length) { setError(`Missing required action parameter(s): ${missing.join(", ")}`); return; }
    }
    if (!window.confirm(`Run ${selectedAction.title}? This may change the server state.`)) return;
    setLoading(true); setError(""); setMessage("");
    try {
        await runRequest("POST", resolveEntryResource(entry, selectedAction.target), actionBody.trim() === "{}" ? undefined : actionBody, [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)]);
      setMessage(`${selectedAction.title} action completed.`);
      setActionOpen(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally { setLoading(false); }
  };
  const openAllResources = async () => {
    if (!entry) return;
    setLoading(true); setError("");
    try {
      const result = await runRequest("GET", joinUrl(entry.baseUrl, "/redfish/v1"));
      const root = result ? parseJson(result.text) : null;
      const links = root ? collectRedfishLinks(root).filter((item) => item.kind === "resource") : [];
      const unique = new Map([["Service root", { name: "Service root", target: "/redfish/v1", kind: "resource" as const }], ...links.map((item) => [item.target, item] as const)]);
      setResourceCatalog([...unique.values()]); setResourceCatalogOpen(true);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : String(requestError)); }
    finally { setLoading(false); }
  };
  const openResource = async (target: string) => {
    if (!entry) return;
    try { await openPath(resolveEntryResource(entry, target)); }
    catch (resourceError) { setError(resourceError instanceof Error ? resourceError.message : String(resourceError)); }
  };
  const updateActionParameter = (name: string, value: JsonValue) => {
    setActionForm((current) => {
      const next = { ...current, [name]: value };
      setActionBody(JSON.stringify(next, null, 2));
      return next;
    });
  };
  const openAction = async (action: RedfishAction) => {
    setSelectedAction(action); setActionBody(defaultActionBody(action)); setActionInfo(null); setActionForm({}); setActionOpen(true);
    if (!entry || !action.actionInfo) return;
    try {
      const result = await runRequest("GET", joinUrl(entry.baseUrl, action.actionInfo));
      const info = result ? parseJson(result.text) : null;
      setActionInfo(info);
      if (info && typeof info === "object" && !Array.isArray(info) && Array.isArray(info.Parameters)) {
        setActionForm(Object.fromEntries(info.Parameters.filter((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.Name === "string").map((item) => {
          const parameter = item as Record<string, JsonValue>;
          const values = parameter.AllowableValues;
          return [String(parameter.Name), Array.isArray(values) && values.length ? values[0] : ""];
        })));
      }
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : String(requestError)); }
  };
  type HpeTargets = {
    system: string;
    serialNumber: string;
    chassis: string;
    manager: string;
    updateService: string;
    iml: string;
    devices: string;
    bios: string;
    biosSettings: string;
    firmwareInventory: string;
    powerSystem: string;
    ahs: string;
  };
  type CollectionResult = {
    root: Record<string, JsonValue>;
    members: Record<string, JsonValue>[];
    errors: string[];
  };
  const readJsonResource = async (target: string) => {
    if (!entry || !target) throw new Error("Redfish resource target is missing.");
    const result = await runRequest("GET", joinUrl(entry.baseUrl, target));
    const value = result ? parseJson(result.text) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Redfish resource did not return an object: ${target}`);
    return value as Record<string, JsonValue>;
  };
  const readCollection = async (target: string, inlineKeys: string[] = []): Promise<CollectionResult> => {
    const members: Record<string, JsonValue>[] = [];
    const errors: string[] = [];
    let next = target;
    let firstRoot: Record<string, JsonValue> = {};
    const visited = new Set<string>();
    while (next && !visited.has(next)) {
      visited.add(next);
      const root = await readJsonResource(next);
      if (!Object.keys(firstRoot).length) firstRoot = root;
      const inline = inlineKeys.flatMap((key) => Array.isArray(root[key]) ? root[key] : []).filter((item): item is Record<string, JsonValue> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
      const collectionMembers = Array.isArray(root.Members) ? root.Members : inline;
      for (const member of collectionMembers) {
        if (!member || typeof member !== "object" || Array.isArray(member)) continue;
        const memberTarget = typeof member["@odata.id"] === "string" ? String(member["@odata.id"]) : "";
        if (!memberTarget || Object.keys(member).some((key) => !key.startsWith("@odata."))) {
          members.push(member);
          continue;
        }
        try {
          members.push(await readJsonResource(memberTarget));
        } catch (error) {
          errors.push(`${memberTarget}: ${error instanceof Error ? error.message : String(error)}`);
          members.push(member);
        }
      }
      const nextTarget = root["Members@odata.nextLink"] || root["@odata.nextLink"];
      next = typeof nextTarget === "string" ? nextTarget : "";
    }
    return { root: firstRoot, members, errors };
  };
  const discoverHpeTargets = async (): Promise<HpeTargets> => {
    const root = await readJsonResource("/redfish/v1");
    const link = (resource: Record<string, JsonValue>, key: string) => {
      const value = resource[key];
      return value && typeof value === "object" && !Array.isArray(value) && typeof value["@odata.id"] === "string" ? String(value["@odata.id"]) : "";
    };
    const firstMember = async (target: string) => {
      if (!target) return "";
      const collection = await readJsonResource(target);
      const first = Array.isArray(collection.Members) ? collection.Members.find((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item["@odata.id"] === "string") : null;
      return first && typeof first === "object" && !Array.isArray(first) ? String(first["@odata.id"]) : target;
    };
    const systems = link(root, "Systems");
    const chassis = link(root, "Chassis");
    const managers = link(root, "Managers");
    const updateService = link(root, "UpdateService");
    const system = await firstMember(systems);
    const chassisTarget = await firstMember(chassis);
    const manager = await firstMember(managers);
    const systemResource = system ? await readJsonResource(system) : {};
    const chassisResource = chassisTarget ? await readJsonResource(chassisTarget) : {};
    const managerResource = manager ? await readJsonResource(manager) : {};
    const updateServiceResource = updateService ? await readJsonResource(updateService) : {};
    const logServices = link(systemResource, "LogServices");
    const managerLogServices = link(managerResource, "LogServices");
    const iml = logServices ? `${logServices}/IML/Entries` : "";
    const devices = link(chassisResource, "Devices") || (chassisTarget ? `${chassisTarget}/Devices` : "");
    const bios = link(systemResource, "Bios") || (system ? `${system}/Bios` : "");
    return {
      system,
      serialNumber: typeof systemResource.SerialNumber === "string" ? systemResource.SerialNumber : "",
      chassis: chassisTarget,
      manager,
      updateService,
      iml: iml || (managerLogServices ? `${managerLogServices}/IML/Entries` : ""),
      devices,
      bios,
      biosSettings: bios ? `${bios}/Settings` : "",
      firmwareInventory: link(updateServiceResource, "FirmwareInventory") || (updateService ? `${updateService}/FirmwareInventory` : ""),
      powerSystem: system,
      ahs: "",
    };
  };
  const openDevices = async () => {
    if (!entry) return;
    setLoading(true); setError("");
    try {
      const targets = await discoverHpeTargets();
      if (!targets.devices) throw new Error("HPE Chassis Devices resource was not advertised.");
      const collection = await readCollection(targets.devices);
      setDevicesData({ ...collection.root, Members: collection.members });
      setDevicesOpen(true);
      if (collection.errors.length) setError(`Partial failure: ${collection.errors.join("; ")}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally { setLoading(false); }
  };
  const discoverOpenBmc = async () => {
    if (!entry) return;
    try {
      const result = await runRequest("GET", joinUrl(entry.baseUrl, "/redfish/v1"));
      const root = result ? parseJson(result.text) : null;
      const found: Record<string, string> = {};
      const walk = (value: JsonValue) => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (!value || typeof value !== "object") return;
        Object.entries(value).forEach(([key, child]) => {
          if (key === "@odata.id" && typeof child === "string") found["root"] ||= child;
          if (/^(Systems|Chassis|Managers|UpdateService|SessionService|AccountService)$/.test(key) && child && typeof child === "object" && !Array.isArray(child) && typeof child["@odata.id"] === "string") found[key] = String(child["@odata.id"]);
          walk(child);
        });
      };
      if (root) walk(root);
      setOpenBmcCapabilities(found); setMessage(`OpenBMC capabilities discovered: ${Object.keys(found).filter((key) => key !== "root").join(", ") || "none"}.`);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : String(requestError)); }
  };
  const openBmcInventory = async () => {
    if (!entry) return;
    setOpenBmcInventoryOpen(true);
    setOpenBmcInventoryLoading(true);
    setOpenBmcInventoryError("");
    try {
      const root = await readJsonResource("/redfish/v1");
      const link = (resource: Record<string, JsonValue>, key: string) => {
        const value = resource[key];
        return value && typeof value === "object" && !Array.isArray(value) && typeof value["@odata.id"] === "string" ? String(value["@odata.id"]) : "";
      };
      const firstMember = async (target: string) => {
        if (!target) return { path: "", resource: {} as Record<string, JsonValue> };
        const collection = await readJsonResource(target);
        const member = Array.isArray(collection.Members) ? collection.Members.find((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item["@odata.id"] === "string") : null;
        const path = member && typeof member === "object" && !Array.isArray(member) ? String(member["@odata.id"]) : target;
        return { path, resource: await readJsonResource(path) };
      };
      const safeCollection = async (target: string, inlineKeys: string[] = []) => {
        if (!target) return { root: {}, members: [], errors: [] } as CollectionResult;
        try { return await readCollection(target, inlineKeys); }
        catch (error) { return { root: {}, members: [], errors: [error instanceof Error ? error.message : String(error)] }; }
      };
      const systemTarget = await firstMember(link(root, "Systems"));
      const chassisTarget = await firstMember(link(root, "Chassis"));
      const managerTarget = await firstMember(link(root, "Managers"));
      const updateService = link(root, "UpdateService");
      const system = systemTarget.resource;
      const chassis = chassisTarget.resource;
      const manager = managerTarget.resource;
      const processors = await safeCollection(link(system, "Processors"));
      const memory = await safeCollection(link(system, "Memory"));
      const pcie = await safeCollection(link(system, "PCIeDevices"));
      const storage = await safeCollection(link(system, "Storage"));
      const power = await safeCollection(link(chassis, "Power"), ["PowerSupplies"]);
      const slots = await safeCollection(link(chassis, "PCIeSlots"), ["Slots"]);
      const firmware = await safeCollection(link(await safeCollection(updateService).then((value) => value.root), "FirmwareInventory"));
      const driveCollections = await Promise.all(storage.members.map((item) => safeCollection(link(item, "Drives"))));
      const drives = driveCollections.flatMap((value) => value.members);
      const snapshot: OpenBmcInventorySnapshot = {
        root, system, chassis, manager,
        processors: processors.members, memory: memory.members, pcieDevices: pcie.members,
        storage: storage.members, drives, powerSupplies: power.members, pcieSlots: slots.members,
        firmwareInventory: firmware.members, secureBoot: link(system, "SecureBoot") ? await readJsonResource(link(system, "SecureBoot")) : {},
      };
      const failures = [processors, memory, pcie, storage, power, slots, firmware, ...driveCollections].flatMap((value) => value.errors);
      setOpenBmcInventorySnapshot(snapshot);
      setOpenBmcInventoryRows(openBmcInventoryTableRows(snapshot));
      setOpenBmcSpecRows(buildOpenBmcSpecRows(snapshot));
      if (failures.length) setOpenBmcInventoryError(`Partial failure: ${failures.join("; ")}`);
    } catch (requestError) {
      setOpenBmcInventoryError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally { setOpenBmcInventoryLoading(false); }
  };
  const exportOpenBmcSpecCsv = () => {
    if (!entry || !openBmcSpecRows.length) return;
    downloadText(`${entry.name || "openbmc"}-hardware-spec.csv`, openBmcSpecCsv(openBmcSpecRows), "text/csv;charset=utf-8");
  };
  const openBmcResource = async (target: string) => {
    if (!entry) return;
    setOpenBmcResourceTarget(target);
    setOpenBmcResourceOpen(true);
    setOpenBmcResourceLoading(true);
    try {
      const resource = await readJsonResource(target);
      const rows = openBmcInventoryTableRows({ resource });
      setOpenBmcResourceRaw(resource);
      setOpenBmcResourceRows(rows);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally { setOpenBmcResourceLoading(false); }
  };
  const runOpenBmcPower = async (resetType: "On" | "ForceOff" | "GracefulShutdown" | "ForceRestart") => {
    if (!entry) return;
    setOpenBmcMessage("");
    try {
      const systems = await runRequest("GET", joinUrl(entry.baseUrl, openBmcCapabilities.Systems || "/redfish/v1/Systems"));
      const collection = systems ? parseJson(systems.text) : null;
      const members = collection && typeof collection === "object" && !Array.isArray(collection) && Array.isArray(collection.Members) ? collection.Members : [];
      const member = members.find((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item["@odata.id"] === "string");
      const systemTarget = member && typeof member === "object" && !Array.isArray(member) ? String(member["@odata.id"]) : "";
      if (!systemTarget) throw new Error("OpenBMC did not advertise a system member target.");
      const systemResult = await runRequest("GET", joinUrl(entry.baseUrl, systemTarget));
      const system = systemResult ? parseJson(systemResult.text) : null;
      const action = system && typeof system === "object" && !Array.isArray(system) ? system.Actions : null;
      const reset = action && typeof action === "object" && !Array.isArray(action) ? action["#ComputerSystem.Reset"] : null;
      if (!reset || typeof reset !== "object" || Array.isArray(reset) || typeof reset.target !== "string") throw new Error("OpenBMC did not advertise standard ComputerSystem.Reset.");
      const allowed = reset["ResetType@Redfish.AllowableValues"];
      if (Array.isArray(allowed) && !allowed.includes(resetType)) throw new Error(`OpenBMC does not advertise reset type ${resetType}.`);
      await runRequest("POST", joinUrl(entry.baseUrl, String(reset.target)), JSON.stringify({ ResetType: resetType }), [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)]);
      const verify = await runRequest("GET", joinUrl(entry.baseUrl, systemTarget));
      const value = verify ? parseJson(verify.text) : null;
      const next = value && typeof value === "object" && !Array.isArray(value) ? String(value.PowerState || "Unknown") : "Unknown";
      setOpenBmcPowerState(next); setOpenBmcMessage(`OpenBMC ${resetType} completed; PowerState is ${next}.`);
    } catch (powerError) { setOpenBmcMessage(powerError instanceof Error ? powerError.message : String(powerError)); }
  };
  const loadHardware = async (tool: HardwareTool) => {
    if (!entry) return;
    const resolved = await discoverHardwareTools();
    const discovered = resolved.find((candidate) => candidate.id === tool.id);
    if (!discovered) { setHardwareError(`${tool.label} is not advertised by this Redfish service.`); setHardwareOpen(true); return; }
    tool = discovered;
    const started = performance.now();
    setHardwareTool(tool); setHardwareOpen(true); setHardwareLoading(true); setHardwareError("");
    try {
      const collection = await readCollection(tool.path, ["PowerSupplies", "Temperatures"]);
      setHardwareRows(collection.members.length ? collection.members : [collection.root]);
      setHardwareRaw(collection.root); setHardwareUpdatedAt(Date.now());
      if (collection.errors.length) setHardwareError(`Partial failure: ${collection.errors.join("; ")}`);
    } catch (requestError) {
      setHardwareError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally { setHardwareDurationMs(Math.round(performance.now() - started)); setHardwareLoading(false); }
  };
  const discoverHardwareTools = async (): Promise<HardwareTool[]> => {
    if (!entry) return [];
    const read = readJsonResource;
    const link = (resource: Record<string, JsonValue>, key: string) => {
      const value = resource[key];
      return value && typeof value === "object" && !Array.isArray(value) && typeof value["@odata.id"] === "string" ? value["@odata.id"] : "";
    };
    try {
      const root = await read("/redfish/v1");
      const systemPath = link(root, "Systems");
      const chassisPath = link(root, "Chassis");
      const systemCollection = systemPath ? await read(systemPath) : {};
      const chassisCollection = chassisPath ? await read(chassisPath) : {};
      const firstMember = (collection: Record<string, JsonValue>, fallback: string) => Array.isArray(collection.Members) && collection.Members[0] && typeof collection.Members[0] === "object" && !Array.isArray(collection.Members[0]) && typeof (collection.Members[0] as Record<string, JsonValue>)["@odata.id"] === "string"
        ? String((collection.Members[0] as Record<string, JsonValue>)["@odata.id"])
        : fallback;
      const system = await read(firstMember(systemCollection, systemPath));
      const chassis = await read(firstMember(chassisCollection, chassisPath));
      const paths: Record<string, string> = {
        cpu: link(system, "Processors"), memory: link(system, "Memory"), nic: link(system, "EthernetInterfaces"), storage: link(system, "Storage"), pcie: link(system, "PCIeDevices"), power: link(chassis, "Power"), thermal: link(chassis, "Thermal"),
      };
      return hardwareTools.filter((tool) => paths[tool.id]).map((tool) => ({ ...tool, path: paths[tool.id] }));
    } catch (error) {
      setHardwareError(error instanceof Error ? error.message : String(error));
      return [];
    }
  };
  const loadAllHardware = async () => {
    if (!entry) return;
    const started = performance.now();
    const summaryTool: HardwareTool = { id: "all-hardware", label: "All hardware inventory", path: "", columns: ["Category", "Name", "Status", "FirmwareVersion", "Location"] };
    setHardwareTool(summaryTool); setHardwareOpen(false); setHardwareSummaryOpen(true); setHardwareLoading(true); setHardwareError("");
    const rows: Record<string, JsonValue>[] = [];
    const groups: { tool: HardwareTool; rows: Record<string, JsonValue>[] }[] = [];
    const raw: Record<string, JsonValue> = {};
    const failures: string[] = [];
    const discoveredTools = await discoverHardwareTools();
    for (const tool of discoveredTools) {
      try {
        const collection = await readCollection(tool.path, ["PowerSupplies", "Temperatures"]);
        raw[tool.id] = collection.root;
        const root = collection.root;
        const members = collection.members.length ? collection.members : [root];
        const groupRows: Record<string, JsonValue>[] = [];
        members.filter((item): item is Record<string, JsonValue> => Boolean(item && typeof item === "object" && !Array.isArray(item))).forEach((item) => {
          const status = item.Status && typeof item.Status === "object" && !Array.isArray(item.Status)
            ? [item.Status.Health, item.Status.State].filter(Boolean).map((value) => String(value)).join(" / ") || "-"
            : item.Health || item.Status || "-";
          const row = { ...item, Category: tool.label, Name: item.Name || item.Id || "-", Status: status, FirmwareVersion: item.FirmwareVersion || "-", Location: item.Location || item.PhysicalContext || "-" };
          rows.push(row); groupRows.push(row);
        });
        groups.push({ tool, rows: groupRows });
        if (collection.errors.length) failures.push(`${tool.label}: ${collection.errors.join(", ")}`);
      } catch (error) { failures.push(`${tool.label}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    setHardwareSummaryGroups(groups); setHardwareRows(rows); setHardwareRaw(raw); setHardwareUpdatedAt(Date.now()); setHardwareDurationMs(Math.round(performance.now() - started)); setHardwareLoading(false); setHardwareError(failures.length ? `Partial failure: ${failures.join("; ")}` : "");
  };
  const exportHardwareJson = () => {
    if (!hardwareTool) return;
    downloadText(`${entry?.name || "rest"}-${hardwareTool.id}.json`, JSON.stringify(sanitizeJson({ metadata: { vendor, entry: entry?.name, exportedAt: new Date().toISOString(), firmware: hardwareRows.map((row) => row.FirmwareVersion).filter(Boolean) }, resource: hardwareRaw, rows: hardwareRows }), null, 2), "application/json");
  };
  const exportHardwareCsv = () => {
    if (!hardwareTool) return;
    const rows = [hardwareTool.columns, ...hardwareRows.map((row) => hardwareTool.columns.map((column) => tableCell(row[column])))];
    downloadText(`${entry?.name || "rest"}-${hardwareTool.id}.csv`, rows.map((row) => row.map(csvCell).join(",")).join("\n"), "text/csv;charset=utf-8");
  };
  const ensureImlSession = async (force = false) => {
    if (!entry) throw new Error("Select a REST API entry before refreshing IML.");
    if (force) clearSessionForEntry(entry.id);
    const hasSession = Boolean(sessionTokenRef.current[entry.id] || props.secrets[entry.id]?.token || props.secrets[entry.id]?.cookie);
    if (force || !hasSession) await login(force, true);
    if (!sessionTokenRef.current[entry.id] && !props.secrets[entry.id]?.token && !props.secrets[entry.id]?.cookie) {
      throw new Error("IML monitor could not establish a REST session.");
    }
  };
  const fetchIml = async (workflowId = crypto.randomUUID(), propagateError = false) => {
    if (!entry) return [];
    try {
    await ensureImlSession();
    const targets = imlTargetsRef.current || await discoverHpeTargets();
    imlTargetsRef.current = targets;
    if (!targets.iml) throw new Error("HPE IML resource was not advertised.");
    const collection = await readCollection(targets.iml);
    const members = collection.members;
    const currentKeys = new Set(members.map(imlEntryKey));
    const newestTimestamp = members.reduce((latest, row) => Math.max(latest, Date.parse(String(row.Created || row.EventTimestamp || "")) || 0), 0);
    const previousSnapshot = imlSnapshotRef.current;
    const snapshotChanged = Boolean(previousSnapshot && (members.length < previousSnapshot.count || newestTimestamp < previousSnapshot.newestTimestamp || [...previousSnapshot.keys].some((key) => !currentKeys.has(key))));
    if (snapshotChanged) {
      setImlNotice("IML resource snapshot changed; existing local entries were retained.");
      debugRest({ event: "iml.monitor.snapshot_changed", workflowId, previousCount: previousSnapshot?.count, currentCount: members.length, boundaryReason: "clear-suspected" });
    }
    imlSnapshotRef.current = { keys: currentKeys, count: members.length, newestTimestamp };
    await appendImlCsvRows(members);
    if (collection.errors.length) setImlError(`Partial IML refresh failure: ${collection.errors.join("; ")}`);
    setImlRows((current) => {
      const merged = [...members, ...current];
      const unique = new Map<string, Record<string, JsonValue>>();
      merged.forEach((row) => unique.set(imlEntryKey(row), row));
      return [...unique.values()].sort((left, right) => {
        const leftTime = Date.parse(String(left.Created || left.EventTimestamp || "")) || 0;
        const rightTime = Date.parse(String(right.Created || right.EventTimestamp || "")) || 0;
        return rightTime - leftTime;
      }).slice(0, 50);
    });
    setImlError("");
    setImlLastFetchAt(Date.now());
    setImlNotice(`Fetched ${members.length} current IML entries.`);
    return members;
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
      setImlError(message);
      const status = (fetchError as { status?: number } | null)?.status;
      if (!propagateError && (status === 401 || status === 403)) {
        try {
          await ensureImlSession(true);
          return await fetchIml(workflowId, false);
        } catch (retryError) {
          setImlError(retryError instanceof Error ? retryError.message : String(retryError));
        }
      }
      if (propagateError) throw fetchError;
      return [];
    }
  };
  const imlEntryKey = (row: Record<string, JsonValue>) => {
    if (typeof row["@odata.id"] === "string") return String(row["@odata.id"]);
    return [row.Id, row.Created, row.EventTimestamp, row.MessageId, row.Message, row.MessageArgs].map((value) => JSON.stringify(value)).join("|");
  };
  const csvField = (value: JsonValue | undefined) => {
    const text = value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  const createImlCsvSession = async (targets: HpeTargets) => {
    if (!targets.serialNumber) throw new Error("HPE ComputerSystem SerialNumber was not advertised.");
    const fields = ["@odata.id", "Id", "Created", "EventTimestamp", "Severity", "MessageId", "Message", "MessageArgs", "receivedAt", "connectionGeneration"];
    const timestamp = new Date().toISOString().replace(/T/, "_").replace(/:/g, "").replace(/\..+Z$/, "");
    try {
      imlCsvPathRef.current = await invoke<string>("create_iml_csv_session", { serialNumber: targets.serialNumber, timestamp, header: `${fields.join(",")}\n` });
      imlCsvKeysRef.current = new Set();
      setImlCsvError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImlCsvError(message);
      debugRest({ event: "iml.monitor.csv_write_failed", error: message });
      throw error;
    }
  };
  const appendImlCsvRows = async (rows: Record<string, JsonValue>[]) => {
    if (!imlCsvPathRef.current || !rows.length) return;
    const receivedAt = Date.now();
    const newRows = rows.filter((row) => {
      const key = imlEntryKey(row);
      if (imlCsvKeysRef.current.has(key)) return false;
      imlCsvKeysRef.current.add(key);
      return true;
    });
    if (!newRows.length) return;
    const content = newRows.map((row) => ["@odata.id", "Id", "Created", "EventTimestamp", "Severity", "MessageId", "Message", "MessageArgs"].map((key) => csvField(row[key])).concat([csvField(receivedAt), csvField(1)]).join(",")).join("\n") + "\n";
    try {
      await invoke("append_iml_csv_session", { path: imlCsvPathRef.current, content });
      setImlCsvError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImlCsvError(message);
      debugRest({ event: "iml.monitor.csv_write_failed", path: imlCsvPathRef.current, error: message });
      throw error;
    }
  };
  const startImlPolling = () => {
    if (imlInterval < 3000 || !entry) {
      setImlError(!entry ? "Select a REST API entry before starting the IML monitor." : "IML polling interval must be at least 3 seconds.");
      return;
    }
    clearAhsTimer();
    setImlError("");
    setImlNotice("Starting IML monitor and establishing the REST session...");
    setImlManualStopped(false);
    setAhsTarget("");
    setAhsMessage("");
    const workflowId = crypto.randomUUID();
    const controller = new ImlMonitorController<Record<string, JsonValue>>();
    imlControllerRef.current?.stop("replaced");
    imlControllerRef.current = controller;
    imlTargetsRef.current = null;
    imlCsvPathRef.current = null;
    imlCsvKeysRef.current = new Set();
    imlSnapshotRef.current = null;
    controller.start({
      workflowId,
      intervalMs: imlInterval,
      login: async (_signal, force) => {
        await ensureImlSession(force);
      },
      discover: async () => {
        imlTargetsRef.current = await discoverHpeTargets();
        if (!imlCsvPathRef.current) await createImlCsvSession(imlTargetsRef.current);
      },
      fetch: async () => {
        const entries = await fetchIml(workflowId, true);
        return { entries, receivedAt: Date.now(), connectionGeneration: 0, sessionGeneration: 0 };
      },
      onState: (state) => {
        imlStateRef.current = state;
        setImlState(state);
        setImlPolling(state !== "stopped" && state !== "stopped-by-user");
        setImlNotice(state === "connecting" ? "Connecting to the IML resource..." : state === "reconnecting" ? "IML session disconnected; reconnecting automatically..." : state === "monitoring" ? "IML monitor is running." : state === "authentication-failed" ? "IML session authentication failed; retrying with a new session..." : state === "disconnected" ? "IML connection lost; waiting before retrying..." : state === "stopped" ? "IML monitor stopped." : "");
      },
      onError: (monitorError, retry) => {
        setImlRetryCount(retry);
        setImlError(monitorError.message);
      },
      onSnapshot: () => { setImlLastFetchAt(Date.now()); setImlNextRetryAt(null); },
      onRetryScheduled: (_retry, nextAttemptAt) => setImlNextRetryAt(nextAttemptAt),
      onStop: () => { setImlPolling(false); setImlNextRetryAt(null); },
    });
    setImlPolling(true);
  };
  const clearAhsTimer = () => {
    if (ahsTimerRef.current !== null) window.clearTimeout(ahsTimerRef.current);
    ahsTimerRef.current = null;
  };
  const discoverAhs = async () => {
    if (!entry) return "";
    const root = await readJsonResource("/redfish/v1");
    const candidates: string[] = [];
    const walk = (value: JsonValue) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== "object") return;
      Object.entries(value).forEach(([key, child]) => {
        if (typeof child === "string" && /(?:ahs|activehealthsystem|download)/i.test(`${key} ${child}`)) candidates.push(child);
        walk(child);
      });
    };
    walk(root);
    const target = candidates.find((candidate) => {
      try { resolveEntryResource(entry, candidate); return true; } catch { return false; }
    }) || "";
    setAhsTarget(target);
    return target;
  };
  const startAhsWindow = () => {
    clearAhsTimer();
    ahsTimerRef.current = window.setTimeout(() => {
      clearSession();
      setAhsTarget("");
      setAhsMessage("AHS download window expired.");
    }, 60_000);
  };
  const downloadAhs = async () => {
    if (!entry || !ahsTarget) return;
    clearAhsTimer();
    setLoading(true); setError(""); setAhsMessage("");
    const target = ahsTarget;
    debugRest({ event: "iml.monitor.ahs_download_start", targetPath: target });
    try {
      await downloadResource(target);
      await cleanupRemoteSessionForEntry(entry.id);
      setAhsTarget("");
      setAhsMessage("AHS download completed.");
      debugRest({ event: "iml.monitor.ahs_download_complete", targetPath: target });
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
      setAhsMessage("AHS download failed. Retry while the selection window remains open.");
      debugRest({ event: "iml.monitor.ahs_download_failed", targetPath: target, error: downloadError instanceof Error ? downloadError.message : String(downloadError) });
      startAhsWindow();
    } finally { setLoading(false); }
  };
  const stopImlPolling = (reason: "manual" | "close" = "manual") => {
    imlControllerRef.current?.stop(reason);
    setImlPolling(false);
    if (reason !== "manual") {
      clearAhsTimer();
      setImlManualStopped(false);
      setAhsTarget("");
      void cleanupRemoteSessionForEntry(entry?.id);
      return;
    }
    setImlManualStopped(true);
    void discoverAhs().then((target) => {
      if (target) startAhsWindow();
      else {
        void cleanupRemoteSessionForEntry(entry?.id);
        setAhsMessage("This iLO does not advertise an AHS download resource.");
      }
    }).catch((error) => setAhsMessage(error instanceof Error ? error.message : String(error)));
  };
  const discoverPower = async () => {
    if (!entry) return;
    setPowerOpen(true); setPowerMessage("");
    try {
       const targets = await discoverHpeTargets();
       const result = await runRequest("GET", joinUrl(entry.baseUrl, targets.powerSystem));
      const value = result ? parseJson(result.text) : null;
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
       const root = value as Record<string, JsonValue>;
        if (typeof root["@odata.id"] === "string") setPowerSystemTarget(String(root["@odata.id"]));
       setPowerState(String(root.PowerState || "Unknown"));
       const actions = root.Actions && typeof root.Actions === "object" && !Array.isArray(root.Actions) ? root.Actions as Record<string, JsonValue> : {};
       const reset = Object.entries(actions).find(([key]) => /Reset$|ComputerSystem\.Reset/i.test(key));
       const resetValue = reset?.[1] && typeof reset[1] === "object" && !Array.isArray(reset[1]) ? reset[1] as Record<string, JsonValue> : {};
       setPowerResetTarget(typeof resetValue.target === "string" ? String(resetValue.target) : "");
       const resetAllowable = resetValue["ResetType@Redfish.AllowableValues"];
       setPowerResetTypes(Array.isArray(resetAllowable) ? resetAllowable.filter((item): item is string => typeof item === "string") : []);
       setPowerActions(Object.keys(actions).filter((key) => /Reset/i.test(key)));
       const oemGroup = actions.Oem && typeof actions.Oem === "object" && !Array.isArray(actions.Oem) ? actions.Oem as Record<string, JsonValue> : {};
       const oem = actions["#HpeComputerSystemExt.PowerButton"] || actions["#HpeiLOComputerSystemExt.PowerButton"] || oemGroup["#HpeComputerSystemExt.PowerButton"] || oemGroup["#HpeiLOComputerSystemExt.PowerButton"];
      if (oem && typeof oem === "object" && !Array.isArray(oem)) {
        const action = oem as Record<string, JsonValue>;
        setPowerButtonTarget(typeof action.target === "string" ? action.target : "");
        const allowable = action["PushType@Redfish.AllowableValues"];
        setPowerButtonTypes(Array.isArray(allowable) ? allowable.filter((value): value is string => typeof value === "string") : []);
      } else { setPowerButtonTarget(""); setPowerButtonTypes([]); }
    } catch (error) { setPowerMessage(error instanceof Error ? error.message : String(error)); }
  };
  const pressPowerButton = async (pushType: string) => {
    if (!entry || !powerButtonTarget || !powerButtonTypes.includes(pushType)) return;
    if (!window.confirm(`${pushType === "PressAndHold" ? "Press and hold" : "Press"} power button on ${entry.baseUrl}?`)) return;
    setPowerBusy(true); setPowerMessage(`Sending ${pushType}...`);
    try { await runRequest("POST", joinUrl(entry.baseUrl, powerButtonTarget), JSON.stringify({ PushType: pushType }), [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)]); setPowerMessage(`${pushType} accepted by HPE PowerButton.`); }
    catch (error) { setPowerMessage(error instanceof Error ? error.message : String(error)); }
    finally { setPowerBusy(false); }
  };
  const loadBios = async () => {
    if (!entry) return;
    try {
       const targets = await discoverHpeTargets();
       if (!targets.bios) throw new Error("HPE BIOS resource was not advertised.");
       const result = await runRequest("GET", joinUrl(entry.baseUrl, targets.bios));
      const value = result ? parseJson(result.text) : null;
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const root = value as Record<string, JsonValue>;
      const attrs = root.Attributes && typeof root.Attributes === "object" && !Array.isArray(root.Attributes) ? root.Attributes as Record<string, JsonValue> : {};
       setBiosRaw(root); setBiosDraft({ ...attrs }); setBiosCompare(root.PendingAttributes && typeof root.PendingAttributes === "object" && !Array.isArray(root.PendingAttributes) ? root.PendingAttributes as Record<string, JsonValue> : null); setSelectedBiosAttribute(""); setBiosOpen(true); setBiosMessage("");
    } catch (error) { setBiosMessage(error instanceof Error ? error.message : String(error)); }
  };
  const applyBios = async () => {
    if (!entry) return;
     const payload = { Attributes: biosPatch };
     if (!Object.keys(payload.Attributes).length) { setBiosMessage("No BIOS changes are pending."); return; }
    if (!window.confirm(`Apply BIOS payload?\n${JSON.stringify(payload, null, 2)}`)) return;
      try { const targets = await discoverHpeTargets(); if (!targets.biosSettings) throw new Error("HPE BIOS settings resource was not advertised."); const result = await runRequest("PATCH", joinUrl(entry.baseUrl, targets.biosSettings), JSON.stringify(payload), [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)]); const response = result ? parseJson(result.text) : null; setBiosMessage(`${response && typeof response === "object" && !Array.isArray(response) && response.RebootRequired ? "BIOS PATCH applied. Reboot required." : "BIOS PATCH applied."} Payload: ${JSON.stringify(payload.Attributes)}`); await loadBios(); }
    catch (error) { setBiosMessage(error instanceof Error ? error.message : String(error)); }
  };
  const enterBiosSetup = async () => {
    if (!window.confirm("Schedule BIOS Setup for the next boot? The server will require a reboot and may interrupt services.")) return;
    if (!entry) return;
      try { const targets = await discoverHpeTargets(); if (!targets.system) throw new Error("HPE System resource was not advertised."); const result = await runRequest("PATCH", joinUrl(entry.baseUrl, targets.system), JSON.stringify({ Boot: { BootSourceOverrideTarget: "BiosSetup", BootSourceOverrideEnabled: "Once" } }), [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)]); const response = result ? parseJson(result.text) : null; setBiosMessage(response && typeof response === "object" && !Array.isArray(response) && response.RebootRequired ? "BIOS Setup scheduled for next boot. Reboot required." : "BIOS Setup request accepted."); }
    catch (error) { setBiosMessage(error instanceof Error ? error.message : String(error)); }
  };
  const loadFirmware = async () => {
    if (!entry) return;
    try {
       const targets = await discoverHpeTargets();
       if (!targets.updateService) throw new Error("HPE UpdateService resource was not advertised.");
        if (!targets.firmwareInventory) throw new Error("HPE FirmwareInventory resource was not advertised.");
        const collection = await readCollection(targets.firmwareInventory);
       const inventoryRows = collection.members;
       setFirmwareInventory(inventoryRows); setFirmwareRaw(collection.root);
       const service = await runRequest("GET", joinUrl(entry.baseUrl, targets.updateService));
      const serviceValue = service ? parseJson(service.text) : null;
      const actions = serviceValue && typeof serviceValue === "object" && !Array.isArray(serviceValue) ? collectRedfishActions(serviceValue) : [];
      const action = actions.find((item) => /SimpleUpdate|AddFromUri/.test(item.name));
      setFirmwareAction(action?.target || "");
      setFirmwareTarget(String(inventoryRows.find((item) => typeof item["@odata.id"] === "string")?.["@odata.id"] || ""));
      const serviceRecord = serviceValue && typeof serviceValue === "object" && !Array.isArray(serviceValue) ? serviceValue as Record<string, JsonValue> : {};
      const advertised = JSON.stringify(serviceRecord).toLowerCase();
      setFirmwareSupportsTpm(advertised.includes("tpm"));
      setFirmwareSupportsTarget(advertised.includes("updatetarget") || inventoryRows.some((item) => typeof item["@odata.id"] === "string"));
       setFirmwareSupportsRepository(advertised.includes("updaterepository"));
       setFirmwareOpen(true); setFirmwareMessage(collection.errors.length ? `Partial failure: ${collection.errors.join("; ")}` : "");
    } catch (error) { setFirmwareMessage(error instanceof Error ? error.message : String(error)); }
  };
  const startFirmware = async () => {
    if (!entry || !firmwareAction || !/^https?:\/\//i.test(firmwareUri)) { setFirmwareMessage("Enter a valid HTTP(S) firmware URI and select an advertised action."); return; }
    const payload: Record<string, JsonValue> = { ImageURI: firmwareUri, TransferProtocol: firmwareUri.startsWith("https") ? "HTTPS" : "HTTP" };
    if (firmwareSupportsTarget && firmwareTarget) payload.UpdateTarget = firmwareTarget;
    if (firmwareSupportsTpm) payload.TPMOverride = firmwareTpmOverride;
    if (firmwareSupportsRepository && firmwareUpdateRepository.trim()) payload.UpdateRepository = firmwareUpdateRepository.trim();
    setFirmwarePreview({ endpoint: joinUrl(entry.baseUrl, firmwareAction), method: "POST", payload });
    setFirmwareMessage("Payload ready. Confirm the exact endpoint and payload to start the firmware update.");
  };
  const applyFirmware = async () => {
    if (!entry || !firmwarePreview || typeof firmwarePreview.endpoint !== "string" || !firmwarePreview.payload || typeof firmwarePreview.payload !== "object" || Array.isArray(firmwarePreview.payload)) return;
    const workflowId = crypto.randomUUID();
    try {
      const endpoint = firmwarePreview.endpoint;
      const payload = firmwarePreview.payload as Record<string, JsonValue>;
      const inventoryTarget = payload.UpdateTarget;
      if (typeof inventoryTarget === "string" && inventoryTarget) {
        const targetResult = await runRequest("GET", joinUrl(entry.baseUrl, inventoryTarget));
        const target = targetResult ? parseJson(targetResult.text) : null;
        if (!target || typeof target !== "object" || Array.isArray(target) || (target as Record<string, JsonValue>).Updateable === false) {
          setFirmwareMessage("The selected FirmwareInventory target is missing or is not updateable."); return;
        }
      }
      if (!window.confirm("Submit this exact firmware payload? The iLO may reboot or become unavailable.")) return;
      const result = await runRequest("POST", endpoint, JSON.stringify(payload), [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)], workflowId);
      if (!result) return;
       const monitored = await monitorRedfishTask({ workflowId, initial: { status: result.responseValue.status, headers: result.responseValue.headers, body: result.text }, intervalMs: 3000, fetchTask: async (location) => { const next = await runRequest("GET", resolveEntryResource(entry, location), undefined, makeHeaders(entry, secret, session), workflowId); if (!next) throw new Error("Task response was empty."); return { status: next.responseValue.status, headers: next.responseValue.headers, body: next.text }; }, onProgress: (progress) => setFirmwareMessage(`${progress.state} · ${progress.status} · ${progress.percentComplete ?? "?"}%`) });
       setFirmwareMessage(`Firmware update ${monitored.progress.state}.`); setFirmwarePreview(null);
       if (/reset|reboot|ilo/i.test(firmwareAction)) {
         setSessionHeader("");
         setFirmwareMessage("Firmware update completed. The iLO session was cleared; reconnect before refreshing inventory.");
       } else {
         await loadFirmware();
       }
    } catch (error) { setFirmwareMessage(error instanceof Error ? error.message : String(error)); }
  };
  const resetLogs = async () => {
    if (!entry || !window.confirm(`Clear IEL, IML, AHS and reset iLO for ${entry.baseUrl}?`)) return;
     let hpeTargets: HpeTargets;
     try { hpeTargets = await discoverHpeTargets(); }
     catch (error) { setResetMessage(error instanceof Error ? error.message : String(error)); return; }
     if (!hpeTargets.manager || !hpeTargets.system) { setResetMessage("HPE Manager or System resource was not advertised."); return; }
     const targets = [
       ["IEL", `${hpeTargets.manager}/LogServices/IEL/Actions/LogService.ClearLog`],
       ["IML", `${hpeTargets.system}/LogServices/IML/Actions/LogService.ClearLog`],
       ["AHS", `${hpeTargets.manager}/ActiveHealthSystem/Actions/HpeiLOActiveHealthSystem.ClearLog`],
       ["iLO reset", `${hpeTargets.manager}/Actions/Manager.Reset`],
     ];
    setResetOpen(true); setResetMessage(""); setResetSteps([]);
    let managerResetRequested = false;
    for (const [name, path] of targets) {
      try {
        await runRequest("POST", joinUrl(entry.baseUrl, path), "{}", [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)]);
        if (name === "AHS") {
          setResetSteps((steps) => [...steps, { name, status: "accepted; cleanup in progress" }]);
          for (let remaining = 120; remaining > 0; remaining -= 1) {
            setResetSteps((steps) => steps.map((step) => step.name === name ? { ...step, status: `cleaning AHS data; ${remaining}s remaining` } : step));
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          }
          setResetSteps((steps) => steps.map((step) => step.name === name ? { ...step, status: "completed" } : step));
        } else {
          if (name === "iLO reset") managerResetRequested = true;
          setResetSteps((steps) => [...steps, { name, status: "completed" }]);
        }
      }
      catch (error) { setResetSteps((steps) => [...steps, { name, status: `failed: ${error instanceof Error ? error.message : String(error)}` }]); if (!window.confirm(`${name} failed. Continue with remaining steps?`)) break; }
    }
    if (managerResetRequested) { props.onChangeSecret(entry.id, { ...secret, token: "", cookie: "" }); props.onChangeSessionHeaders(entry.id, {}); setResetMessage("iLO reset invalidates the REST session. Reconnect when the manager is available."); }
    else setResetMessage("The iLO reset step did not complete; the current REST session was retained.");
  };
   const runPowerAction = async (action: string) => {
     if (!entry || !powerResetTarget) { setPowerMessage("The Redfish service did not advertise a ComputerSystem.Reset target."); return; }
     const resetType = action === "On" ? "On" : action === "Off" ? "GracefulShutdown" : action === "ForceOff" ? "ForceOff" : action === "GracefulRestart" ? "GracefulRestart" : action === "ColdBoot" ? "ColdBoot" : "ForceRestart";
     if (powerResetTypes.length && !powerResetTypes.includes(resetType)) { setPowerMessage(`${resetType} is not advertised by this system.`); return; }
     const destructive = !["On"].includes(action);
     const target = powerResetTarget;
     const body = { ResetType: resetType };
    if (destructive && !window.confirm(`Power action ${action} on ${entry.baseUrl}? This may cause data loss.`)) return;
    setPowerBusy(true); setPowerMessage(`Starting ${action}...`);
    try {
       const result = await runRequest("POST", joinUrl(entry.baseUrl, target), JSON.stringify(body), [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)]);
       if (result) setPowerLastRequest({ target: joinUrl(entry.baseUrl, target), payload: JSON.stringify(body, null, 2), status: result.responseValue.status });
        const expected = ["On", "Reset", "GracefulRestart", "ColdBoot"].includes(action) ? "On" : "Off";
        const verificationTimeoutMs = 120_000;
        const verificationIntervalMs = 3_000;
        const verificationStartedAt = Date.now();
        const verificationDeadline = verificationStartedAt + verificationTimeoutMs;
        let next = "Unknown";
        let attempt = 0;
        while (Date.now() <= verificationDeadline) {
          attempt += 1;
          const elapsedSeconds = Math.min(verificationTimeoutMs / 1_000, Math.floor((Date.now() - verificationStartedAt) / 1_000));
          setPowerMessage(`Waiting for ${action} confirmation... ${elapsedSeconds}/${verificationTimeoutMs / 1_000}s (attempt ${attempt})`);
          const verify = await runRequest("GET", joinUrl(entry.baseUrl, powerSystemTarget), undefined, makeHeaders(entry, secret, session));
          const value = verify ? parseJson(verify.text) : null;
          next = value && typeof value === "object" && !Array.isArray(value) ? String((value as Record<string, JsonValue>).PowerState || "Unknown") : "Unknown";
          setPowerState(next);
          if (next === expected) break;
          const remainingMs = verificationDeadline - Date.now();
          if (remainingMs <= 0) break;
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(verificationIntervalMs, remainingMs)));
        }
        setPowerMessage(next === expected ? `${action} completed; PowerState is ${next}.` : `${action} request returned, but verification timed out after ${verificationTimeoutMs / 1_000}s with PowerState ${next} (expected ${expected}).`);
    } catch (error) { setPowerMessage(error instanceof Error ? error.message : String(error)); }
    finally { setPowerBusy(false); }
  };
  const currentHistory = entry ? history[entry.id] || [] : [];
  const json = parseJson(responseText);
  const rows = json && typeof json === "object" && !Array.isArray(json) ? Object.entries(json) : [];
  const actions = collectRedfishActions(json);
  const links = collectRedfishLinks(json);
  const deviceRows = devicesData && typeof devicesData === "object" && !Array.isArray(devicesData) && Array.isArray(devicesData.Members)
    ? devicesData.Members.filter((item): item is { [key: string]: JsonValue } => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
  const visibleImlRows = imlRows.filter((row) => (!imlKeyword || JSON.stringify(row).toLowerCase().includes(imlKeyword.toLowerCase())) && (imlSeverity === "all" || String(row.Severity || "").toLowerCase() === imlSeverity)).sort((left, right) => {
    const leftTime = Date.parse(String(left.Created || left.EventTimestamp || "")) || 0;
    const rightTime = Date.parse(String(right.Created || right.EventTimestamp || "")) || 0;
    return imlNewestFirst ? rightTime - leftTime : leftTime - rightTime;
  });
  const visibleBiosKeys = Object.keys(biosDraft).filter((key) => !biosSearch || `${key} ${jsonCell(biosDraft[key])}`.toLowerCase().includes(biosSearch.toLowerCase()));
  const biosMetadata = biosRaw?.AttributeMetadata && typeof biosRaw.AttributeMetadata === "object" && !Array.isArray(biosRaw.AttributeMetadata) ? biosRaw.AttributeMetadata as Record<string, JsonValue> : {};
  const selectedBiosMetadata = selectedBiosAttribute && biosMetadata[selectedBiosAttribute] && typeof biosMetadata[selectedBiosAttribute] === "object" && !Array.isArray(biosMetadata[selectedBiosAttribute]) ? biosMetadata[selectedBiosAttribute] as Record<string, JsonValue> : {};
  const biosAllowableValues = Array.isArray(selectedBiosMetadata.allowableValues) ? selectedBiosMetadata.allowableValues.filter((value): value is string => typeof value === "string") : [];
  const biosPatch = Object.fromEntries(Object.entries(biosDraft).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(biosRaw?.Attributes && typeof biosRaw.Attributes === "object" && !Array.isArray(biosRaw.Attributes) ? (biosRaw.Attributes as Record<string, JsonValue>)[key] : undefined)));
  const updateBiosValue = (value: JsonValue) => setBiosDraft((current) => ({ ...current, [selectedBiosAttribute]: value }));
  const exportBiosJson = () => downloadText(`${entry?.name || "rest"}-bios.json`, JSON.stringify(sanitizeJson({ overview: biosRaw, current: biosDraft, pending: biosCompare, exportedAt: new Date().toISOString() }), null, 2), "application/json");
  const biosType = String(selectedBiosMetadata.type || (typeof biosDraft[selectedBiosAttribute] === "boolean" ? "boolean" : typeof biosDraft[selectedBiosAttribute] === "number" ? "number" : "string"));
  const biosEditor = biosOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog rest-bios-dialog-v2" role="dialog" aria-modal="true" aria-labelledby="bios-title-v2"><div className="rest-editor-heading"><strong id="bios-title-v2">BIOS settings {biosRaw?.Version ? `· ${String(biosRaw.Version)}` : ""}</strong><button type="button" onClick={() => setBiosOpen(false)} aria-label="Close BIOS settings"><CloseIcon size={12} /></button></div><div className="rest-bios-toolbar"><input value={biosSearch} onChange={(event) => setBiosSearch(event.target.value)} placeholder="Search attributes" aria-label="BIOS attribute search" /><Dropdown label="Select BIOS attribute" value={selectedBiosAttribute} onChange={setSelectedBiosAttribute} placeholder="Select a BIOS item to edit" options={visibleBiosKeys.map((key) => ({ value: key, label: key }))} /><button type="button" onClick={() => void loadBios()}>Refresh</button><button type="button" onClick={exportBiosJson}>Export JSON</button><button type="button" onClick={() => void enterBiosSetup()}>Enter BIOS Setup</button></div>{selectedBiosAttribute ? <div className="rest-bios-editor-card"><h3>{selectedBiosAttribute}</h3><p>{String(selectedBiosMetadata.description || "Edit this BIOS attribute, then review the exact PATCH payload before applying.")}</p><div className="rest-bios-current"><span>Current: {jsonCell((biosRaw?.Attributes && typeof biosRaw.Attributes === "object" && !Array.isArray(biosRaw.Attributes) ? (biosRaw.Attributes as Record<string, JsonValue>)[selectedBiosAttribute] : undefined))}</span><span>Pending: {jsonCell(biosCompare?.[selectedBiosAttribute])}</span></div>{biosAllowableValues.length ? <Dropdown label={`${selectedBiosAttribute} value`} value={String(biosDraft[selectedBiosAttribute] ?? "")} onChange={updateBiosValue} options={biosAllowableValues.map((value) => ({ value, label: value }))} /> : biosType === "boolean" ? <label className="tls-option"><input type="checkbox" checked={Boolean(biosDraft[selectedBiosAttribute])} onChange={(event) => updateBiosValue(event.target.checked)} /> Enabled</label> : <input type={selectedBiosMetadata.format === "email" ? "email" : biosType === "number" ? "number" : "text"} value={String(biosDraft[selectedBiosAttribute] ?? "")} onChange={(event) => updateBiosValue(biosType === "number" ? Number(event.target.value) : event.target.value)} />}</div> : <p className="muted">Select a BIOS item from the list to see its meaning and edit control.</p>}<details><summary>Exact PATCH payload preview ({Object.keys(biosPatch).length} changed)</summary><pre className="rest-code">{JSON.stringify({ Attributes: biosPatch }, null, 2)}</pre></details><div className="modal-actions"><button type="button" className="confirm" onClick={() => void applyBios()} disabled={!Object.keys(biosPatch).length}>PATCH changed BIOS attributes</button></div>{biosMessage && <div className="notice">{biosMessage}</div>}</div></div>;
  const visibleFirmwareInventory = firmwareInventory.filter((item) => !firmwareFilter || JSON.stringify(item).toLowerCase().includes(firmwareFilter.toLowerCase()));
  const exportFirmwareJson = () => downloadText(`${entry?.name || "rest"}-firmware.json`, JSON.stringify(sanitizeJson({ inventory: firmwareInventory, raw: firmwareRaw }), null, 2), "application/json");
  const exportFirmwareCsv = () => {
    const rows = visibleFirmwareInventory.map((item) => {
      const status = item.Status && typeof item.Status === "object" && !Array.isArray(item.Status) ? (item.Status as Record<string, JsonValue>).Health : item.Status;
      return [item.Id, item.Name, item.Version, item.Location, item.Updateable, status].map((value) => csvCell(jsonCell(value))).join(",");
    });
    downloadText(`${entry?.name || "rest"}-firmware.csv`, ["Id,Name,Version,Location,Updateable,Health", ...rows].join("\n"), "text/csv;charset=utf-8");
  };
  const actionGroups = actions.reduce<Record<string, RedfishAction[]>>((groups, action) => {
    const value = `${action.name} ${action.title} ${action.target}`.toLowerCase();
    const group = /power|reset|boot/.test(value) ? "Power" : /bios|uefi/.test(value) ? "BIOS" : /firmware|update|flash/.test(value) ? "Firmware" : /log|clear/.test(value) ? "Logs" : "Other Actions";
    (groups[group] ||= []).push(action);
    return groups;
  }, {});

  return <><div className="rest-workspace">
    {imlOpen && (imlError || imlNotice) && <div className={`rest-iml-notification${imlError ? " error" : ""}`} role="alert"><strong>{imlError ? "IML monitor error" : "IML monitor"}</strong><span>{imlError || imlNotice}</span><button type="button" onClick={() => { setImlError(""); setImlNotice(""); }} aria-label="Dismiss IML notification"><CloseIcon size={12} /></button></div>}
     {biosEditor}
     {openBmcResourceOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog rest-openbmc-resource-dialog" role="dialog" aria-modal="true" aria-labelledby="openbmc-resource-title"><div className="rest-editor-heading"><strong id="openbmc-resource-title">OpenBMC resource</strong><button type="button" onClick={() => setOpenBmcResourceOpen(false)} aria-label="Close OpenBMC resource"><CloseIcon size={12} /></button></div><div className="rest-hardware-toolbar"><span>{openBmcResourceLoading ? "Loading resource..." : openBmcResourceTarget}</span><button type="button" onClick={() => void openBmcResource(openBmcResourceTarget)} disabled={openBmcResourceLoading}>Refresh</button></div><div className="rest-hardware-table-wrap"><table><thead><tr><th>Resource</th><th>Property</th><th>Value</th></tr></thead><tbody>{openBmcResourceRows.map((item, index) => <tr key={`${String(item.Property)}-${index}`}><td>{jsonCell(item.Resource)}</td><td>{jsonCell(item.Property)}</td><td>{tableCell(item.Value)}</td></tr>)}</tbody></table>{!openBmcResourceRows.length && !openBmcResourceLoading && <p className="muted">No resource values were returned.</p>}</div><details><summary>Raw Redfish resource</summary><pre className="rest-code">{openBmcResourceRaw ? JSON.stringify(openBmcResourceRaw, null, 2) : "(empty)"}</pre></details></div></div>}
     {openBmcInventoryOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog rest-openbmc-inventory-dialog" role="dialog" aria-modal="true" aria-labelledby="openbmc-inventory-title"><div className="rest-editor-heading"><strong id="openbmc-inventory-title">OpenBMC System inventory</strong><button type="button" onClick={() => setOpenBmcInventoryOpen(false)} aria-label="Close OpenBMC system inventory"><CloseIcon size={12} /></button></div><div className="rest-hardware-toolbar"><span>{openBmcInventoryLoading ? "Collecting Redfish inventory..." : `${openBmcInventoryRows.length} values`}</span><button type="button" onClick={() => void openBmcInventory()} disabled={openBmcInventoryLoading}>Refresh</button><button type="button" onClick={exportOpenBmcSpecCsv} disabled={openBmcInventoryLoading || !openBmcSpecRows.length}>Export CSV</button></div>{openBmcInventoryError && <div className="notice rest-error">{openBmcInventoryError}</div>}<div className="rest-hardware-table-wrap"><table><thead><tr><th>Resource</th><th>Property</th><th>Value</th></tr></thead><tbody>{openBmcInventoryRows.map((item, index) => <tr key={`${String(item.Resource)}-${String(item.Property)}-${index}`}><td>{jsonCell(item.Resource)}</td><td>{jsonCell(item.Property)}</td><td>{tableCell(item.Value)}</td></tr>)}</tbody></table>{!openBmcInventoryRows.length && !openBmcInventoryLoading && <p className="muted">No inventory values were returned.</p>}</div><details><summary>Collected Redfish snapshot</summary><pre className="rest-code">{JSON.stringify(openBmcInventorySnapshot, null, 2)}</pre></details></div></div>}
     {resourceCatalogOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog rest-resource-catalog" role="dialog" aria-modal="true" aria-labelledby="resource-catalog-title"><div className="rest-editor-heading"><strong id="resource-catalog-title">All Resources</strong><button type="button" onClick={() => setResourceCatalogOpen(false)} aria-label="Close resource catalog"><CloseIcon size={12} /></button></div><p className="muted">Redfish resources advertised by the service root. Select a path to open it.</p><div className="rest-resource-catalog-list">{resourceCatalog.map((resource) => <button type="button" key={`${resource.name}-${resource.target}`} onClick={() => { setResourceCatalogOpen(false); void openPath(resource.target); }}><strong>{resource.name}</strong><code>{resource.target}</code></button>)}</div></div></div>}
     <div className={`rest-entry-pane-shell${entryPaneCollapsed ? " rest-entry-pane-collapsed" : ""}`} style={{ flexBasis: `${entryPaneWidth}px` }}><RestEntries entries={props.entries} activeEntryId={entry?.id || ""} onSelectEntry={props.onSelectEntry} /></div>
     {props.collapseMainPaneEnabled ? <div className="rest-main-pane-collapse-controls" role="group" aria-label="REST pane visibility"><button type="button" onClick={() => setEntryPaneCollapsed(true)} disabled={entryPaneCollapsed} aria-label="Collapse REST entry pane"><ChevronLeftIcon /></button><button type="button" onClick={() => setEntryPaneCollapsed(false)} disabled={!entryPaneCollapsed} aria-label="Restore REST entry pane"><ChevronRightIcon /></button></div> : <PaneResizeHandle ariaLabel="Resize REST API entries pane" onStart={beginEntryPaneResize} onMove={(event) => resizeEntryPane(event.nativeEvent)} onEnd={stopEntryPaneResize} />}
     {toolbarHost && createPortal(<nav className="rest-toolbar" data-rest-toolbar="true" aria-label="REST API tools">
          <button type="button" className="rest-toolbar-toggle" onClick={() => setToolsOpen((value) => !value)} aria-expanded={toolsOpen}>
            Tools
          </button>
          <button type="button" className="rest-toolbar-toggle" onClick={() => setHistoryOpen((value) => !value)} aria-expanded={historyOpen} disabled={!currentHistory.length}>
            History
          </button>
          <button type="button" className="rest-toolbar-toggle" onClick={() => setRawRequestOpen((value) => !value)} aria-expanded={rawRequestOpen}>
            Raw Request
          </button>
          {vendor === "hpe" && toolsOpen && <div className="rest-toolbar-panel" role="group" aria-label="HPE Tools">
            <button type="button" onClick={() => void loadAllHardware()}>All hardware inventory</button>
            <button type="button" onClick={() => void openAllResources()}>All Resources</button>
            <button type="button" onClick={() => void discoverPower()}>Power controls</button>
            <button type="button" onClick={() => void loadBios()}>BIOS settings</button>
            <button type="button" onClick={() => void loadFirmware()}>Firmware update</button>
            <button type="button" onClick={() => void resetLogs()}>Clear logs / reset</button>
            <button type="button" onClick={() => void openDevices()}>Devices table</button>
            <button type="button" onClick={() => { setImlOpen(true); void fetchIml(); }}>IML monitor</button>
          </div>}
          {vendor === "openbmc" && toolsOpen && <div className="rest-toolbar-panel" role="group" aria-label="OpenBMC Tools">
            <button type="button" onClick={() => void discoverOpenBmc()}>Discover capabilities</button>
            <button type="button" onClick={() => void openBmcInventory()}>System inventory</button>
             <button type="button" onClick={() => void openBmcResource(openBmcCapabilities.Chassis || "/redfish/v1/Chassis")}>Chassis inventory</button>
            <button type="button" onClick={() => void runOpenBmcPower("On")}>Power On</button>
            <button type="button" onClick={() => void runOpenBmcPower("GracefulShutdown")}>Graceful Shutdown</button>
            <button type="button" onClick={() => void runOpenBmcPower("ForceOff")}>Force Off</button>
          </div>}
        </nav>, toolbarHost)}
     <section className="rest-reader" aria-label="REST API reader" data-raw-request-open={rawRequestOpen}>
         <div className="rest-reader-heading"><div><span className="eyebrow">REST API mode · {props.workspaceName}</span><h1>{entry?.name || "REST API reader"}</h1></div><div className="rest-reader-tools"><MobileChoiceMenu className="rest-vendor-choice" label="REST toolbar" currentId={vendor} options={[{ id: "hpe", label: "HPE" }, { id: "openbmc", label: "OpenBMC" }]} onSelect={(id) => launchVendor(id as RestVendor)} /><div className="rest-vendor-capsule" role="group" aria-label="REST toolbar vendor"><button type="button" className={vendor === "hpe" ? "selected" : ""} onClick={() => launchVendor("hpe")}>HPE</button><button type="button" className={vendor === "openbmc" ? "selected" : ""} onClick={() => launchVendor("openbmc")}>OpenBMC</button></div><span className="rest-session-status">{entry && (session["X-Auth-Token"] || secret.cookie) ? "Authenticated" : "Not authenticated"}</span></div></div>
      {entry && <>
        <section className={`rest-auth-panel${authOpen ? " open" : ""}`}>
             <div className="rest-section-toggle"><button type="button" onClick={() => { if (authOpen) { setSessionHelpOpen(false); setTokenPathHelpOpen(false); } setAuthOpen((value) => !value); }} aria-label={`${authOpen ? "Collapse" : "Expand"} Authentication`} title={`${authOpen ? "Collapse" : "Expand"} Authentication`}><span>Authentication</span><span aria-hidden="true">{authOpen ? "−" : "+"}</span></button></div>
          {authOpen && <div className="rest-auth-fields">
            <label>Mode<Dropdown label="Mode" value={entry.authMode} onChange={(value) => changeAuthMode(value as RestAuthMode)} options={Object.entries(authLabels).map(([value, label]) => ({ value, label }))} /></label>
            {(entry.authMode === "basic" || entry.authMode === "login") && <label>Username<input value={entry.username} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, username: event.target.value } : item))} /></label>}
            {(entry.authMode === "basic" || entry.authMode === "login") && <label>Password<input type="password" value={secret.password || ""} onChange={(event) => updateSecret({ password: event.target.value })} /></label>}
            {entry.authMode === "bearer" && <label>Bearer token<input type="password" value={secret.token || ""} onChange={(event) => updateSecret({ token: event.target.value })} /></label>}
            {entry.authMode === "api-key" && <label>API key<input type="password" value={secret.apiKey || ""} onChange={(event) => updateSecret({ apiKey: event.target.value })} /></label>}
            {entry.authMode === "cookie" && <label>Cookie header<input value={secret.cookie || ""} onChange={(event) => updateSecret({ cookie: event.target.value })} placeholder="session=..." /></label>}
            {entry.authMode !== "login" && <div className="rest-auth-action"><button type="button" className="confirm" onClick={() => void authenticate()} disabled={loading}>{loading ? "Logging in..." : "Login"}</button></div>}
            {entry.authMode === "login" && <div className="rest-vendor-bar"><button type="button" className="confirm rest-login-button" onClick={() => void (isSessionAuthenticated ? logout() : login())} disabled={loading}>{loading ? (isSessionAuthenticated ? "Logging out..." : "Logging in...") : (isSessionAuthenticated ? "Logout" : "Login")}</button></div>}
            {entry.authMode === "login" && <div className="rest-login-config"><label>Login path<input value={entry.loginPath} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, loginPath: event.target.value } : item))} /></label><label>Token JSON path<input value={entry.tokenPath} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, tokenPath: event.target.value } : item))} /></label><label>Token header<input value={entry.tokenHeader} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, tokenHeader: event.target.value } : item))} /></label><label>Login body<textarea value={entry.loginBody} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, loginBody: event.target.value } : item))} /></label></div>}
             </div>}
           {authOpen && entry.authMode === "login" && <div className="token-path-help" style={tokenPathHelpPosition}><span>Token JSON Path</span><button ref={tokenPathHelpButtonRef} type="button" className="token-path-help-button" onClick={() => setTokenPathHelpOpen((value) => !value)} aria-label="What is Token JSON Path" aria-expanded={tokenPathHelpOpen}>?</button>{tokenPathHelpOpen && createPortal(<div className="token-path-help-popup" role="note" style={tokenPathHelpPopupStyle} onClick={(event) => event.stopPropagation()}><button type="button" className="token-path-help-close" onClick={() => setTokenPathHelpOpen(false)} aria-label="Close Token JSON Path help"><CloseIcon size={12} /></button><strong>Token JSON Path</strong><p>Use this only when the login response returns the token inside a JSON response body.</p><pre>{'{\n  "data": {\n    "token": "abc123"\n  }\n}'}</pre><p>Enter <code>data.token</code>. For HPE iLO and OpenBMC Redfish SessionService, leave this empty when the token is returned in the <code>X-Auth-Token</code> response header.</p></div>, document.body)}</div>}
         </section>
         <div className="rest-url-row"><Dropdown label="HTTP method" value={method} onChange={(value) => setMethod(value as RestMethod)} options={[{ value: "GET", label: "GET" }, { value: "POST", label: "POST" }, { value: "PATCH", label: "PATCH" }, { value: "DELETE", label: "DELETE" }]} /><input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void execute(); }} aria-label="REST request URL" /><button type="button" className="primary" onClick={() => void execute()} disabled={loading}>{loading ? "Sending..." : method}</button></div>
        {method !== "GET" && method !== "DELETE" && <label className="rest-body-editor">JSON request body<textarea value={bodyDraft} onChange={(event) => setBodyDraft(event.target.value)} spellCheck={false} /></label>}
        <div className="rest-query-editor"><span>Query parameters</span>{entry.query.map((item, index) => <div className="rest-query-row" key={`${entry.id}-query-${index}`}><input value={item.name} placeholder="name" onChange={(event) => updateQuery(entry.query.map((current, currentIndex) => currentIndex === index ? { ...current, name: event.target.value } : current))} /><input value={item.value} placeholder="value" onChange={(event) => updateQuery(entry.query.map((current, currentIndex) => currentIndex === index ? { ...current, value: event.target.value } : current))} /><button type="button" onClick={() => updateQuery(entry.query.filter((_, currentIndex) => currentIndex !== index))} aria-label="Remove query parameter"><CloseIcon size={12} /></button></div>)}<button type="button" className="rest-query-add" onClick={() => updateQuery([...entry.query, { name: "", value: "" }])}>+ Add parameter</button></div>
        {!!currentHistory.length && <section className="rest-history"><button type="button" className="rest-history-toggle" onClick={() => setHistoryOpen((value) => !value)}><span>Recent GET paths</span><span>{historyOpen ? "−" : "+"}</span></button>{historyOpen && <div className="rest-history-list">{currentHistory.map((item) => <button type="button" className="rest-history-item" key={`${item.url}-${item.timestamp}`} onClick={() => void openPath(item.url)}><span>{item.url}</span><small>{new Date(item.timestamp).toLocaleTimeString()}</small></button>)}<button type="button" className="rest-history-clear" onClick={() => setHistory((current) => ({ ...current, [entry.id]: [] }))}>Clear history</button></div>}</section>}
          <div className="rest-breadcrumbs" aria-label="REST path">{crumbs.map((crumb) => <React.Fragment key={crumb.value}><button type="button" onClick={() => void openPath(crumb.value)}>{crumb.label}</button>{crumb.value !== crumbs[crumbs.length - 1].value && <span><ChevronRightIcon size={11} /></span>}</React.Fragment>)}</div>
          {entry.ignoreTlsErrors && <div className="notice rest-warning">TLS certificate verification is disabled for this REST entry.</div>}
          {message && <div className="notice rest-success">{message}</div>}
           {error && <div className="notice rest-error">{error}{response?.status === 401 || response?.status === 403 ? <button type="button" onClick={() => void login()}>Re-login</button> : null}</div>}
           {!!auditItems.length && <section className="rest-audit-panel"><div className="rest-audit-heading"><strong>REST operation audit</strong><span>{auditItems.length} recent requests</span></div><div className="rest-audit-list">{auditItems.map((item) => <details key={item.id}><summary><span>{new Date(item.timestamp).toLocaleTimeString()}</span><strong>{item.method}</strong><span className={item.status !== null && item.status >= 400 || item.error ? "rest-status-error" : "rest-status-ok"}>{item.status ?? "ERR"}</span><span>{item.durationMs}ms</span><code>{item.url}</code></summary><div className="rest-audit-detail"><div><strong>Target</strong><code>{item.url}</code></div><div><strong>Sanitized payload</strong><pre className="rest-code">{item.body || "(empty)"}</pre></div>{item.error && <div className="notice rest-error">{item.error}</div>}</div></details>)}</div></section>}
            {!!links.length && <section className="rest-links"><div className="rest-links-heading"><strong>Resource links</strong><span>{links.length}</span></div>{links.map((link) => <button type="button" className="rest-link-button" key={`${link.name}-${link.target}`} onClick={() => void (link.kind === "download" ? downloadResource(link.target) : openResource(link.target))}><span>{link.name}</span><small>{link.kind === "download" ? "download" : "GET"}</small><code>{link.target}</code></button>)}</section>}
          {!!actions.length && <section className="rest-actions rest-toolbox"><button type="button" className="rest-actions-toggle" onClick={() => setActionsOpen((value) => !value)} aria-expanded={actionsOpen} aria-controls="rest-actions-list"><span className="rest-actions-heading"><strong>Redfish Toolbox</strong><span>{actions.length} tools</span></span><span className="rest-actions-chevron" aria-hidden="true">{actionsOpen ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}</span></button>{actionsOpen && <div id="rest-actions-list" className="rest-toolbox-groups">{Object.entries(actionGroups).map(([group, groupActions]) => <section className="rest-toolbox-group" key={group}><h3>{group}<span>{groupActions.length}</span></h3><div className="rest-actions-list">{groupActions.map((action) => <button type="button" className="rest-action-button" key={`${action.name}-${action.target}`} onClick={() => void openAction(action)}><span>{action.title}</span><small>{action.target}</small></button>)}</div></section>)}</div>}</section>}
          {actionOpen && selectedAction && <div className="rest-action-dialog"><div className="rest-action-dialog-heading"><strong>{selectedAction.title}</strong><button type="button" onClick={() => setActionOpen(false)} aria-label="Close action"><CloseIcon size={12} /></button></div><p>This Redfish action sends a POST request and may change power, BIOS, reset, or other server state.</p>{actionInfo && <details open><summary>Advertised ActionInfo parameters</summary><pre className="rest-code">{JSON.stringify(actionInfo, null, 2)}</pre></details>}{Object.keys(actionForm).map((name) => { const value = actionForm[name]; const parameter = actionInfo && typeof actionInfo === "object" && !Array.isArray(actionInfo) && Array.isArray(actionInfo.Parameters) ? actionInfo.Parameters.find((item) => item && typeof item === "object" && !Array.isArray(item) && item.Name === name) : null; const allowable = parameter && typeof parameter === "object" && !Array.isArray(parameter) && Array.isArray(parameter.AllowableValues) ? parameter.AllowableValues : []; return <label key={name}>{name}{allowable.length ? <Dropdown label={name} value={String(value)} onChange={(next) => updateActionParameter(name, next)} options={allowable.map((option) => ({ value: String(option), label: String(option) }))} /> : <input value={String(value)} onChange={(event) => updateActionParameter(name, event.target.value)} />}</label>; })}<label>JSON body<textarea value={actionBody} onChange={(event) => setActionBody(event.target.value)} spellCheck={false} /></label><div className="modal-actions"><button type="button" onClick={() => setActionOpen(false)}>Cancel</button><button type="button" className="danger" onClick={() => void executeAction()} disabled={loading}>{loading ? "Sending..." : "Run action"}</button></div></div>}
          {response && <div className="rest-response-resize-handle" role="separator" aria-label="Resize response panel" onMouseDown={beginResponseResize} tabIndex={0} />}
        {response && <section className="rest-response"><div className="rest-response-heading"><strong>Response</strong><span className={response.status >= 400 ? "rest-status-error" : "rest-status-ok"}>{response.status}</span><span>{response.headers?.find(([name]) => name.toLowerCase() === "content-type")?.[1] || "unknown content type"}</span><span>{response.body.length} bytes</span></div><div className="rest-view-tabs"><button type="button" className={view === "pretty" ? "active" : ""} onClick={() => setView("pretty")}>Pretty</button><button type="button" className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>Raw</button><button type="button" className={view === "headers" ? "active" : ""} onClick={() => setView("headers")}>Headers</button></div>{view === "headers" ? <div className="rest-headers">{(response.headers || []).map(([name, value], index) => <div key={`${name}-${index}`}><strong>{name}</strong><span>{name.toLowerCase().includes("authorization") || name.toLowerCase().includes("cookie") || name.toLowerCase().includes("token") ? "••••••••" : value}</span></div>)}</div> : view === "raw" || !json ? <pre className="rest-code">{responseText || "(empty response)"}</pre> : <div className="rest-json-view">{rows.length ? rows.map(([name, value]) => { const resourceLink = value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)["@odata.id"] === "string" ? String((value as Record<string, unknown>)["@odata.id"]) : ""; const href = value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).href === "string" ? String((value as Record<string, unknown>).href) : ""; const link = resourceLink || href; const target = link || `${normalizePath(path)}/${encodeURIComponent(name)}`; const isLink = Boolean(link); return <button type="button" className="rest-json-row" key={name} onClick={() => value && typeof value === "object" ? void openPath(target) : undefined}><span>{responseEntryName(value, name)}</span><small>{isLink ? "link" : Array.isArray(value) ? "array" : value && typeof value === "object" ? "object" : typeof value}</small><code>{isLink ? link : typeof value === "object" ? "[Open]" : String(value)}</code></button>; }) : <pre className="rest-code">{prettyJson(json)}</pre>}</div>}</section>}
          {devicesOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog" role="dialog" aria-modal="true" aria-labelledby="rest-devices-title"><div className="rest-editor-heading"><strong id="rest-devices-title">HPE Devices</strong><button type="button" onClick={() => setDevicesOpen(false)} aria-label="Close devices table"><CloseIcon size={12} /></button></div><div className="rest-hardware-table-wrap"><table><thead><tr><th>Name</th><th>Location</th><th>Status</th><th>Firmware</th></tr></thead><tbody>{deviceRows.map((device, index) => <tr key={`${String(device.Id || device.Name || "device")}-${index}`}><td>{String(device.Name || device.Id || "Unknown")}</td><td>{String(device.Location || "-")}</td><td>{typeof device.Status === "object" && device.Status && !Array.isArray(device.Status) ? String((device.Status as { [key: string]: JsonValue }).Health || (device.Status as { [key: string]: JsonValue }).State || "-") : String(device.Status || "-")}</td><td>{String(device.FirmwareVersion || device.Version || "-")}</td></tr>)}</tbody></table>{!deviceRows.length && <p className="muted">The resource returned no device members.</p>}</div></div></div>}
          {hardwareOpen && hardwareTool && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog" role="dialog" aria-modal="true" aria-labelledby="hardware-title"><div className="rest-editor-heading"><strong id="hardware-title">{hardwareTool.label}</strong><button type="button" onClick={() => setHardwareOpen(false)} aria-label="Close hardware inventory"><CloseIcon size={12} /></button></div><div className="rest-hardware-toolbar"><span>{hardwareLoading ? "Refreshing..." : hardwareError || `${hardwareRows.length} rows · ${hardwareUpdatedAt ? new Date(hardwareUpdatedAt).toLocaleString() : "not loaded"}${hardwareDurationMs === null ? "" : ` · ${hardwareDurationMs}ms`}`}</span><button type="button" onClick={() => void loadHardware(hardwareTool)} disabled={hardwareLoading}>Refresh</button><button type="button" onClick={exportHardwareJson} disabled={hardwareLoading}>JSON</button><button type="button" onClick={exportHardwareCsv} disabled={hardwareLoading}>CSV</button></div>{hardwareError ? <div className="notice rest-error">{hardwareError}</div> : <div className="rest-hardware-table-wrap"><table><thead><tr>{hardwareTool.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{hardwareRows.map((row, index) => <tr key={`${hardwareTool.id}-${index}`}>{hardwareTool.columns.map((column) => <td key={column}>{tableCell(row[column])}</td>)}</tr>)}</tbody></table>{!hardwareRows.length && !hardwareLoading && <p className="muted">No inventory members were returned.</p>}</div>}<details><summary>Raw Redfish resource</summary><pre className="rest-code">{hardwareRaw ? JSON.stringify(hardwareRaw, null, 2) : "(empty)"}</pre></details></div></div>}
          {imlOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog rest-iml-dialog" role="dialog" aria-modal="true" aria-labelledby="iml-title"><div className="rest-editor-heading"><strong id="iml-title">Integrated Management Log</strong><button type="button" onClick={() => { stopImlPolling("close"); setImlOpen(false); }} aria-label="Close IML"><CloseIcon size={12} /></button></div><div className="rest-iml-controls"><input value={imlKeyword} onChange={(event) => setImlKeyword(event.target.value)} placeholder="Keyword" aria-label="IML keyword" /><Dropdown label="IML severity" value={imlSeverity} onChange={setImlSeverity} options={[{ value: "all", label: "All severity" }, { value: "critical", label: "Critical" }, { value: "warning", label: "Warning" }, { value: "ok", label: "OK" }]} /><Dropdown label="IML polling interval" value={String(imlInterval)} onChange={(value) => setImlInterval(Number(value))} options={[{ value: "3000", label: "3 seconds" }, { value: "5000", label: "5 seconds" }, { value: "10000", label: "10 seconds" }]} /><button type="button" onClick={() => void fetchIml()}>Refresh</button><span className="muted">Status: {imlState}{imlRetryCount ? ` · retry ${imlRetryCount}` : ""}{imlNextRetryAt ? ` · next retry ${new Date(imlNextRetryAt).toLocaleTimeString()}` : ""}{imlLastFetchAt ? ` · last fetch ${new Date(imlLastFetchAt).toLocaleTimeString()}` : ""}</span><button type="button" onClick={imlPolling ? () => stopImlPolling() : startImlPolling}>{imlPolling ? "Stop" : "Start"}</button><button type="button" onClick={() => setImlNewestFirst((value) => !value)}>{imlNewestFirst ? "Newest" : "Oldest"}</button>{imlManualStopped && <button type="button" onClick={() => void downloadAhs()} disabled={!ahsTarget || loading}>{loading ? "Downloading AHS..." : "Download complete AHS log"}</button>}<span className={imlCsvError ? "rest-status-error" : "muted"}>CSV: {imlCsvError || imlCsvPathRef.current || "created when Start completes discovery"}</span></div>{ahsMessage && <div className="notice">{ahsMessage}</div>}<div className="rest-iml-terminal" aria-label="IML live terminal">{visibleImlRows.map((row, index) => <div key={`${String(row["@odata.id"] || row.Id || index)}-${index}`}><span>{String(row.Created || row.EventTimestamp || "-")}</span> <b>{String(row.Severity || "UNKNOWN")}</b> {String(row.Message || row.MessageId || "-")}</div>)}</div></div></div>}
          {powerOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog rest-power-dialog" role="dialog" aria-modal="true" aria-labelledby="power-title"><div className="rest-editor-heading"><strong id="power-title">Power control</strong><button type="button" onClick={() => setPowerOpen(false)} aria-label="Close power controls"><CloseIcon size={12} /></button></div><p>Current PowerState: <strong>{powerState}</strong></p><div className="rest-operation-body"><button type="button" onClick={() => void runPowerAction("On")} disabled={powerBusy || Boolean(powerResetTypes.length && !powerResetTypes.includes("On"))}>On</button><button type="button" onClick={() => void runPowerAction("Off")} disabled={powerBusy || Boolean(powerResetTypes.length && !powerResetTypes.includes("GracefulShutdown"))}>Off</button><button type="button" onClick={() => void runPowerAction("ForceOff")} disabled={powerBusy || Boolean(powerResetTypes.length && !powerResetTypes.includes("ForceOff"))}>Force Off</button><button type="button" onClick={() => void runPowerAction("Reset")} disabled={powerBusy || !powerActions.length}>Reset</button>{powerButtonTypes.includes("Press") && <button type="button" onClick={() => void pressPowerButton("Press")} disabled={powerBusy}>Push Power Button</button>}{powerButtonTypes.includes("PressAndHold") && <button type="button" onClick={() => void pressPowerButton("PressAndHold")} disabled={powerBusy}>Press and Hold</button>}<button type="button" onClick={() => void discoverPower()} disabled={powerBusy}>Refresh capabilities</button></div>{powerMessage && <div className="notice">{powerMessage}</div>}<details><summary>Advertised reset and HPE PowerButton capabilities</summary><pre className="rest-code">{JSON.stringify({ powerActions, resetTarget: powerResetTarget, resetTypes: powerResetTypes, powerButtonTarget, pushTypes: powerButtonTypes, lastRequest: powerLastRequest }, null, 2)}</pre></details></div></div>}
          {biosOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog rest-bios-dialog" role="dialog" aria-modal="true" aria-labelledby="bios-title"><div className="rest-editor-heading"><strong id="bios-title">BIOS settings {biosRaw?.Version ? `· ${String(biosRaw.Version)}` : ""}</strong><button type="button" onClick={() => setBiosOpen(false)} aria-label="Close BIOS settings"><CloseIcon size={12} /></button></div><div className="rest-bios-toolbar"><input value={biosSearch} onChange={(event) => setBiosSearch(event.target.value)} placeholder="Search attribute or value" aria-label="BIOS attribute search" /><button type="button" onClick={() => void loadBios()}>Refresh</button><button type="button" onClick={() => downloadText(`${entry?.name || "rest"}-bios.json`, JSON.stringify(biosRaw, null, 2), "application/json")}>Export JSON</button><button type="button" onClick={() => void enterBiosSetup()}>Enter BIOS Setup</button></div><div className="rest-bios-grid">{visibleBiosKeys.map((key) => { const value = biosDraft[key]; const pending = biosCompare?.[key]; const changed = pending !== undefined && JSON.stringify(pending) !== JSON.stringify(value); const update = (next: JsonValue) => setBiosDraft((current) => ({ ...current, [key]: next })); return <label key={key}><span>{key}{changed ? " · changed" : ""}</span>{typeof value === "boolean" ? <input type="checkbox" checked={value} onChange={(event) => update(event.target.checked)} /> : typeof value === "number" ? <input type="number" value={value} onChange={(event) => update(Number(event.target.value))} /> : <input value={jsonCell(value)} onChange={(event) => update(event.target.value)} />}</label>; })}</div><details><summary>Exact PATCH payload preview</summary><pre className="rest-code">{JSON.stringify({ Attributes: biosDraft }, null, 2)}</pre></details><div className="modal-actions"><button type="button" className="confirm" onClick={() => void applyBios()}>Apply BIOS PATCH</button></div>{biosMessage && <div className="notice">{biosMessage}</div>}<p className="muted">Pending changes are compared with current values; BIOS PATCH responses may require reboot or reset.</p></div></div>}
          {firmwareOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog" role="dialog" aria-modal="true" aria-labelledby="firmware-title"><div className="rest-editor-heading"><strong id="firmware-title">Firmware update</strong><button type="button" onClick={() => setFirmwareOpen(false)} aria-label="Close firmware"><CloseIcon size={12} /></button></div><div className="rest-hardware-toolbar"><input value={firmwareFilter} onChange={(event) => setFirmwareFilter(event.target.value)} placeholder="Search firmware inventory" aria-label="Firmware inventory filter" /><span>{visibleFirmwareInventory.length}/{firmwareInventory.length} inventory items</span><button type="button" onClick={() => void loadFirmware()}>Refresh inventory</button><button type="button" onClick={exportFirmwareJson}>JSON</button><button type="button" onClick={exportFirmwareCsv}>CSV</button></div><div className="rest-hardware-table-wrap"><table><thead><tr><th>Component</th><th>Version</th><th>Location</th><th>Updateable</th><th>Status</th></tr></thead><tbody>{visibleFirmwareInventory.map((item, index) => <tr key={String(item.Id || index)}><td>{jsonCell(item.Name)}</td><td>{jsonCell(item.Version)}</td><td>{jsonCell(item.Location)}</td><td>{jsonCell(item.Updateable)}</td><td>{tableCell(item.Status)}</td></tr>)}</tbody></table>{!visibleFirmwareInventory.length && <p className="muted">No matching firmware inventory items.</p>}</div><details><summary>Raw FirmwareInventory response</summary><pre className="rest-code">{firmwareRaw ? JSON.stringify(firmwareRaw, null, 2) : "(empty)"}</pre></details><label>Firmware URI<input value={firmwareUri} onChange={(event) => setFirmwareUri(event.target.value)} placeholder="https://updates.example.test/ilo.bin" /></label>{firmwareSupportsTarget && <label>Update target<Dropdown label="Update target" value={firmwareTarget} onChange={setFirmwareTarget} placeholder="Service default" options={firmwareInventory.filter((item) => typeof item["@odata.id"] === "string").map((item) => ({ value: String(item["@odata.id"]), label: String(item.Name || item.Id || item["@odata.id"]) }))} /></label>}{firmwareSupportsTpm && <label className="tls-option"><input type="checkbox" checked={firmwareTpmOverride} onChange={(event) => setFirmwareTpmOverride(event.target.checked)} /> TPM override</label>}{firmwareSupportsRepository && <label>Update repository<input value={firmwareUpdateRepository} onChange={(event) => setFirmwareUpdateRepository(event.target.value)} placeholder="Repository name or URI" /></label>}<p className="muted">Endpoint: {firmwareAction || "No advertised SimpleUpdate/AddFromUri action"}</p><div className="modal-actions"><button type="button" className="danger" onClick={() => void startFirmware()} disabled={!firmwareAction}>Build payload preview</button></div>{firmwareMessage && <div className="notice">{firmwareMessage}</div>}{firmwarePreview && <div className="firmware-preview"><strong>Exact POST preview</strong><p><strong>{String(firmwarePreview.method)}</strong> {String(firmwarePreview.endpoint)}</p><pre className="rest-code">{JSON.stringify(firmwarePreview.payload, null, 2)}</pre><div className="modal-actions"><button type="button" onClick={() => setFirmwarePreview(null)}>Cancel</button><button type="button" className="danger" onClick={() => void applyFirmware()}>Confirm and POST</button></div></div>}</div></div>}
          {resetOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-title"><div className="rest-editor-heading"><strong id="reset-title">Clear logs and reset</strong><button type="button" onClick={() => setResetOpen(false)} aria-label="Close reset workflow"><CloseIcon size={12} /></button></div><ol className="rest-reset-steps">{resetSteps.map((step) => <li key={step.name}><strong>{step.name}</strong><span>{step.status}</span></li>)}</ol>{resetMessage && <div className="notice">{resetMessage}</div>}</div></div>}
          {hardwareSummaryOpen && <div className="floating-dialog-layer" role="presentation"><div className="rest-hardware-dialog rest-hardware-summary-dialog" role="dialog" aria-modal="true" aria-labelledby="hardware-summary-title"><div className="rest-editor-heading"><strong id="hardware-summary-title">All hardware inventory</strong><button type="button" onClick={() => setHardwareSummaryOpen(false)} aria-label="Close all hardware inventory"><CloseIcon size={12} /></button></div><div className="rest-hardware-toolbar"><span>{hardwareLoading ? "Collecting hardware..." : `${hardwareRows.length} rows · ${hardwareUpdatedAt ? new Date(hardwareUpdatedAt).toLocaleString() : "-"}${hardwareDurationMs === null ? "" : ` · ${hardwareDurationMs}ms`}`}</span><button type="button" onClick={() => void loadAllHardware()} disabled={hardwareLoading}>Refresh all</button><button type="button" onClick={exportHardwareJson} disabled={hardwareLoading}>JSON</button><button type="button" onClick={exportHardwareCsv} disabled={hardwareLoading}>CSV</button></div>{hardwareError && <div className="notice rest-error">{hardwareError}</div>}<div className="hardware-summary-tables">{hardwareSummaryGroups.map(({ tool, rows }) => <section className="hardware-summary-table" key={tool.id}><h3>{tool.label}<span>{rows.length}</span></h3><div className="rest-hardware-table-wrap"><table><thead><tr>{tool.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${tool.id}-${index}`}>{tool.columns.map((column) => <td key={column}>{tableCell(row[column])}</td>)}</tr>)}</tbody></table>{!rows.length && <p className="muted">-</p>}</div></section>)}</div></div></div>}
       </>}
      {!entry && <div className="rest-reader-empty"><strong>Choose a REST API entry</strong><span>Create an entry on the left to start a request.</span></div>}
    </section>
  </div></>;
}
