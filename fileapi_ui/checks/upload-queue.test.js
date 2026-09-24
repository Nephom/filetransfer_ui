import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadTypeScript, hookDriver, deferred, nativeJson } from "./test-utils.js";

const batch = (status, extra = {}) => ({ status, phase: status, totalSize: 0, totalSizeKnown: true, transferredSize: 0, progress: status === "completed" ? 100 : 0, successCount: status === "completed" ? 1 : 0, totalFiles: 1, failedCount: 0, cancelledCount: status === "cancelled" ? 1 : 0, ...extra });
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const uploadPlan = loadTypeScript("queue/upload-plan.ts");
const manifestHash = (size, hashes) => createHash("sha256").update(Buffer.concat([...hashes.map(hash => Buffer.from(hash, "hex")), Buffer.from(String(size))])).digest("hex");

const manifestFile = (fileId, path) => ({ fileId, sourcePath: path, path, name: path.split("/").pop(), size: 0, modified: 1, chunkHashes: [] });

test("upload plan uses UTF-8 path order and keeps collision groups together under the 500-file cap", () => {
  const files = [manifestFile("z", "z/file"), manifestFile("same-2", "a/same"), manifestFile("a", "a/file"), manifestFile("same-1", "a/same")];
  const children = uploadPlan.planUploadChildren(files, 3);
  assert.deepEqual(children.map(child => child.map(file => file.fileId)), [["a", "same-2", "same-1"], ["z"]]);
  assert.throws(() => uploadPlan.planUploadChildren(Array.from({ length: 501 }, (_, index) => manifestFile(String(index), "same")), 500), /same destination path/);
});

test("resume manifest rebinds existing file IDs by path, size, and chunk hashes", () => {
  const local = [manifestFile("new-a", "dir/a"), { ...manifestFile("new-b", "dir/b"), size: 3, chunkHashes: ["b".repeat(64)] }];
  const remote = [
    { ...local[1], fileId: "server-b", index: 1, chunkSize: 8, uploadedOffset: 1, status: "uploading" },
    { ...local[0], fileId: "server-a", index: 0, chunkSize: 8, uploadedOffset: 0, status: "pending" },
  ];
  assert.deepEqual(uploadPlan.rebindUploadManifest(local, remote).map(file => file.fileId), ["server-a", "server-b"]);
});

