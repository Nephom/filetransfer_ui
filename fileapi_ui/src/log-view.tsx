import React, { useEffect, useMemo, useRef, useState } from "react";
import "./log-view.css";
import { FloatingWindow } from "./ui/FloatingWindow";

export type OperationLogRecord = Record<string, unknown>;
type SortKey = "time" | "function" | "level" | "status";
type SortDirection = "asc" | "desc";
type LogGroup = {
  key: string;
  operation: string;
  records: OperationLogRecord[];
  firstTime: number;
  last: OperationLogRecord;
};

const value = (record: OperationLogRecord, key: string, fallback = "") => {
  const item = record[key];
  return item === undefined || item === null ? fallback : String(item);
};

const timestamp = (record: OperationLogRecord) => {
  const numeric = Number(record.timestamp);
  return Number.isFinite(numeric) ? numeric : 0;
};

const displayTime = (record: OperationLogRecord) => {
  const numeric = timestamp(record);
  return numeric > 0 ? new Date(numeric * 1000).toLocaleString() : value(record, "timestamp", "-");
};

const operationName = (record: OperationLogRecord) => value(record, "operation", value(record, "event", "operation"));
const result = (record: OperationLogRecord) => {
  const errorMessage = value(record, "errorMessage");
  if (errorMessage) return errorMessage;
  const detail = value(record, "detail", "-");
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const visible = { ...(parsed as Record<string, unknown>) };
      delete visible.operationId;
      delete visible.correlationId;
      return JSON.stringify(visible);
    }
  } catch {
    // Plain-text details are already redacted by the logging boundary.
  }
  return detail.replace(/operationId\s*[=:]\s*[^,\s}]+/gi, "operationId=[hidden]");
};
const groupKey = (record: OperationLogRecord, index: number) =>
  value(record, "operationId") || `${operationName(record)}:${value(record, "timestamp", String(index))}`;

const compareText = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base" });

function LogTable({ records }: { records: OperationLogRecord[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const groups = useMemo(() => {
    const map = new Map<string, LogGroup>();
    records.forEach((record, index) => {
      const key = groupKey(record, index);
      const existing = map.get(key);
      if (existing) {
        existing.records.push(record);
        if (timestamp(record) >= timestamp(existing.last)) existing.last = record;
        existing.firstTime = Math.min(existing.firstTime, timestamp(record));
      } else {
        map.set(key, { key, operation: operationName(record), records: [record], firstTime: timestamp(record), last: record });
      }
    });
    return [...map.values()].map((group) => ({
      ...group,
      records: [...group.records].sort((left, right) => timestamp(left) - timestamp(right)),
    })).sort((left, right) => {
      const direction = sortDirection === "asc" ? 1 : -1;
      if (sortKey === "time") return direction * (left.firstTime - right.firstTime);
      if (sortKey === "function") return direction * compareText(left.operation, right.operation);
      if (sortKey === "level") return direction * compareText(value(left.last, "level"), value(right.last, "level"));
      return direction * compareText(value(left.last, "status"), value(right.last, "status"));
    });
  }, [records, sortDirection, sortKey]);

  const sortBy = (key: SortKey) => {
    if (sortKey === key) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDirection(key === "time" ? "desc" : "asc"); }
  };
  const sortLabel = (key: SortKey) => sortKey === key ? (sortDirection === "asc" ? " ↑" : " ↓") : "";

  return (
    <div className="log-table" role="table" aria-label="Operation log table">
      <div className="log-table-header" role="row">
        <button type="button" role="columnheader" onClick={() => sortBy("time")}>Time{sortLabel("time")}</button>
        <button type="button" role="columnheader" onClick={() => sortBy("function")}>Function{sortLabel("function")}</button>
        <button type="button" role="columnheader" onClick={() => sortBy("level")}>Level{sortLabel("level")}</button>
        <button type="button" role="columnheader" onClick={() => sortBy("status")}>Status{sortLabel("status")}</button>
        <span role="columnheader">Events</span>
        <span role="columnheader">Result</span>
      </div>
      {groups.map((group) => {
        const isExpanded = expanded.has(group.key);
        return (
          <div className="log-table-group" role="rowgroup" key={group.key}>
            <button
              type="button"
              className="log-table-group-row"
              aria-expanded={isExpanded}
              onClick={() => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                return next;
              })}
            >
              <span>{isExpanded ? "▾" : "▸"} {displayTime(group.records[0])}</span>
              <strong>{group.operation}</strong>
              <span className={`log-level log-level-${value(group.last, "level", "INFO").toLowerCase()}`}>{value(group.last, "level", "INFO")}</span>
              <span>{value(group.last, "status", "-")}</span>
              <span>{group.records.length}</span>
              <span className="log-result">{result(group.last)}</span>
            </button>
            {isExpanded && group.records.map((record, index) => (
              <div className="log-table-detail-row" role="row" key={`${group.key}-${index}`}>
                <span>{displayTime(record)}</span>
                <span>{operationName(record)}</span>
                <span className={`log-level log-level-${value(record, "level", "INFO").toLowerCase()}`}>{value(record, "level", "INFO")}</span>
                <span>{value(record, "status", "-")}</span>
                <span>•</span>
                <span className="log-result">{result(record)}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function LogView({ records, onClose, onExport, modalStyle, onDragStart }: {
  records: OperationLogRecord[];
  onClose: () => void;
  onExport: () => void;
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <FloatingWindow
      ariaLabel="LogView"
      className="log-view-modal"
      style={modalStyle}
      onClose={onClose}
      onDragStart={onDragStart}
      header={(
        <header className="log-view-heading modal-drag-handle">
          <div>
            <h2 id="log-view-title">LogView</h2>
            <p>Grouped operation events. Operation IDs are hidden.</p>
          </div>
          <div className="log-view-heading-actions">
            <button type="button" className="log-view-export" onClick={onExport}>Export log</button>
            <button ref={closeRef} type="button" className="log-view-close" onClick={onClose} aria-label="Close LogView">×</button>
          </div>
        </header>
      )}
    >
        <div className="log-view-content floating-window-content" tabIndex={0} aria-label="Pretty operation log">
          {records.length ? <LogTable records={records} /> : <p className="log-view-empty">No operation logs recorded yet.</p>}
        </div>
        <div className="log-view-footer floating-window-footer">
          <span>{records.length} event{records.length === 1 ? "" : "s"}</span>
          <button type="button" className="confirm" onClick={onClose}>Close</button>
        </div>
    </FloatingWindow>
  );
}
