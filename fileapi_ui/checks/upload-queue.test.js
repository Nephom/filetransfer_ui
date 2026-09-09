import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript, hookDriver, deferred, nativeJson } from "./test-utils.js";

const batch = (status, extra = {}) => ({ status, phase: status, totalSize: 0, totalSizeKnown: true, transferredSize: 0, progress: status === "completed" ? 100 : 0, successCount: status === "completed" ? 1 : 0, totalFiles: 1, failedCount: 0, cancelledCount: status === "cancelled" ? 1 : 0, ...extra });
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

function harness(handler = () => undefined) {
  const driver = hookDriver(), calls = [], listeners = new Map(), timers = new Map(), pending = [];
  let timerId = 0, disposed = 0;
  const item = { id: "queue-item", label: "empty", kind: "upload", paths: ["empty"], destinationPath: "folder", locationId: "A", locationName: "A", status: "queued", detail: "" };
  const props = {
    run: async (action) => { const promise = action(); pending.push(promise); await promise; }, notify() {}, setNotice(value) { props.notice = value; },
    api: async () => ({ ok: true, json: async () => ({ files: [{ remotePath: "a/file", relativePath: "file", size: 0 }] }) }),
    readError: async () => "error", session: { token: "cookie", nativeSessionId: "opaque-A", userId: 0, locationId: "A", locationRevision: "root-A", ignoreTlsErrors: false },
    serverUrl: () => "https://original.test:9443", writeOperationLog() {}, describeError: String, path: "folder", localPath: "Downloads", loadFiles: async () => {},
    selectedItems: [{ name: "folder", path: "folder", isDirectory: true, size: 0 }],
    transferQueue: [item], setTransferQueue: (update) => { props.transferQueue = update(props.transferQueue); },
    queueStoreRef: { current: { replace() {} } }, setQueueOpen() {}, setArchiveFormatOpen() {}, setArchiveFormatDraft() {},
    queueProgressSamplesRef: { current: new Map() }, latestQueueProgressRef: { current: new Map() }, queueCompletionHandlersRef: { current: new Map() },
    cancelledQueueItemsRef: { current: new Set() }, queueSchedulerRef: { current: { runExclusive: (_id, execute) => { const promise = execute(); pending.push(promise); return promise; } } },
  };
  const invoke = async (command, args) => {
    calls.push({ command, args });
    const result = handler(command, args);
    if (result !== undefined) return result;
    if (command === "inspect_upload_paths") return { files: 1, directories: 0, totalSize: 0, sources: [{ path: "empty", size: 0, modified: 1 }] };
    if (command === "api_upload_paths") return nativeJson({ batchId: "batch-A" }, 202);
    if (command === "api_request" && args.url.endsWith("/api/upload/batches")) return nativeJson({ batchId: "batch-A", locationId: "A", status: "reserved" }, 201);
    if (command === "api_request" && args.url.endsWith("/cancel")) return nativeJson(batch("cancelling"));
    if (command === "api_request" && args.url.includes("/api/progress/batch/")) return nativeJson(batch("completed"));
    if (command === "cancel_transfer") return null;
    if (command === "download_to_disk" || command === "download_to_disk_at") return "Downloads/file";
    if (command === "ssh_upload_path") return null;
    throw new Error(`Unexpected command: ${command}`);
  };
  const { useTransferQueueActions } = loadTypeScript("features/queue/useTransferQueueActions.tsx", {
    mocks: { react: driver.react, "@tauri-apps/api/core": { invoke }, "@tauri-apps/api/event": { listen: async (name, callback) => { listeners.set(name, callback); return () => { disposed++; listeners.delete(name); }; } } },
    globals: { window: { setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id) } },
  });
  return { props, item, calls, listeners, timers, driver, render: () => driver.render(() => useTransferQueueActions(props)), tick,
    advance: async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()); await tick(); },
    settle: async () => { await tick(); await Promise.all(pending); }, get disposed() { return disposed; } };
}