function harness(handler = () => undefined, { sourceSize = 0, fileCount = 1 } = {}) {
  const driver = hookDriver(), calls = [], listeners = new Map(), timers = new Map(), pending = [];
  let timerId = 0, disposed = 0;
  const paths = Array.from({ length: fileCount }, (_, index) => fileCount === 1 ? "empty" : `file-${String(index).padStart(4, "0")}`);
  const item = { id: "queue-item", label: `${fileCount} files`, kind: "upload", paths, destinationPath: "folder", locationId: "A", locationName: "A", status: "queued", detail: "" };
  const backend = { session: null, files: [], directories: [], totalSize: sourceSize, sessionId: "session-A" };
  let sourceSummary;
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
    const result = handler(command, args, backend);
    if (result !== undefined) return result;
    if (command === "inspect_upload_paths") {
      sourceSummary = { files: fileCount, directories: 0, totalSize: sourceSize * fileCount,
        sources: paths.map(path => ({ path, size: sourceSize, modified: 1 })) };
      return sourceSummary;
    }
    if (command === "build_api_upload_manifest") return {
      files: paths.map((localPath, index) => {
        const chunkHashes = Array.from({ length: Math.ceil(sourceSize / args.chunkSize) }, () => "0".repeat(64));
        return { fileId: `file-${index}`, sourcePath: localPath, path: localPath,
          name: localPath, size: sourceSize, modified: 1, chunkHashes, manifestHash: manifestHash(sourceSize, chunkHashes) };
      }),
      directories: [], totalSize: sourceSize * fileCount,
    };
    if (command === "api_upload_chunk") {
      const file = backend.files.find(candidate => candidate.sourcePath === args.filePath) || backend.files[0];
      const length = Math.min(args.chunkSize, file.size - args.offset);
      file.uploadedOffset = args.offset + length;
      backend.session.uploadedSize = backend.files.reduce((sum, current) => sum + current.uploadedOffset, 0);
      return nativeJson({ fileId: file.fileId, uploadedOffset: file.uploadedOffset, size: file.size, status: "uploading" });
    }
    if (command === "api_request" && args.url.endsWith("/api/upload/sessions")) {
      const requestBody = JSON.parse(new TextDecoder().decode(Uint8Array.from(args.body)));
      backend.session = { sessionId: backend.sessionId, locationId: "A", path: "folder", chunkSize: 8 * 1024 * 1024,
        expectedFileCount: requestBody.fileCount,
        expectedDirectoryCount: requestBody.directoryCount, totalSize: 0, uploadedSize: 0,
        manifestComplete: false, status: "manifest", expiresAt: Date.now() + 14400000 };
      return nativeJson(backend.session, 201);
    }
    if (command === "api_request" && args.url.endsWith("/api/upload/sessions/config")) {
      return nativeJson({ chunkSize: 8 * 1024 * 1024 });
    }
    if (command === "api_request" && args.url.includes("/api/upload/sessions/session-A/manifest/pages/")) {
      const body = JSON.parse(new TextDecoder().decode(Uint8Array.from(args.body)));
      backend.files.push(...body.files.map((file, index) => ({ ...file, manifestHash: manifestHash(file.size, file.chunkHashes), sourcePath: paths[body.fileOffset + index], index: body.fileOffset + index,
        chunkSize: backend.session.chunkSize, uploadedOffset: 0, status: "pending" })));
      backend.directories.push(...body.directories);
      return nativeJson({ success: true }, 201);
    }
    if (command === "api_request" && args.url.endsWith("/manifest/complete")) {
      backend.session.manifestComplete = true; backend.session.status = "uploading";
      backend.session.totalSize = backend.files.reduce((sum, file) => sum + file.size, 0);
      return nativeJson(backend.session);
    }
    if (command === "api_request" && args.url.includes("/api/upload/sessions/session-A/files/") && args.url.endsWith("/complete")) {
      const fileId = args.url.split("/").slice(-2, -1)[0];
      const file = backend.files.find(candidate => candidate.fileId === fileId);
      file.status = "completed"; file.uploadedOffset = file.size;
      return nativeJson({ fileId, status: "completed", uploadedOffset: file.size, path: file.path, size: file.size });
    }
    if (command === "api_request" && args.url.endsWith("/api/upload/sessions/session-A/complete")) {
      backend.session.status = "completed";
      return nativeJson({ success: true, sessionId: backend.sessionId, status: "completed" });
    }
    if (command === "api_request" && args.url.endsWith("/api/upload/sessions/session-A/cancel")) {
      backend.session.status = "cancelled";
      return nativeJson({ sessionId: backend.sessionId, status: "cancelled" });
    }
    if (command === "api_request" && args.url.includes("/api/upload/sessions/session-A?")) {
      const url = new URL(args.url);
      const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 100);
      const directoryOffset = Number(url.searchParams.get("directoryOffset") || 0);
      const files = backend.files.slice(offset, offset + limit), directories = backend.directories.slice(directoryOffset, directoryOffset + limit);
      return nativeJson({ session: backend.session, files,
        nextOffset: offset + files.length < backend.files.length ? offset + files.length : null,
        directories, nextDirectoryOffset: directoryOffset + directories.length < backend.directories.length ? directoryOffset + directories.length : null });
    }
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
  return { props, item, calls, listeners, timers, driver, backend, render: () => driver.render(() => useTransferQueueActions(props)), tick,
    advance: async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()); await tick(); },
    settle: async () => { await tick(); await Promise.all(pending); }, get disposed() { return disposed; } };
}

