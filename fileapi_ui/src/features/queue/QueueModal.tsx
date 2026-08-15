import React from "react";
import { FloatingWindow } from "../../ui/FloatingWindow";

type QueueStatus = "completed" | "failed" | "cancelled" | string;
type QueueItem = { id: string; status: QueueStatus };

type QueueModalProps = {
  items: QueueItem[];
  activeItems: QueueItem[];
  historyItems: QueueItem[];
  renderItem: (item: QueueItem) => React.ReactNode;
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onClearStatus: (status: "completed" | "failed" | "cancelled") => void;
  onClearHistory: () => void;
};

export function QueueModal({ items, activeItems, historyItems, renderItem, modalStyle, onDragStart, onClose, onClearStatus, onClearHistory }: QueueModalProps) {
  return (
    <FloatingWindow
      ariaLabel="Transfer Queue"
      className="queue-modal"
      style={modalStyle}
      onClose={onClose}
      onDragStart={onDragStart}
      header={<h2 className="modal-drag-handle">Transfer Queue</h2>}
      footer={(
        <div className="modal-actions">
          {items.some((item) => item.status === "completed") && <button type="button" onClick={() => onClearStatus("completed")}>Clear completed</button>}
          {items.some((item) => item.status === "failed") && <button type="button" onClick={() => onClearStatus("failed")}>Clear failed</button>}
          {items.some((item) => item.status === "cancelled") && <button type="button" onClick={() => onClearStatus("cancelled")}>Clear cancelled</button>}
          {items.some((item) => ["completed", "failed", "cancelled"].includes(item.status)) && <button type="button" onClick={onClearHistory}>Clear history</button>}
          <button type="button" onClick={onClose}>Close</button>
        </div>
      )}
    >
      {!items.length && <p className="muted">No transfers queued.</p>}
      {activeItems.length > 0 && <section className="queue-section"><h3>Active</h3>{activeItems.map(renderItem)}</section>}
      {historyItems.length > 0 && <section className="queue-section"><h3>History</h3>{historyItems.map(renderItem)}</section>}
    </FloatingWindow>
  );
}