test("reserves first; every native Location request carries the captured handle and headers", async () => {
  const app = harness(); await app.render().runQueuedUpload(app.item);
  assert.equal(app.calls[0].args.url, "https://original.test:9443/api/upload/batches");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(Uint8Array.from(app.calls[0].args.body))), { path: "folder", clientAttemptId: app.calls.find((call) => call.command === "api_upload_paths").args.transferId });
  for (const call of app.calls.filter((call) => ["api_request", "api_upload_paths"].includes(call.command))) {
    assert.equal(call.args.sessionId, "opaque-A");
    assert.ok(call.args.headers.some(([name, value]) => name === "X-Location-ID" && value === "A"));
    assert.ok(call.args.headers.some(([name, value]) => name === "X-Location-Revision" && value === "root-A"));
    assert.ok(!call.args.headers.some(([name]) => name === "Authorization"));
  }
  assert.equal(app.props.transferQueue[0].status, "completed");
  assert.equal(app.props.transferQueue[0].ownerId, 0, "numeric administrator ID 0 is retained, not treated as missing");
  assert.equal(app.props.transferQueue[0].progress.totalBytes, 0);
  assert.equal(app.props.transferQueue[0].progress.percentage, 100);
  assert.doesNotMatch(JSON.stringify(app.props.transferQueue), /opaque-A|cookie|Authorization/);
  assert.equal(app.disposed, 1);
});

test("lost acceptance and polling failure reconcile without another upload", async () => {
  let polls = 0;
  const app = harness((command, args) => {
    if (command === "api_upload_paths") return Promise.reject(new Error("response lost"));
    if (command === "api_request" && args.url.endsWith("/batch-A") && ++polls === 1) return Promise.reject(new Error("poll offline"));
  });
  await app.render().runQueuedUpload(app.item);
  assert.equal(app.props.transferQueue[0].status, "needs_user_action");
  assert.equal(app.props.transferQueue[0].uploadOutcome, "reconcile");
  app.render().retryDesktopQueueItem(app.props.transferQueue[0]); await app.settle();
  assert.equal(app.calls.filter((call) => call.command === "api_upload_paths").length, 1);
  assert.equal(app.props.transferQueue[0].status, "completed");
});

test("native cancel alone is not server cancellation; completion can win", async () => {
  for (const terminal of ["cancelled", "completed"]) {
    const upload = deferred();
    const app = harness((command, args) => {
      if (command === "api_upload_paths") return upload.promise;
      if (command === "api_request" && args.url.endsWith("/batch-A")) return nativeJson(batch(terminal));
    });
    const running = app.render().runQueuedUpload(app.item); await tick();
    app.render().cancelQueueItem(app.item.id); await tick();
    assert.equal(app.props.transferQueue[0].status, "running");
    assert.equal(app.props.transferQueue[0].cancellationRequested, true);
    assert.ok(app.calls.some((call) => call.args.url?.endsWith("/cancel")));
    upload.resolve(nativeJson({ batchId: "batch-A" }, 202)); await running;
    assert.equal(app.props.transferQueue[0].status, terminal);
  }
});

test("cancel during reservation prevents upload but still waits for confirmed server cancellation", async () => {
  const reservation = deferred();
  const app = harness((command, args) => {
    if (command === "api_request" && args.url.endsWith("/api/upload/batches")) return reservation.promise;
    if (command === "api_request" && args.url.endsWith("/batch-A")) return nativeJson(batch("cancelled"));
  });
  const running = app.render().runQueuedUpload(app.item); await tick();
  app.render().cancelQueueItem(app.item.id);
  assert.equal(app.props.transferQueue[0].status, "running");
  reservation.resolve(nativeJson({ batchId: "batch-A", locationId: "A" }, 201)); await running;
  assert.equal(app.calls.filter((call) => call.command === "api_upload_paths").length, 0);
  assert.equal(app.props.transferQueue[0].status, "cancelled");
});

test("session switch cannot retarget an active upload; cancellation failure stays unconfirmed", async () => {
  const upload = deferred();
  const app = harness((command, args) => {
    if (command === "api_upload_paths") return upload.promise;
    if (command === "api_request" && args.url.includes("/api/progress/")) return Promise.reject(new Error("offline"));
  });
  const running = app.render().runQueuedUpload(app.item); await tick();
  app.props.session = { token: "other", userId: 2, nativeSessionId: "opaque-B", locationId: "B" };
  app.props.serverUrl = () => "https://other.test";
  app.render().cancelQueueItem(app.item.id); await tick();
  upload.resolve(nativeJson({}, 202)); await running;
  assert.equal(app.props.transferQueue[0].status, "needs_user_action");
  assert.ok(app.calls.filter((call) => call.command === "api_request").every((call) => call.args.sessionId === "opaque-A"));
  app.render().retryDesktopQueueItem(app.props.transferQueue[0]);
  assert.match(app.props.notice, /original upload session is unavailable/i);
});

