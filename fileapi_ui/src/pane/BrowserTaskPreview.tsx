import { useBrowserSnapshot } from "../features/browser/browser-snapshot-store";

export type BrowserTaskPreviewAnchor = {
  /** Left edge and width of the taskbar tab, in viewport pixels. */
  left: number;
  width: number;
  /** Top edge of the taskbar tab, in viewport pixels. */
  top: number;
};

const PREVIEW_WIDTH = 264;
const EDGE = 8;
const GAP = 10;

type Props = {
  paneId: string;
  title: string;
  anchor: BrowserTaskPreviewAnchor;
};

/** Small picture of a Browser pane shown above its taskbar tab. */
export function BrowserTaskPreview({ paneId, title, anchor }: Props) {
  const snapshot = useBrowserSnapshot(paneId);
  const centered = anchor.left + anchor.width / 2 - PREVIEW_WIDTH / 2;
  const left = Math.min(Math.max(centered, EDGE), Math.max(EDGE, window.innerWidth - PREVIEW_WIDTH - EDGE));
  const bottom = Math.max(EDGE, window.innerHeight - anchor.top + GAP);
  return (
    <div className="pane-task-preview" role="tooltip" style={{ left, bottom, width: PREVIEW_WIDTH }}>
      <div className="pane-task-preview-title">{title}</div>
      <div className="pane-task-preview-frame">
        {snapshot
          ? <img src={snapshot.dataUrl} alt={`Preview of ${title}`} draggable={false} />
          : <span className="pane-task-preview-empty">No preview yet</span>}
      </div>
      {snapshot && snapshot.url && snapshot.url !== "about:blank" && <div className="pane-task-preview-url">{snapshot.url}</div>}
    </div>
  );
}