test("prepares and preflights the manifest before session reservation; native API requests keep the captured context", async () => {
  const app = harness(); await app.render().runQueuedUpload(app.item);
  const reservation = app.calls.find((call) => call.command === "api_request" && call.args.url === "https://original.test:9443/api/upload/sessions");
  assert.ok(reservation);
  const manifest = app.calls.find((call) => call.command === "build_api_upload_manifest");
  assert.ok(manifest);
  assert.ok(app.calls.indexOf(manifest) < app.calls.indexOf(reservation), "checksums are prepared before the four-hour server session starts");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(Uint8Array.from(reservation.args.body))), {
    path: "folder", clientAttemptId: app.props.transferQueue[0].clientAttemptId, chunkSize: 8 * 1024 * 1024, fileCount: 1, directoryCount: 0,
  });
  assert.equal(app.calls.some((call) => call.command === "api_upload_paths"), false);
  assert.equal(app.calls.some((call) => call.args.url?.includes("/api/upload/sessions/session-A/manifest/pages/0")), true);
  for (const call of app.calls.filter((call) => call.command === "api_request")) {
    assert.equal(call.args.sessionId, "opaque-A");
    assert.ok(call.args.headers.some(([name, value]) => name === "X-Location-ID" && value === "A"));
    assert.ok(call.args.headers.some(([name, value]) => name === "X-Location-Revision" && value === "root-A"));
    assert.ok(!call.args.headers.some(([name]) => name === "Authorization"));
  }
  assert.equal(app.props.transferQueue[0].status, "completed");
  assert.equal(app.props.transferQueue[0].ownerId, 0, "numeric administrator ID 0 is retained, not treated as missing");
  assert.equal(app.props.transferQueue[0].serverSessionId, "session-A");
  assert.equal(app.props.transferQueue[0].progress.totalBytes, 0);
  assert.equal(app.props.transferQueue[0].progress.percentage, 100);
  assert.doesNotMatch(JSON.stringify(app.props.transferQueue), /opaque-A|cookie|Authorization/);
  assert.equal(app.disposed, 1);
});

test("an oversized destination collision group is rejected before creating a server session", async () => {
  const app = harness((command) => command === "build_api_upload_manifest" ? ({
    files: Array.from({ length: 501 }, (_, index) => ({
      fileId: `file-${index}`, sourcePath: `source-${index}`, path: "same.txt", name: "same.txt",
      size: 0, modified: 1, chunkHashes: [], manifestHash: manifestHash(0, []),
    })),
    directories: [], totalSize: 0,
  }) : undefined, { fileCount: 501 });
  await app.render().runQueuedUpload(app.item);
  assert.equal(app.calls.some(call => call.command === "api_request" && call.args.url.endsWith("/api/upload/sessions")), false);
  assert.equal(app.props.transferQueue[0].status, "needs_user_action");
  assert.match(app.props.transferQueue[0].detail, /same destination path/i);
});

test("resuming a persisted session skips completed files and uploads only the unfinished child data", async () => {
  const app = harness(() => undefined, { sourceSize: 4, fileCount: 2 });
  app.item.serverSessionId = "session-A";
  app.item.serverOrigin = "https://original.test:9443";
  app.item.ownerId = 0;
  app.item.locationRevision = "root-A";
  app.item.uploadOutcome = "resumable";
  app.backend.session = { sessionId: "session-A", locationId: "A", path: "folder", chunkSize: 8 * 1024 * 1024,
    expectedFileCount: 2, expectedDirectoryCount: 0, totalSize: 8, uploadedSize: 4,
    manifestComplete: true, status: "uploading", expiresAt: Date.now() + 14400000 };
  app.backend.files = ["file-0000", "file-0001"].map((relativePath, index) => ({
    fileId: `file-${index}`, index, path: relativePath, name: relativePath, size: 4, chunkSize: 8 * 1024 * 1024,
    chunkHashes: ["0".repeat(64)], manifestHash: manifestHash(4, ["0".repeat(64)]), uploadedOffset: index === 0 ? 4 : 0,
    status: index === 0 ? "completed" : "pending",
  }));
  await app.render().runQueuedUpload(app.item);
  assert.equal(app.props.transferQueue[0].status, "completed");
  assert.equal(app.calls.some(call => call.command === "api_request" && call.args.method === "POST" && call.args.url.endsWith("/api/upload/sessions")), false);
  assert.deepEqual(app.calls.filter(call => call.command === "api_upload_chunk").map(call => call.args.filePath), ["file-0001"]);
  assert.equal(app.backend.files[0].status, "completed");
});