test("partial failures preserve measured bytes; server progress never estimates transferred bytes", async () => {
  const app = harness((command, args) => command === "api_request" && args.url.endsWith("/batch-A") ? nativeJson(batch("partial_fail", { totalSize: 100, transferredSize: 0, progress: 90, failedCount: 1 })) : undefined);
  await app.render().runQueuedUpload(app.item);
  assert.equal(app.props.transferQueue[0].status, "failed");
  assert.equal(app.props.transferQueue[0].progress.completedBytes, 0);
  assert.equal(app.props.transferQueue[0].progress.percentage, 0);
  app.render().retryDesktopQueueItem(app.props.transferQueue[0]);
  assert.equal(app.calls.filter((call) => call.command === "api_upload_paths").length, 1);
});

test("cookie archive and flattened downloads keep Content-Type and Location independently of Bearer", async () => {
  const app = harness(); app.render().enqueueDownload("zip"); await tick(); await app.advance(); await app.settle();
  const archive = app.calls.find((call) => call.command === "download_to_disk");
  assert.ok(archive.args.headers.some(([name]) => name === "Content-Type"));
  assert.ok(archive.args.headers.some(([name]) => name === "X-Location-ID"));
  assert.equal(archive.args.sessionId, "opaque-A");
  app.render().enqueueQueueDownload(); await app.settle();
  const file = app.calls.find((call) => call.command === "download_to_disk_at");
  assert.equal(file.args.sessionId, "opaque-A");
  assert.ok(file.args.headers.some(([name]) => name === "X-Location-ID"));
});

test("unmount releases polling timers; late progress callbacks cannot mutate the queue", async () => {
  const app = harness((command, args) => command === "api_request" && args.url.endsWith("/batch-A") ? nativeJson(batch("running")) : undefined);
  const running = app.render().runQueuedUpload(app.item); await tick();
  assert.equal(app.timers.size, 1);
  app.driver.unmount(); await running;
  assert.equal(app.timers.size, 0);
  assert.equal(app.listeners.size, 0);
});

test("SFTP upload still uses its existing native command, without API sessions", async () => {
  const app = harness(); await app.render().runQueuedSshUpload({ ...app.item, sshEntryId: "ssh" }, { id: "ssh" });
  assert.deepEqual(app.calls.map((call) => call.command), ["ssh_upload_path"]);
});

test("late native upload progress is attempt-scoped and cannot overwrite cancellation settlement", async () => {
  const upload = deferred();
  const app = harness((command, args) => command === "api_upload_paths" ? upload.promise : command === "api_request" && args.url.endsWith("/batch-A") ? nativeJson(batch("cancelled")) : undefined);
  const running = app.render().runQueuedUpload(app.item); await tick();
  const callback = app.listeners.get("upload-progress");
  const transferId = app.calls.find((call) => call.command === "api_upload_paths").args.transferId;
  callback({ payload: { transferId: "old-attempt", bytesCompleted: 999, bytesTotal: 999 } });
  assert.equal(app.props.transferQueue[0].progress.completedBytes, 0);
  callback({ payload: { transferId, bytesCompleted: 12, bytesTotal: 100 } });
  assert.equal(app.props.transferQueue[0].progress.completedBytes, 12);
  app.render().cancelQueueItem(app.item.id); upload.resolve(nativeJson({}, 202)); await running;
  const terminal = JSON.stringify(app.props.transferQueue[0]);
  callback({ payload: { transferId, bytesCompleted: 100, bytesTotal: 100 } });
  assert.equal(JSON.stringify(app.props.transferQueue[0]), terminal);
});

test("unknown server total is not treated as zero; empty completed batches settle by status", async () => {
  for (const known of [true, false]) {
    const app = harness((command, args) => command === "api_request" && args.url.endsWith("/batch-A") ? nativeJson(batch("completed", { totalSizeKnown: known, totalFiles: 0, successCount: 0 })) : undefined);
    await app.render().runQueuedUpload(app.item);
    assert.equal(app.props.transferQueue[0].progress.totalBytes, known ? 0 : null);
    assert.equal(app.props.transferQueue[0].progress.percentage, known ? 100 : null);
  }
});

test("restored accepted uploads cannot be rebound and uploaded under the new login", () => {
  const app = harness();
  const restored = { ...app.item, status: "needs_user_action", serverBatchId: "batch-A", uploadOutcome: "reconcile" };
  app.props.transferQueue = [restored];
  app.render().retryDesktopQueueItem(restored);
  assert.equal(app.calls.length, 0);
  assert.match(app.props.notice, /original upload session is unavailable/i);
});
