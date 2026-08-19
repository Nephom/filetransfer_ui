import type { JsonValue } from "./rest-contracts";
import { invoke } from "@tauri-apps/api/core";

export type HardwareTool = { id: string; label: string; path: string; columns: string[] };

export type OpenBmcSpecRow = { tag: string; info: string };
export type OpenBmcInventorySnapshot = Record<string, JsonValue>;

// The first 18 rows are part of the deliverable even when the BMC does not
// advertise a matching resource. Rows after OS are opportunistic.
export const openBmcRequiredTags = [
  "Board", "Processor/CPU", "DIMM (NVDIMM)", "DIMM (NVDIMM)", "DIMM (NVDIMM)", "DIMM (NVDIMM)",
  "Options", "Backplane", "Drives", "TPM", "PSU", "T-Bird", "BIOS", "iLO/BMC/ServerManagement", "ME/IE", "CPLD", "Power PIC", "OS",
] as const;

export const openBmcOptionalTags = ["Test Kit", "SPP/GIAUS", "Others", "NVMeSSD", "NIC", "PCIeSlot", "PCIeAcc", "MCU/PDB/RISER"] as const;

type JsonObject = { [key: string]: JsonValue };
const objectValue = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const textValue = (value: JsonValue | undefined) => value === undefined || value === null || value === "" ? "" : String(value);
const listValue = (value: JsonValue | undefined): JsonObject[] => {
  if (Array.isArray(value)) return value.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const object = objectValue(value);
  return Array.isArray(object.Members)
    ? object.Members.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : Object.keys(object).length ? [object] : [];
};
const firstText = (object: JsonObject, ...keys: string[]) => keys.map((key) => textValue(object[key])).find(Boolean) || "";
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const countSuffix = (count: number) => count > 1 ? ` x${count}` : "";
const statusText = (value: JsonValue | undefined) => {
  const status = objectValue(value);
  return firstText(status, "State", "Health") || textValue(value);
};

const row = (tag: string, info: string): OpenBmcSpecRow => ({ tag, info: info.trim() || "N/A" });