test("large API upload limits the active child batches to two", async () => {
  const first = deferred(), second = deferred();
  let active = 0, maximum = 0;
  const finishChunk = (args, backend) => {
    const file = backend.files.find(candidate => candidate.sourcePath === args.filePath);
    file.uploadedOffset = file.size;
    backend.session.uploadedSize = backend.files.reduce((sum, current) => sum + current.uploadedOffset, 0);
    active -= 1;
    return nativeJson({ fileId: file.fileId, uploadedOffset: file.size, size: file.size, status: "uploading" });
  };
  const app = harness((command, args, backend) => {
    if (command !== "api_upload_chunk") return undefined;
    active += 1;
    maximum = Math.max(maximum, active);
    if (args.filePath === "file-0000") return first.promise.then(() => finishChunk(args, backend));
    if (args.filePath === "file-0500") return second.promise.then(() => finishChunk(args, backend));
    return finishChunk(args, backend);
  }, { sourceSize: 1, fileCount: 1001 });
  const running = app.render().runQueuedUpload(app.item);
  for (let attempt = 0; attempt < 200 && active < 2; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 2);
  assert.equal(maximum, 2);
  assert.match(app.props.transferQueue[0].detail, /up to 2 child batches run concurrently/i);
  first.resolve(); second.resolve();
  await running;
  assert.equal(app.props.transferQueue[0].status, "completed");
  assert.equal(maximum, 2);
  assert.equal(app.calls.filter(call => call.command === "api_upload_chunk").length, 1001);
});

test("lost chunk response reconciles the stored offset without resending accepted bytes", async () => {
  let lost = true;
  const app = harness((command, _args, backend) => {
    if (command === "api_upload_chunk" && lost) {
      lost = false;
      backend.files[0].uploadedOffset = backend.files[0].size;
      backend.session.uploadedSize = backend.files[0].size;
      return Promise.reject(new Error("chunk response lost"));
    }
  }, { sourceSize: 4 });
  await app.render().runQueuedUpload(app.item);
  assert.equal(app.props.transferQueue[0].status, "completed");
  assert.equal(app.calls.filter((call) => call.command === "api_upload_chunk").length, 1);
  assert.equal(app.backend.files[0].status, "completed");
});

