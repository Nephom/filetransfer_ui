import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type RestAuthMode = "none" | "basic" | "bearer" | "api-key" | "cookie" | "login";
export type RestMethod = "GET" | "POST" | "PATCH";
export type RestVendor = "hpe" | "openbmc";

export type RestApiEntry = {
  id: string;
  name: string;
  baseUrl: string;
  defaultPath: string;
  query: { name: string; value: string }[];
  ignoreTlsErrors: boolean;
  authMode: RestAuthMode;
  vendor: RestVendor;
  username: string;
  loginPath: string;
  loginMethod: "POST" | "PATCH";
  loginBody: string;
  tokenPath: string;
  tokenHeader: string;
  tokenSendAs: string;
};

export type RestApiSecret = {
  username?: string;
  password?: string;
  token?: string;
  apiKey?: string;
  cookie?: string;
};

type NativeApiResponse = {
  status: number;
  body: number[];
  headers?: [string, string][];
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type RestHistoryItem = { url: string; timestamp: number };

type Props = {
  workspaceName: string;
  entries: RestApiEntry[];
  activeEntryId: string;
  secrets: Record<string, RestApiSecret>;
  sessionHeaders: Record<string, string>;
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
  hpe: {
    label: "HPE",
    referenceJson: '{\n  "UserName": "{{username}}",\n  "Password": "{{password}}"\n}',
    loginPath: "/redfish/v1/SessionService/Sessions",
    loginBody: '{"UserName":"{{username}}","Password":"{{password}}"}',
  },
  openbmc: {
    label: "OpenBMC",
    referenceJson: '{\n  "UserName": "{{username}}",\n  "Password": "{{password}}"\n}\n\n# OpenBMC also documents the legacy /login flow:\n{\n  "username": "{{username}}",\n  "password": "{{password}}"\n}',
    loginPath: "/redfish/v1/SessionService/Sessions",
    loginBody: '{"UserName":"{{username}}","Password":"{{password}}"}',
  },
};

const normalizePath = (value: string) => {
  const path = value.trim() || "/";
  return path.startsWith("/") ? path : `/${path}`;
};

const joinUrl = (baseUrl: string, path: string) => {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return `${base}${normalizePath(path)}`;
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

const extractCookies = (headers: [string, string][] = []) => headers
  .filter(([name]) => name.toLowerCase() === "set-cookie")
  .map(([, value]) => value.split(";", 1)[0])
  .filter(Boolean)
  .join("; ");

const responseEntryName = (value: unknown, fallback: string) => {
  return fallback;
};

type RedfishAction = { name: string; target: string; title: string };
type RedfishLink = { name: string; target: string; kind: "resource" | "download" };

const collectRedfishActions = (value: unknown, parent = ""): RedfishAction[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectRedfishActions(item, `${parent}[${index}]`));
  const actions: RedfishAction[] = [];
  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const target = (child as Record<string, unknown>).target;
      if (typeof target === "string" && (parent === "Actions" || key.startsWith("#"))) {
        actions.push({ name: key, target, title: typeof (child as Record<string, unknown>).title === "string" ? String((child as Record<string, unknown>).title) : key.replace(/^#/, "") });
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

function RestEntries({ entries, activeEntryId, onSelectEntry, onChangeEntries }: Pick<Props, "entries" | "activeEntryId" | "onSelectEntry" | "onChangeEntries">) {
  const [editing, setEditing] = useState<RestApiEntry | null>(null);

  const createEntry = () => setEditing({
    id: crypto.randomUUID(),
    name: "New REST API",
    baseUrl: "http://127.0.0.1:8787",
    defaultPath: "/v1/rest",
    query: [],
    ignoreTlsErrors: false,
    authMode: "none",
    vendor: "hpe",
    username: "",
    loginPath: "/auth/login",
    loginMethod: "POST",
    loginBody: '{"username":"{{username}}","password":"{{password}}"}',
    tokenPath: "data.token",
    tokenHeader: "X-Auth-Token",
    tokenSendAs: "X-Auth-Token",
  });

  const save = () => {
    const draft = editing;
    if (!draft || !draft.name.trim() || !draft.baseUrl.trim()) return;
    onChangeEntries(entries.some((entry) => entry.id === draft.id)
      ? entries.map((entry) => entry.id === draft.id ? draft : entry)
      : [...entries, draft]);
    onSelectEntry(draft.id);
    setEditing(null);
  };

  return <aside className="rest-entry-pane">
    <div className="rest-entry-heading">
      <span className="sidebar-label">REST API ENTRIES</span>
      <button type="button" className="confirm rest-add-button" onClick={createEntry}>+ Add entry</button>
    </div>
    <div className="rest-entry-list">
      {!entries.length && <div className="rest-empty">No REST API entries yet.</div>}
      {entries.map((entry) => <button type="button" key={entry.id} className={`rest-entry${entry.id === activeEntryId ? " active" : ""}`} onClick={() => onSelectEntry(entry.id)}>
        <span className="rest-entry-dot" />
        <span className="rest-entry-copy"><strong>{entry.name}</strong><small>{entry.baseUrl}</small><small>{normalizePath(entry.defaultPath)}</small></span>
        <span className="rest-entry-edit" onClick={(event) => { event.stopPropagation(); setEditing(entry); }}>Edit</span>
      </button>)}
    </div>
    {editing && <div className="rest-entry-editor">
      <div className="rest-editor-heading"><strong>{entries.some((entry) => entry.id === editing.id) ? "Edit REST entry" : "Add REST entry"}</strong><button type="button" onClick={() => setEditing(null)} aria-label="Close editor">×</button></div>
      <label>Name<input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
      <label>Base URL<input value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })} placeholder="https://api.example.com" /></label>
      <label>Default path<input value={editing.defaultPath} onChange={(event) => setEditing({ ...editing, defaultPath: event.target.value })} placeholder="/v1/rest" /></label>
      <label className="tls-option"><input type="checkbox" checked={editing.ignoreTlsErrors} onChange={(event) => setEditing({ ...editing, ignoreTlsErrors: event.target.checked })} /> Ignore TLS errors</label>
      <div className="modal-actions">{entries.some((entry) => entry.id === editing.id) && <button type="button" className="danger" onClick={() => { localStorage.removeItem(`rest-api-history:${editing.id}`); onChangeEntries(entries.filter((entry) => entry.id !== editing.id)); setEditing(null); }}>Remove</button>}<button type="button" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="confirm" onClick={save}>Save entry</button></div>
    </div>}
  </aside>;
}

export function RestApiWorkspace(props: Props) {
  const entry = props.entries.find((item) => item.id === props.activeEntryId) || props.entries[0];
  const vendor: RestVendor = entry?.vendor === "openbmc" ? "openbmc" : "hpe";
  const vendorPreset = vendorPresets[vendor];
  const secret = entry ? props.secrets[entry.id] || {} : {};
  const sessionTokenRef = useRef<Record<string, string>>({});
  const sessionToken = entry ? props.sessionHeaders[entry.id] || secret.token || sessionTokenRef.current[entry.id] || "" : "";
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
  const [historyOpen, setHistoryOpen] = useState(true);
  const [history, setHistory] = useState<Record<string, RestHistoryItem[]>>({});
  const [actionOpen, setActionOpen] = useState(false);
  const [selectedAction, setSelectedAction] = useState<RedfishAction | null>(null);
  const [actionBody, setActionBody] = useState("{\n  \n}");
  const [sessionHelpOpen, setSessionHelpOpen] = useState(false);
  const [tokenPathHelpOpen, setTokenPathHelpOpen] = useState(false);
  const [tokenPathHelpPosition, setTokenPathHelpPosition] = useState({ top: -999, left: -999 });

  useEffect(() => {
    const nextPath = entry?.defaultPath || "/";
    setPath(nextPath);
    setUrlDraft(entry ? joinUrl(entry.baseUrl, nextPath) : "");
    setResponse(null);
    setResponseText("");
    setError("");
    setMessage("");
  }, [entry?.id]);

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
      if (!target.closest(".token-path-help") && !target.closest(".token-path-help-button")) setTokenPathHelpOpen(false);
    };
    document.addEventListener("click", closeHelp);
    return () => document.removeEventListener("click", closeHelp);
  }, [tokenPathHelpOpen]);

  useEffect(() => {
    const updateTokenHelpPosition = () => {
      const panel = document.querySelector<HTMLElement>(".rest-auth-panel");
      const labels = document.querySelectorAll<HTMLElement>(".rest-login-config > label");
      const tokenLabel = labels[1];
      if (!panel || !tokenLabel) return;
      const panelRect = panel.getBoundingClientRect();
      const labelRect = tokenLabel.getBoundingClientRect();
      setTokenPathHelpPosition({
        top: labelRect.top - panelRect.top - 2,
        left: labelRect.left - panelRect.left + 100,
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
  const selectVendor = (nextVendor: RestVendor) => {
    if (!entry) return;
    props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, vendor: nextVendor } : item));
  };
  const applyVendorPreset = () => {
    if (!entry) return;
    props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, authMode: "login", loginPath: vendorPreset.loginPath, tokenPath: "", tokenHeader: "X-Auth-Token", tokenSendAs: "X-Auth-Token", loginBody: vendorPreset.loginBody } : item));
  };
  const setSessionHeader = (value: string) => {
    if (!entry) return;
    sessionTokenRef.current[entry.id] = value;
    props.onChangeSecret(entry.id, { ...secret, token: value });
    props.onChangeSessionHeaders(entry.id, value ? { "X-Auth-Token": value } : {});
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

  const runRequest = async (requestMethod: RestMethod, requestUrl = urlDraft.trim() || (entry ? joinUrl(entry.baseUrl, path) : ""), requestBody?: string, requestHeaders = entry ? makeHeaders(entry, secret, session) : []) => {
    if (!entry) return;
    if (!requestUrl) throw new Error("Select or create a REST API entry first.");
    if (!/^https?:\/\//i.test(requestUrl)) throw new Error("REST URL must start with http:// or https://.");
    const responseValue = await invoke<NativeApiResponse>("api_request", {
      url: requestUrl,
      method: requestMethod,
      headers: requestHeaders,
      body: requestBody === undefined || requestBody === "" ? null : Array.from(new TextEncoder().encode(requestBody)),
      ignoreTlsErrors: entry.ignoreTlsErrors,
    });
    const text = parseBody(responseValue.body);
    setResponse(responseValue);
    setResponseText(text);
    setUrlDraft(requestUrl);
    recordHistory(requestMethod, requestUrl);
    try {
      const parsed = new URL(requestUrl);
      setPath(parsed.pathname || "/");
    } catch { /* the request helper validates the URL */ }
    return { responseValue, text };
  };

  const execute = async () => {
    if (!entry) return;
    setLoading(true); setError(""); setMessage("");
    try {
      if ((method === "POST" || method === "PATCH") && !window.confirm(`${method} may modify remote data. Send this request?`)) return;
      await runRequest(method, urlDraft, method === "GET" ? undefined : bodyDraft, [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally { setLoading(false); }
  };

  const login = async () => {
    if (!entry) return;
    setLoading(true); setError(""); setMessage("");
    try {
      const body = entry.loginBody.replace(/\{\{username\}\}/g, entry.username).replace(/\{\{password\}\}/g, secret.password || "");
      const loginResult = await runRequest(entry.loginMethod, joinUrl(entry.baseUrl, entry.loginPath), body, [["Content-Type", "application/json"]]);
      if (!loginResult) return;
      const tokenHeader = (loginResult.responseValue.headers || []).find(([name]) => name.toLowerCase() === entry.tokenHeader.toLowerCase())?.[1] || "";
      const json = parseJson(loginResult.text);
      const token = tokenHeader || (json ? String(getJsonPath(json, entry.tokenPath) || "") : "");
      const cookie = extractCookies(loginResult.responseValue.headers);
      if (entry.tokenSendAs.toLowerCase() === "cookie" && cookie) updateSecret({ cookie });
      else if (token) setSessionHeader(token);
      else if (cookie) updateSecret({ cookie });
      else throw new Error("Login succeeded but no configured token or cookie was found.");
      setMessage("REST session established for this entry.");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : String(requestError)); }
    finally { setLoading(false); }
  };

  const openPath = async (nextPath: string) => {
    if (!entry) return;
    const nextUrl = /^https?:\/\//i.test(nextPath) ? nextPath : joinUrl(entry.baseUrl, nextPath);
    setLoading(true);
    setError("");
    try {
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
      const url = /^https?:\/\//i.test(target) ? target : joinUrl(entry.baseUrl, target);
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
    if (!window.confirm(`Run ${selectedAction.title}? This may change the server state.`)) return;
    setLoading(true); setError(""); setMessage("");
    try {
      await runRequest("POST", /^https?:\/\//i.test(selectedAction.target) ? selectedAction.target : joinUrl(entry.baseUrl, selectedAction.target), actionBody.trim() === "{}" ? undefined : actionBody, [["Content-Type", "application/json"], ...makeHeaders(entry, secret, session)]);
      setMessage(`${selectedAction.title} action completed.`);
      setActionOpen(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally { setLoading(false); }
  };
  const currentHistory = entry ? history[entry.id] || [] : [];
  const json = parseJson(responseText);
  const rows = json && typeof json === "object" && !Array.isArray(json) ? Object.entries(json) : [];
  const actions = collectRedfishActions(json);
  const links = collectRedfishLinks(json);

  return <div className="rest-workspace">
    <RestEntries {...props} entries={props.entries} activeEntryId={entry?.id || ""} />
    <section className="rest-reader" aria-label="REST API reader">
      <div className="rest-reader-heading"><div><span className="eyebrow">REST API mode · {props.workspaceName}</span><h1>{entry?.name || "REST API reader"}</h1></div><span className="rest-session-status">{entry && (session["X-Auth-Token"] || secret.cookie) ? "Authenticated" : "Not authenticated"}</span></div>
      {entry && <>
        <section className={`rest-auth-panel${authOpen ? " open" : ""}`}>
          <button type="button" className="rest-section-toggle" onClick={() => setAuthOpen((value) => !value)}><span>Authentication</span><span>{authOpen ? "−" : "+"}</span></button>
          {authOpen && <div className="rest-auth-fields">
            <label>Mode<select value={entry.authMode} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, authMode: event.target.value as RestAuthMode } : item))}>{Object.entries(authLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            {(entry.authMode === "basic" || entry.authMode === "login") && <label>Username<input value={entry.username} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, username: event.target.value } : item))} /></label>}
            {(entry.authMode === "basic" || entry.authMode === "login") && <label>Password<input type="password" value={secret.password || ""} onChange={(event) => updateSecret({ password: event.target.value })} /></label>}
            {entry.authMode === "bearer" && <label>Bearer token<input type="password" value={secret.token || ""} onChange={(event) => updateSecret({ token: event.target.value })} /></label>}
            {entry.authMode === "api-key" && <label>API key<input type="password" value={secret.apiKey || ""} onChange={(event) => updateSecret({ apiKey: event.target.value })} /></label>}
            {entry.authMode === "cookie" && <label>Cookie header<input value={secret.cookie || ""} onChange={(event) => updateSecret({ cookie: event.target.value })} placeholder="session=..." /></label>}
            {entry.authMode === "login" && <div className="rest-vendor-bar"><button type="button" className="rest-help-button" onClick={() => setSessionHelpOpen((value) => !value)} aria-label="How to use the selected Session Auth preset" aria-expanded={sessionHelpOpen}>?</button><div className="rest-vendor-toggle" role="group" aria-label="REST API vendor"><button type="button" className={vendor === "hpe" ? "selected" : ""} onClick={() => selectVendor("hpe")}>HPE</button><button type="button" className={vendor === "openbmc" ? "selected" : ""} onClick={() => selectVendor("openbmc")}>OpenBMC</button></div><button type="button" className="rest-vendor-preset" onClick={applyVendorPreset}>Use Redfish SessionService preset</button><button type="button" className="confirm rest-login-button" onClick={() => void login()} disabled={loading}>{loading ? "Logging in..." : "Login"}</button>{sessionHelpOpen && <div className="rest-session-help" role="note" onClick={(event) => event.stopPropagation()}><button type="button" className="rest-session-help-close" onClick={() => setSessionHelpOpen(false)} aria-label="Close Session Auth help">×</button><strong>{vendorPreset.label} Redfish SessionService login</strong><ol><li>Set Authentication Mode to <strong>Session Auth</strong>.</li><li>Enter your Redfish username.</li><li>Enter your Redfish password.</li><li>Click <strong>Use Redfish SessionService preset</strong>.</li><li>Click <strong>Login</strong>.</li><li>Confirm that <strong>REST session established for this entry.</strong> appears.</li><li>Click <strong>GET</strong> to read the current Redfish resource.</li></ol><pre>{vendorPreset.referenceJson}</pre><p>The session token is kept for this REST API entry and reused by history, breadcrumbs, links, actions, and downloads.</p></div>}</div>}
            {entry.authMode === "login" && <div className="rest-login-config"><label>Login path<input value={entry.loginPath} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, loginPath: event.target.value } : item))} /></label><label>Token JSON path<input value={entry.tokenPath} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, tokenPath: event.target.value } : item))} /></label><label>Token header<input value={entry.tokenHeader} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, tokenHeader: event.target.value } : item))} /></label><label>Login body<textarea value={entry.loginBody} onChange={(event) => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, loginBody: event.target.value } : item))} /></label><div className="rest-session-preset"><button type="button" className="rest-help-button" onClick={() => setSessionHelpOpen((value) => !value)} aria-label="How to use Redfish SessionService preset" aria-expanded={sessionHelpOpen}>?</button><button type="button" onClick={() => props.onChangeEntries(props.entries.map((item) => item.id === entry.id ? { ...item, loginPath: "/redfish/v1/SessionService/Sessions", tokenPath: "", tokenHeader: "X-Auth-Token", tokenSendAs: "X-Auth-Token", loginBody: '{"UserName":"{{username}}","Password":"{{password}}"}' } : item))}>Use Redfish SessionService preset</button><button type="button" className="confirm" onClick={() => void login()} disabled={loading}>{loading ? "Logging in..." : "Login"}</button>{sessionHelpOpen && <div className="rest-session-help" role="note" onClick={(event) => event.stopPropagation()}><button type="button" className="rest-session-help-close" onClick={() => setSessionHelpOpen(false)} aria-label="Close Session Auth help">×</button><strong>Redfish SessionService login</strong><ol><li>Set Authentication Mode to <strong>Session Auth</strong>.</li><li>Enter your Redfish username.</li><li>Enter your Redfish password.</li><li>Click <strong>Use Redfish SessionService preset</strong>.</li><li>Click <strong>Login</strong>.</li><li>Confirm that <strong>REST session established for this entry.</strong> appears.</li><li>Click <strong>GET</strong> to read the current Redfish resource.</li></ol><p>The session token is kept for this REST API entry and reused by history, breadcrumbs, links, actions, and downloads.</p></div>}</div></div>}
           </div>}
          {entry.authMode === "login" && <div className="token-path-help" style={tokenPathHelpPosition}><span>Token JSON Path</span><button type="button" className="token-path-help-button" onClick={() => setTokenPathHelpOpen((value) => !value)} aria-label="What is Token JSON Path" aria-expanded={tokenPathHelpOpen}>?</button>{tokenPathHelpOpen && <div className="token-path-help-popup" role="note" onClick={(event) => event.stopPropagation()}><button type="button" className="token-path-help-close" onClick={() => setTokenPathHelpOpen(false)} aria-label="Close Token JSON Path help">×</button><strong>Token JSON Path</strong><p>Use this only when the login response returns the token inside a JSON response body.</p><pre>{'{\n  "data": {\n    "token": "abc123"\n  }\n}'}</pre><p>Enter <code>data.token</code>. For HPE iLO and OpenBMC Redfish SessionService, leave this empty when the token is returned in the <code>X-Auth-Token</code> response header.</p></div>}</div>}
        </section>
        <div className="rest-url-row"><select value={method} onChange={(event) => setMethod(event.target.value as RestMethod)} aria-label="HTTP method"><option>GET</option><option>POST</option><option>PATCH</option></select><input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void execute(); }} aria-label="REST request URL" /><button type="button" className="primary" onClick={() => void execute()} disabled={loading}>{loading ? "Sending..." : method}</button></div>
        {method !== "GET" && <label className="rest-body-editor">JSON request body<textarea value={bodyDraft} onChange={(event) => setBodyDraft(event.target.value)} spellCheck={false} /></label>}
        <div className="rest-query-editor"><span>Query parameters</span>{entry.query.map((item, index) => <div className="rest-query-row" key={`${entry.id}-query-${index}`}><input value={item.name} placeholder="name" onChange={(event) => updateQuery(entry.query.map((current, currentIndex) => currentIndex === index ? { ...current, name: event.target.value } : current))} /><input value={item.value} placeholder="value" onChange={(event) => updateQuery(entry.query.map((current, currentIndex) => currentIndex === index ? { ...current, value: event.target.value } : current))} /><button type="button" onClick={() => updateQuery(entry.query.filter((_, currentIndex) => currentIndex !== index))} aria-label="Remove query parameter">×</button></div>)}<button type="button" className="rest-query-add" onClick={() => updateQuery([...entry.query, { name: "", value: "" }])}>+ Add parameter</button></div>
        {!!currentHistory.length && <section className="rest-history"><button type="button" className="rest-history-toggle" onClick={() => setHistoryOpen((value) => !value)}><span>Recent GET paths</span><span>{historyOpen ? "−" : "+"}</span></button>{historyOpen && <div className="rest-history-list">{currentHistory.map((item) => <button type="button" className="rest-history-item" key={`${item.url}-${item.timestamp}`} onClick={() => void openPath(item.url)}><span>{item.url}</span><small>{new Date(item.timestamp).toLocaleTimeString()}</small></button>)}<button type="button" className="rest-history-clear" onClick={() => setHistory((current) => ({ ...current, [entry.id]: [] }))}>Clear history</button></div>}</section>}
        <div className="rest-breadcrumbs" aria-label="REST path">{crumbs.map((crumb) => <React.Fragment key={crumb.value}><button type="button" onClick={() => void openPath(crumb.value)}>{crumb.label}</button>{crumb.value !== crumbs[crumbs.length - 1].value && <span>›</span>}</React.Fragment>)}</div>
        {!!links.length && <section className="rest-links"><div className="rest-links-heading"><strong>Resource links</strong><span>{links.length}</span></div>{links.map((link) => <button type="button" className="rest-link-button" key={`${link.name}-${link.target}`} onClick={() => void (link.kind === "download" ? downloadResource(link.target) : openPath(link.target))}><span>{link.name}</span><small>{link.kind === "download" ? "download" : "GET"}</small><code>{link.target}</code></button>)}</section>}
        {!!actions.length && <section className="rest-actions"><div className="rest-actions-heading"><strong>Redfish Actions</strong><span>POST</span></div>{actions.map((action) => <button type="button" className="rest-action-button" key={`${action.name}-${action.target}`} onClick={() => { setSelectedAction(action); setActionBody(defaultActionBody(action)); setActionOpen(true); }}><span>{action.title}</span><small>{action.target}</small></button>)}</section>}
        {actionOpen && selectedAction && <div className="rest-action-dialog"><div className="rest-action-dialog-heading"><strong>{selectedAction.title}</strong><button type="button" onClick={() => setActionOpen(false)} aria-label="Close action">×</button></div><p>This Redfish action sends a POST request and may change power, BIOS, reset, or other server state.</p><label>JSON body<textarea value={actionBody} onChange={(event) => setActionBody(event.target.value)} spellCheck={false} /></label><div className="modal-actions"><button type="button" onClick={() => setActionOpen(false)}>Cancel</button><button type="button" className="danger" onClick={() => void executeAction()} disabled={loading}>{loading ? "Sending..." : "Run action"}</button></div></div>}
        {entry.ignoreTlsErrors && <div className="notice rest-warning">TLS certificate verification is disabled for this REST entry.</div>}
        {message && <div className="notice rest-success">{message}</div>}
        {error && <div className="notice rest-error">{error}{response?.status === 401 || response?.status === 403 ? <button type="button" onClick={() => void login()}>Re-login</button> : null}</div>}
        {response && <section className="rest-response"><div className="rest-response-heading"><strong>Response</strong><span className={response.status >= 400 ? "rest-status-error" : "rest-status-ok"}>{response.status}</span><span>{response.headers?.find(([name]) => name.toLowerCase() === "content-type")?.[1] || "unknown content type"}</span><span>{response.body.length} bytes</span></div><div className="rest-view-tabs"><button type="button" className={view === "pretty" ? "active" : ""} onClick={() => setView("pretty")}>Pretty</button><button type="button" className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>Raw</button><button type="button" className={view === "headers" ? "active" : ""} onClick={() => setView("headers")}>Headers</button></div>{view === "headers" ? <div className="rest-headers">{(response.headers || []).map(([name, value], index) => <div key={`${name}-${index}`}><strong>{name}</strong><span>{name.toLowerCase().includes("authorization") || name.toLowerCase().includes("cookie") || name.toLowerCase().includes("token") ? "••••••••" : value}</span></div>)}</div> : view === "raw" || !json ? <pre className="rest-code">{responseText || "(empty response)"}</pre> : <div className="rest-json-view">{rows.length ? rows.map(([name, value]) => { const resourceLink = value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)["@odata.id"] === "string" ? String((value as Record<string, unknown>)["@odata.id"]) : ""; const href = value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).href === "string" ? String((value as Record<string, unknown>).href) : ""; const link = resourceLink || href; const target = link || `${normalizePath(path)}/${encodeURIComponent(name)}`; const isLink = Boolean(link); return <button type="button" className="rest-json-row" key={name} onClick={() => value && typeof value === "object" ? void openPath(target) : undefined}><span>{responseEntryName(value, name)}</span><small>{isLink ? "link" : Array.isArray(value) ? "array" : value && typeof value === "object" ? "object" : typeof value}</small><code>{isLink ? link : typeof value === "object" ? "[Open]" : String(value)}</code></button>; }) : <pre className="rest-code">{prettyJson(json)}</pre>}</div>}</section>}
      </>}
      {!entry && <div className="rest-reader-empty"><strong>Choose a REST API entry</strong><span>Create an entry on the left to start a request.</span></div>}
    </section>
  </div>;
}