export const buildOpenBmcSpecRows = (snapshot: OpenBmcInventorySnapshot): OpenBmcSpecRow[] => {
  const root = objectValue(snapshot.root);
  const system = objectValue(snapshot.system);
  const chassis = objectValue(snapshot.chassis);
  const manager = objectValue(snapshot.manager);
  const processors = listValue(snapshot.processors);
  const memory = listValue(snapshot.memory);
  const pcie = listValue(snapshot.pcieDevices);
  const drives = listValue(snapshot.drives);
  const powerSupplies = listValue(snapshot.powerSupplies);
  const firmware = listValue(snapshot.firmwareInventory);
  const slots = listValue(snapshot.pcieSlots);
  const firmwareItem = (pattern: RegExp) => firmware.filter((item) => pattern.test(`${textValue(item.Id)} ${textValue(item.Name)}`));

  const board = [
    [firstText(system, "Manufacturer"), firstText(system, "Model")].filter(Boolean).join(" "),
    ...["SKU", "SerialNumber", "UUID"].map((key) => `${key}=${textValue(system[key])}`).filter((value) => !value.endsWith("=")),
  ].join("; ");
  const processorGroups = new Map<string, { model: string; cores: string; threads: string; serials: string[]; count: number }>();
  processors.forEach((item) => {
    const model = firstText(item, "Model", "Name") || "Unknown CPU";
    const key = `${model}|${textValue(item.SerialNumber)}`;
    const current = processorGroups.get(key) || { model, cores: textValue(item.TotalCores), threads: textValue(item.TotalThreads), serials: [], count: 0 };
    current.count += 1;
    if (textValue(item.SerialNumber)) current.serials.push(textValue(item.SerialNumber));
    processorGroups.set(key, current);
  });
  const processorInfo = [...processorGroups.values()].map((item) => `${item.model} ${item.cores || "-"}C/${item.threads || "-"}T${countSuffix(item.count)}${item.serials.length ? ` (SN ${unique(item.serials).join(",")})` : ""}`).join("; ");
  const dimmInfo = memory.filter((item) => !/absent|no\s*dimm/i.test(`${statusText(item.Status)} ${textValue(item.State)} ${textValue(item.Name)}`)).map((item) => {
    const part = firstText(item, "PartNumber", "Model", "Name") || "Unknown DIMM";
    const capacity = firstText(item, "CapacityMiB", "CapacityMB", "CapacityBytes");
    const speed = firstText(item, "OperatingSpeedMhz", "OperatingSpeedMHz", "OperatingSpeed");
    const type = firstText(item, "MemoryDeviceType", "DeviceType");
    const slot = firstText(item, "ServiceLabel", "DeviceLocator", "Name");
    const serial = textValue(item.SerialNumber);
    return `${part}${capacity ? ` ${capacity}${/bytes/i.test(firstText(item, "CapacityBytes")) ? "B" : "MiB"}` : ""}${type ? ` ${type}` : ""}${speed ? ` ${speed}MHz` : ""}${slot ? ` (${slot}` : ""}${serial ? `${slot ? "; " : " ("}SN ${serial})` : slot ? ")" : ""}`;
  }).join("; ");
  const optionInfo = unique(pcie.map((item) => firstText(item, "Manufacturer", "Model", "Name"))).map((name) => `${name} x${pcie.filter((item) => firstText(item, "Manufacturer", "Model", "Name") === name).length}`).join("; ");
  const m2Slots = slots.filter((item) => /^m2$/i.test(textValue(item.SlotType)));
  const backplaneInfo = m2Slots.map((item) => `${firstText(item, "ServiceLabel", "Name", "Id") || "M.2"} (${statusText(item.State || item.Status) || "Unknown"})`).join("; ");
  const virtualDrives = drives.filter((item) => /virtual\s*(cdrom|hdisk|disk)/i.test(`${textValue(item.Model)} ${textValue(item.Name)}`));
  const physicalDrives = drives.filter((item) => !virtualDrives.includes(item));
  const driveInfo = drives.length ? `Physical Drives ${physicalDrives.length} (total ${drives.length}, virtual ${virtualDrives.length})` : "";
  const trustedModule = listValue(system.TrustedModules)[0];
  const tpmInfo = trustedModule ? [firstText(trustedModule, "InterfaceType"), firstText(trustedModule, "FirmwareVersion", "FirmwareVersion2"), statusText(trustedModule.Status)].filter(Boolean).join("; ") : "";
  const psuGroups = new Map<string, number>();
  powerSupplies.forEach((item) => {
    const name = [firstText(item, "Manufacturer"), firstText(item, "Model")].filter(Boolean).join(" ");
    if (name) psuGroups.set(name, (psuGroups.get(name) || 0) + 1);
  });
  const psuInfo = [...psuGroups.entries()].map(([name, count]) => `${name} x${count}`).join("; ");
  const bios = firmwareItem(/bios/i)[0];
  const amiBios = objectValue(objectValue(system.Oem).Ami).Bios;
  const secureBoot = objectValue(snapshot.secureBoot);
  const biosInfo = bios || Object.keys(objectValue(amiBios)).length || Object.keys(secureBoot).length
    ? [`Version=${textValue(bios?.Version)}`, `RedfishVersion=${textValue(objectValue(amiBios).RedfishVersion)}`, `RtpVersion=${textValue(objectValue(amiBios).RtpVersion)}`, `SecureBootEnable=${firstText(secureBoot, "SecureBootEnable", "Enabled")}`].filter((value) => !value.endsWith("=")).join("; ")
    : "";
  const bmcInfo = [firstText(manager, "Model"), firstText(manager, "FirmwareVersion"), `RedfishVersion=${textValue(root.RedfishVersion)}`].filter((value) => value && !value.endsWith("=")).join("; ");
  const cpldInfo = firmwareItem(/cpld/i).map((item) => `${firstText(item, "Id", "Name") || "CPLD"}=${textValue(item.Version)}`).filter((value) => !value.endsWith("=")).join("; ");

  const dimmRows = dimmInfo ? dimmInfo.split("; ").map((info) => row("DIMM (NVDIMM)", info)) : [];
  while (dimmRows.length < 4) dimmRows.push(row("DIMM (NVDIMM)", "N/A"));
  const required: OpenBmcSpecRow[] = [
    row("Board", board), row("Processor/CPU", processorInfo), ...dimmRows.slice(0, 4), row("Options", optionInfo),
    row("Backplane", backplaneInfo), row("Drives", driveInfo), row("TPM", tpmInfo), row("PSU", psuInfo), row("T-Bird", "N/A"),
    row("BIOS", biosInfo), row("iLO/BMC/ServerManagement", bmcInfo), row("ME/IE", pcie.some((item) => /global\s*ieh/i.test(textValue(item.AssetTag))) ? "Global IEH Device" : "N/A"),
    row("CPLD", cpldInfo), row("Power PIC", "N/A"), row("OS", "N/A"),
  ];
  const optional: OpenBmcSpecRow[] = [];
  if (objectValue(snapshot.testKit).Value || Object.keys(objectValue(snapshot.testKit)).length) optional.push(row("Test Kit", textValue(objectValue(snapshot.testKit).Value) || JSON.stringify(snapshot.testKit)));
  if (objectValue(snapshot.sppGIAUS).Value || Object.keys(objectValue(snapshot.sppGIAUS)).length) optional.push(row("SPP/GIAUS", textValue(objectValue(snapshot.sppGIAUS).Value) || JSON.stringify(snapshot.sppGIAUS)));
  if (objectValue(snapshot.others).Value || Object.keys(objectValue(snapshot.others)).length) optional.push(row("Others", textValue(objectValue(snapshot.others).Value) || JSON.stringify(snapshot.others)));
  const nvme = drives.filter((item) => /nvme|ssd|m\.2/i.test(`${textValue(item.Model)} ${textValue(item.Name)} ${textValue(item.Protocol)}`));
  if (nvme.length) optional.push(row("NVMeSSD", nvme.map((item) => `${firstText(item, "Model", "Name")}${item.CapacityBytes ? ` ${textValue(item.CapacityBytes)}B` : ""}${item.SerialNumber ? ` (SN ${textValue(item.SerialNumber)})` : ""}`).join("; ")));
  const nics = pcie.filter((item) => /i210|nic/i.test(`${textValue(item.AssetTag)} ${textValue(item.Model)} ${textValue(item.Name)}`));
  if (nics.length) optional.push(row("NIC", `${unique(nics.map((item) => firstText(item, "Model", "Name") || "NIC")).join(", ")} x${nics.length}`));
  if (slots.length) optional.push(row("PCIeSlot", slots.map((item) => `${firstText(item, "ServiceLabel", "Name", "Id")} ${statusText(item.State || item.Status)}`.trim()).join("; ")));
  const accelerators = pcie.filter((item) => /qat\s*pf|dlb\s*pf|b2cmi/i.test(textValue(item.AssetTag)));
  if (accelerators.length) optional.push(row("PCIeAcc", unique(accelerators.map((item) => textValue(item.AssetTag))).map((name) => `${name} x${accelerators.filter((item) => textValue(item.AssetTag) === name).length}`).join("; ")));
  const mcu = firmwareItem(/^(?:mcu|pdb|riser)/i);
  if (mcu.length) optional.push(row("MCU/PDB/RISER", mcu.map((item) => `${firstText(item, "Id", "Name")}=${textValue(item.Version)}`).join("; ")));
  return [...required, ...optional];
};

export const openBmcSpecCsv = (rows: OpenBmcSpecRow[]) => [
  ["Tags", "Info"].map(csvCell).join(","),
  ...rows.map((item) => [csvCell(item.tag), csvCell(item.info || "N/A")].join(",")),
].join("\n");

export const openBmcInventoryTableRows = (snapshot: OpenBmcInventorySnapshot) => Object.entries(snapshot).flatMap(([resource, value]) => {
  const rows: Record<string, JsonValue>[] = [];
  const visit = (current: JsonValue, path: string) => {
    if (Array.isArray(current)) return current.forEach((item, index) => visit(item, `${path}[${index}]`));
    if (current && typeof current === "object") return Object.entries(current).forEach(([key, child]) => visit(child, path ? `${path}.${key}` : key));
    rows.push({ Resource: resource, Property: path, Value: current === null || current === undefined || current === "" ? "-" : current });
  };
  visit(value, "");
  return rows;
});

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