test("server cancellation must settle; a server-completed file wins the cancellation race", async () => {
  for (const terminal of ["cancelled", "completed"]) {
    const upload = deferred();
    const app = harness((command, args, backend) => {
      if (command === "api_upload_chunk") return upload.promise;
      if (command === "api_request" && args.url.endsWith("/cancel")) {
        backend.session.status = terminal;
        if (terminal === "completed") {
          backend.files[0].status = "completed";
          backend.files[0].uploadedOffset = backend.files[0].size;
          backend.session.uploadedSize = backend.files[0].size;
        }
        return nativeJson({ sessionId: "session-A", status: terminal });
      }
    }, { sourceSize: 4 });
    const running = app.render().runQueuedUpload(app.item); await tick();
    for (let attempt = 0; attempt < 20 && !app.calls.some((call) => call.command === "api_upload_chunk"); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    app.render().cancelQueueItem(app.item.id); await tick();
    assert.equal(app.props.transferQueue[0].status, "running");
    assert.equal(app.props.transferQueue[0].cancellationRequested, true);
    assert.ok(app.calls.some((call) => call.args.url?.endsWith("/api/upload/sessions/session-A/cancel")));
    upload.resolve(nativeJson({ fileId: "file-A", uploadedOffset: 4, size: 4, status: "uploading" }, 200)); await running;
    assert.equal(app.props.transferQueue[0].status, terminal);
  }
});

test("cancel during resumable session creation cancels the new session without sending a manifest", async () => {
  const reservation = deferred();
  const app = harness((command, args, backend) => {
    if (command === "api_request" && args.url.endsWith("/api/upload/sessions")) return reservation.promise;
    if (command === "api_request" && args.url.endsWith("/cancel")) {
      backend.session.status = "cancelled";
      return nativeJson({ sessionId: "session-A", status: "cancelled" });
    }
  });
  const running = app.render().runQueuedUpload(app.item);
  for (let attempt = 0; attempt < 20 && !app.calls.some(call => call.command === "api_request" && call.args.url.endsWith("/api/upload/sessions")); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(app.calls.some(call => call.command === "api_request" && call.args.url.endsWith("/api/upload/sessions")), "session request is in flight before cancellation");
  app.render().cancelQueueItem(app.item.id);
  assert.equal(app.props.transferQueue[0].status, "running");
  app.backend.session = { sessionId: "session-A", locationId: "A", path: "folder", chunkSize: 8 * 1024 * 1024,
    expectedFileCount: 1, expectedDirectoryCount: 0, totalSize: 0, uploadedSize: 0,
    manifestComplete: false, status: "manifest", expiresAt: Date.now() + 14400000 };
  reservation.resolve(nativeJson(app.backend.session, 201)); await running;
  assert.equal(app.calls.some((call) => call.command === "api_request" && call.args.url.includes("/manifest/pages/")), false,
    JSON.stringify(app.calls.map(call => [call.command, call.args?.method, call.args?.url])));
  assert.equal(app.calls.filter((call) => call.command === "api_upload_chunk").length, 0);
  assert.equal(app.props.transferQueue[0].status, "cancelled");
});

test("session switch cannot retarget a resumable API upload; cancellation failure stays unconfirmed", async () => {
  const upload = deferred();
  const app = harness((command, args) => command === "api_upload_chunk"
    ? upload.promise
    : command === "api_request" && args.url.endsWith("/cancel") ? Promise.reject(new Error("offline")) : undefined, { sourceSize: 4 });
  const running = app.render().runQueuedUpload(app.item); await tick();
  for (let attempt = 0; attempt < 20 && !app.calls.some((call) => call.command === "api_upload_chunk"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const chunkCall = app.calls.find((call) => call.command === "api_upload_chunk");
  assert.ok(chunkCall);
  app.props.session = { token: "other", userId: 2, nativeSessionId: "opaque-B", locationId: "B" };
  app.props.serverUrl = () => "https://other.test";
  app.render().cancelQueueItem(app.item.id); await tick();
  upload.resolve(nativeJson({ error: { message: "cancelled" } }, 409)); await running;
  assert.equal(app.props.transferQueue[0].status, "needs_user_action");
  assert.ok(app.calls.filter((call) => call.command === "api_request").every((call) => call.args.sessionId === "opaque-A"));
  app.render().retryDesktopQueueItem(app.props.transferQueue[0]);
  assert.match(app.props.notice, /resume requires the original server/i);
});

test("a later chunk failure retains actual offsets and manual resume skips the accepted range", async () => {
  const chunkSize = 8 * 1024 * 1024;
  let failTail = true;
  const app = harness((command, args, backend) => {
    if (command !== "api_upload_chunk") return undefined;
    const source = backend.files[0];
    if (args.offset === 0) {
      source.uploadedOffset = chunkSize;
      backend.session.uploadedSize = chunkSize;
      return nativeJson({ uploadedOffset: chunkSize, size: source.size, status: "uploading" });
    }
    if (failTail) return nativeJson({ error: { message: "staging full" } }, 507);
    source.uploadedOffset = source.size;
    backend.session.uploadedSize = source.size;
    return nativeJson({ uploadedOffset: source.size, size: source.size, status: "uploading" });
  }, { sourceSize: chunkSize + 1 });
  await app.render().runQueuedUpload(app.item);
  assert.equal(app.props.transferQueue[0].status, "needs_user_action");
  assert.equal(app.props.transferQueue[0].progress.completedBytes, chunkSize);
  assert.equal(app.props.transferQueue[0].progress.percentage, chunkSize / (chunkSize + 1) * 100);
  const chunksBeforeResume = app.calls.filter((call) => call.command === "api_upload_chunk").map(call => call.args.offset);
  assert.deepEqual(chunksBeforeResume, [0, chunkSize]);
  failTail = false;
  app.render().retryDesktopQueueItem(app.props.transferQueue[0]);
  await app.settle();
  assert.equal(app.props.transferQueue[0].status, "completed");
  const allChunkOffsets = app.calls.filter((call) => call.command === "api_upload_chunk").map(call => call.args.offset);
  assert.deepEqual(allChunkOffsets, [0, chunkSize, chunkSize]);
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

test("unmount releases chunk progress listeners and queued retry timers", async () => {
  const upload = deferred();
  const app = harness(command => command === "api_upload_chunk" ? upload.promise : undefined, { sourceSize: 4 });
  const running = app.render().runQueuedUpload(app.item);
  for (let attempt = 0; attempt < 20 && !app.calls.some((call) => call.command === "api_upload_chunk"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(app.listeners.size, 1);
  app.driver.unmount();
  upload.resolve(nativeJson({ uploadedOffset: 4, size: 4, status: "uploading" }, 200));
  await running;
  assert.equal(app.timers.size, 0);
  assert.equal(app.listeners.size, 0);
});

test("SFTP upload still uses its existing native command, without API sessions", async () => {
  const app = harness(); await app.render().runQueuedSshUpload({ ...app.item, sshEntryId: "ssh" }, { id: "ssh" });
  assert.deepEqual(app.calls.map((call) => call.command), ["ssh_upload_path"]);
});

test("late native chunk progress is attempt-scoped and cannot overwrite cancellation settlement", async () => {
  const upload = deferred();
  const app = harness((command, args, backend) => command === "api_upload_chunk" ? upload.promise :
    command === "api_request" && args.url.endsWith("/cancel") ? (() => { backend.session.status = "cancelled"; return nativeJson({ status: "cancelled" }); })() : undefined, { sourceSize: 100 });
  const running = app.render().runQueuedUpload(app.item);
  for (let attempt = 0; attempt < 20 && !app.calls.some((call) => call.command === "api_upload_chunk"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const callback = app.listeners.get("upload-progress");
  const transferId = app.calls.find((call) => call.command === "api_upload_chunk").args.transferId;
  callback({ payload: { transferId: "old-attempt", bytesCompleted: 999, bytesTotal: 999 } });
  assert.equal(app.props.transferQueue[0].progress.completedBytes, 0);
  callback({ payload: { transferId, bytesCompleted: 12, bytesTotal: 100 } });
  assert.equal(app.props.transferQueue[0].progress.completedBytes, 12);
  app.render().cancelQueueItem(app.item.id);
  upload.resolve(nativeJson({ error: { message: "cancelled" } }, 409)); await running;
  const terminal = JSON.stringify(app.props.transferQueue[0]);
  callback({ payload: { transferId, bytesCompleted: 100, bytesTotal: 100 } });
  assert.equal(JSON.stringify(app.props.transferQueue[0]), terminal);
});

test("zero-byte resumable upload reports measured zero and settles by server completion", async () => {
  const app = harness();
  await app.render().runQueuedUpload(app.item);
  assert.equal(app.props.transferQueue[0].progress.totalBytes, 0);
  assert.equal(app.props.transferQueue[0].progress.completedBytes, 0);
  assert.equal(app.props.transferQueue[0].progress.percentage, 100);
  assert.equal(app.props.transferQueue[0].status, "completed");
});

test("restored accepted uploads cannot be rebound and uploaded under the new login", () => {
  const app = harness();
  const restored = { ...app.item, status: "needs_user_action", serverBatchId: "batch-A", uploadOutcome: "reconcile" };
  app.props.transferQueue = [restored];
  app.render().retryDesktopQueueItem(restored);
  assert.equal(app.calls.length, 0);
  assert.match(app.props.notice, /original upload session is unavailable/i);
});
