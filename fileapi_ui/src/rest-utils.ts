import type { JsonValue } from "./rest-contracts";
import { invoke } from "@tauri-apps/api/core";

export type HardwareTool = { id: string; label: string; path: string; columns: string[] };

export const hardwareTools: HardwareTool[] = [
  { id: "cpu", label: "CPU inventory", path: "/redfish/v1/Systems/1/Processors", columns: ["Socket", "Model", "TotalCores", "TotalThreads", "MaxSpeedMHz", "Status"] },
  { id: "memory", label: "Memory inventory", path: "/redfish/v1/Systems/1/Memory", columns: ["Name", "CapacityMiB", "OperatingSpeedMhz", "MemoryDeviceType", "Manufacturer", "SerialNumber", "Status"] },
  { id: "nic", label: "NIC inventory", path: "/redfish/v1/Systems/1/EthernetInterfaces", columns: ["Name", "MACAddress", "LinkStatus", "SpeedMbps", "FirmwareVersion", "PermanentMACAddress"] },
  { id: "storage", label: "Storage inventory", path: "/redfish/v1/Systems/1/Storage", columns: ["Name", "Drives", "Model", "SerialNumber", "CapacityBytes", "MediaType", "FirmwareVersion", "Health"] },
  { id: "pcie", label: "PCIe inventory", path: "/redfish/v1/Systems/1/PCIeDevices", columns: ["Name", "Manufacturer", "DeviceId", "BusNumber", "FunctionNumber", "Slot", "FirmwareVersion", "Status"] },
  { id: "power", label: "Power supplies", path: "/redfish/v1/Chassis/1/Power", columns: ["Name", "Model", "SerialNumber", "PowerCapacityWatts", "FirmwareVersion", "Status"] },
  { id: "thermal", label: "Thermal sensors", path: "/redfish/v1/Chassis/1/Thermal", columns: ["Name", "ReadingCelsius", "Reading", "UpperThresholdCritical", "PhysicalContext", "Status"] },
];

export const jsonCell = (value: JsonValue | undefined) => value === undefined || value === null ? "-" : typeof value === "object" ? JSON.stringify(value) : String(value);
export const tableCell = (value: JsonValue | undefined): string => {
  if (value === undefined || value === null || value === "") return "-";
  if (Array.isArray(value)) return value.length ? value.map((item) => tableCell(item)).join(", ") : "-";
  if (typeof value === "object") {
    const meaningful = [value.Health, value.State, value.Name, value.Id].filter(Boolean).map((item) => String(item));
    return meaningful.length ? meaningful.join(" / ") : "-";
  }
  return String(value);
};
export const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
const SECRET_KEY = /password|passwd|secret|token|cookie|authorization|api[-_]?key|credential|private[-_ ]?key/i;
const SECRET_VALUE = /(bearer\s+)[^\s,;]+|((?:password|passwd|secret|token|cookie|api[-_]?key)\s*[=:]\s*)[^\s,;]+/gi;
export const sanitizeJson = (value: JsonValue, depth = 0): JsonValue => {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : sanitizeJson(item, depth + 1)]));
  return value;
};
export const sanitizeHeaders = (headers: [string, string][]) => headers.map(([name, value]) => [name, SECRET_KEY.test(name) ? "[redacted]" : value] as [string, string]);
export const sanitizeText = (value: string, depth = 0) => {
  if (depth > 8) return "[truncated]";
  const parsed = (() => {
    try { return JSON.parse(value) as JsonValue; } catch { return null; }
  })();
  if (parsed !== null && typeof parsed === "object") {
    const serialized = JSON.stringify(sanitizeJson(parsed), null, 2);
    return serialized.length > 16_384 ? `${serialized.slice(0, 16_384)}\n...[truncated at 16384 characters]` : serialized;
  }
  return value.replace(SECRET_VALUE, "$1[redacted]").slice(0, 16_384);
};
export const debugRest = (event: Record<string, unknown>) => {
  try {
    const record = {
      level: "DEBUG",
      mode: "rest",
      operation: String(event.workflow || "REST"),
      status: String(event.event || "debug"),
      sourceLabel: String(event.entry || "REST"),
      destinationLabel: String(event.targetPath || event.url || ""),
      source: String(event.entry || "REST"),
      destination: String(event.targetPath || event.url || ""),
      detail: JSON.stringify(event),
      operationId: String(event.operationId || event.workflowId || crypto.randomUUID()),
      correlationId: String(event.correlationId || event.workflowId || crypto.randomUUID()),
      timestamp: new Date().toISOString(),
      ...event,
    };
    void invoke("append_structured_operation_log", { record }).catch(() => {});
  } catch { /* logging must never affect the request */ }
};
export const downloadText = (name: string, content: string, type: string) => {
  const safeContent = /json/i.test(type) ? sanitizeText(content) : content;
  void invoke<string | null>("save_text_file", { name, content: safeContent }).catch(() => {
    const url = URL.createObjectURL(new Blob([safeContent], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  });
};
