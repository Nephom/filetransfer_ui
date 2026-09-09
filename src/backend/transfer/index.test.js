const test = require('node:test');
const assert = require('node:assert/strict');
const { TransferManager } = require('./index');

const owner = { id: 'account-1', username: 'alice' };
const context = { owner, locationId: 'default', locationRevision: 'revision', path: 'folder', targetPath: '/fixture/folder' };

test('numeric owner IDs including admin zero stay immutable and never collide with string IDs', () => {
  const manager = new TransferManager();
  for (const id of [0, 7]) {
    const numeric = { ...context, owner: { id, username: `user-${id}` }, clientAttemptId: 'same-attempt' };
    const string = { ...numeric, owner: { ...numeric.owner, id: String(id) } };
    const batchId = manager.reserveBatch(numeric);
    assert.notEqual(manager.reserveBatch(string), batchId);
    assert.throws(() => manager.claimBatch(batchId, string), { statusCode: 409 });
    manager.claimBatch(batchId, numeric);
    const transferId = manager.startTransfer({ batchId, owner: string.owner });
    assert.deepEqual(manager.getTransfer(transferId).owner, numeric.owner);
    assert.equal(Reflect.set(manager.getTransfer(transferId).owner, 'id', String(id)), false);
    assert.equal(Reflect.set(manager.getTransfer(transferId), 'owner', string.owner), false);
    assert.equal(Reflect.set(manager.getBatch(batchId), 'locationId', 'other'), false);
  }
});

test('unknown, known, and zero-byte totals use measured bytes, never completion padding', () => {
  const manager = new TransferManager();
  const id = manager.startTransfer(context);
  manager.updateProgress(id, 7);
  assert.equal(manager.serializeTransfer(id).totalSize, 0);
  assert.equal(manager.serializeTransfer(id).totalSizeKnown, false);
  manager.updateProgress(id, 7, 10);
  manager.completeTransfer(id, { owner: { id: 'attacker' }, status: 'failed', file: { size: 999 } });
  const completed = manager.serializeTransfer(id);
  assert.equal(completed.transferredSize, 7);
  assert.equal(completed.progress, 70);
  assert.equal(completed.committedSize, 7);
  assert.equal(manager.getTransfer(id).owner.id, owner.id);
  const zero = manager.startTransfer({ ...context, totalSize: 0 });
  manager.completeTransfer(zero);
  assert.equal(manager.serializeTransfer(zero).progress, 100);
  assert.equal(manager.serializeTransfer(zero).transferredSize, 0);
  assert.equal(manager.serializeTransfer(zero).totalSizeKnown, true);
});

test('all pending children contribute to batch denominator and retain existing count names', () => {
  const manager = new TransferManager();
  const batchId = manager.createBatch({ ...context, totalFiles: 3 });
  const a = manager.startTransfer({ batchId, totalSize: 10 });
  assert.equal(manager.calculateBatchStats(batchId).pendingCount, 3);
  assert.equal(manager.calculateBatchStats(batchId).totalSize, 0);
  const b = manager.startTransfer({ batchId, totalSize: 30 });
  const c = manager.startTransfer({ batchId, totalSize: 0 });
  manager.sealBatch(batchId);
  manager.updateProgress(a, 10);
  manager.completeTransfer(a);
  manager.updateTransferStatus(b, 'processing');
  manager.failTransfer(c, new Error('/private/sentinel'));
  let stats = manager.serializeBatch(batchId);
  assert.equal(stats.totalSize, 40);
  assert.equal(stats.totalSizeKnown, true);
  assert.equal(stats.progress, 25);
  assert.equal(stats.pendingCount, 1);
  assert.equal(stats.successCount, 1);
  assert.equal(stats.failedCount, 1);
  manager.settleCancelledTransfer(b);
  manager.updateBatchProgress(batchId, { settled: true });
  stats = manager.serializeBatch(batchId);
  assert.equal(stats.cancelledCount, 1);
  assert.equal(stats.pendingCount, 0);
  assert.equal(stats.status, 'cancelled');
  assert.equal(stats.transferredSize, 10);
});

test('directory-only batches have known zero totals and explicit terminal settlement', () => {
  const manager = new TransferManager();
  const batchId = manager.createBatch(context);
  manager.sealBatch(batchId);
  manager.updateBatchProgress(batchId);
  assert.equal(manager.serializeBatch(batchId).status, 'uploading');
  manager.updateBatchProgress(batchId, { settled: true });
  const result = manager.serializeBatch(batchId);
  assert.equal(result.status, 'completed');
  assert.equal(result.totalSize, 0);
  assert.equal(result.totalSizeKnown, true);
  assert.equal(result.progress, 100);
});

test('reservation retry is bounded, owned, target-bound, single-use, and expires without polling renewal', () => {
  let now = 1;
  const manager = new TransferManager({ now: () => now, reservationMs: 10, maxReservations: 1 });
  const options = { ...context, clientAttemptId: 'attempt' };
  const id = manager.reserveBatch(options);
  assert.equal(manager.reserveBatch(options), id);
  assert.throws(() => manager.reserveBatch(context), { statusCode: 429 });
  assert.throws(() => manager.claimBatch(id, { ...context, owner: { ...owner, id: 'other' } }), { statusCode: 409 });
  assert.throws(() => manager.claimBatch(id, { ...context, locationRevision: 'changed' }), { statusCode: 409 });
  assert.throws(() => manager.claimBatch(id, { ...context, path: 'elsewhere' }), { statusCode: 409 });
  assert.equal(manager.serializeBatch(id).expiresAt, 11);
  now = 12;
  assert.equal(manager.serializeBatch(id).status, 'expired');
  assert.throws(() => manager.claimBatch(id, context), { statusCode: 409 });
  const next = manager.reserveBatch(context);
  manager.claimBatch(next, context);
  assert.throws(() => manager.claimBatch(next, context), { statusCode: 409 });
});

test('cancellation interrupts worker and waits for cleanup; repeated cancellation is idempotent', async () => {
  const manager = new TransferManager();
  const batchId = manager.createBatch(context);
  const id = manager.startTransfer({ batchId, totalSize: 12 });
  manager.sealBatch(batchId);
  const controller = new AbortController();
  let settle;
  const worker = new Promise(resolve => { settle = resolve; });
  manager.registerWorker(batchId, controller, worker, true);
  let resolved = false;
  const cancellation = manager.cancelBatch(batchId).then(() => { resolved = true; });
  const repeated = manager.cancelBatch(batchId);
  assert.equal(controller.signal.aborted, true);
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(manager.serializeBatch(batchId).status, 'cancelling');
  manager.updateProgress(id, 3);
  manager.settleCancelledTransfer(id);
  manager.updateBatchProgress(batchId, { settled: true });
  settle();
  await Promise.all([cancellation, repeated]);
  assert.equal(manager.serializeBatch(batchId).status, 'cancelled');
  assert.equal(manager.serializeBatch(batchId).transferredSize, 3);
});

test('completion wins a late cancellation and late progress/failure cannot alter terminal records', async () => {
  const manager = new TransferManager();
  const id = manager.startTransfer({ ...context, totalSize: 4 });
  manager.updateProgress(id, 4);
  manager.completeTransfer(id);
  const snapshot = manager.serializeTransfer(id);
  await manager.cancelTransfer(id);
  manager.updateProgress(id, 99, 99);
  manager.failTransfer(id, 'late error');
  manager.updateTransferStatus(id, 'uploading');
  assert.deepEqual(manager.serializeTransfer(id), snapshot);
  const cancelled = manager.startTransfer(context);
  manager.settleCancelledTransfer(cancelled);
  manager.completeTransfer(cancelled);
  assert.equal(manager.getTransfer(cancelled).status, 'cancelled');
});

test('unused reservations cancel immediately; uncontrolled active work never pretends to cancel', async () => {
  const manager = new TransferManager();
  const id = manager.reserveBatch(context);
  assert.equal((await manager.cancelBatch(id)).status, 'cancelled');
  const transfer = manager.startTransfer(context);
  assert.equal((await manager.cancelTransfer(transfer)).status, 'cancelling');
});

test('serializers expose only public fields and never raw paths, errors, identity, or controls', () => {
  const manager = new TransferManager();
  const batchId = manager.createBatch(context);
  const id = manager.startTransfer({ batchId, source: '/secret/staging', destination: '/secret/output', totalSize: 2, fileName: 'safe.txt' });
  manager.failTransfer(id, { message: '/secret/error', token: 'secret-token', stack: 'secret-stack' });
  const publicJson = JSON.stringify(manager.serializeBatch(batchId));
  for (const sentinel of ['secret', 'account-1', 'alice', 'revision', 'targetPath', 'source', 'destination', 'controller']) {
    assert.equal(publicJson.includes(sentinel), false, sentinel);
  }
  assert.equal(manager.serializeTransfer(id).error.code, 'UPLOAD_FAILED');
});

test('retention never fails idle active work, deletes active children, or removes unsettled workers', async () => {
  let now = 1;
  const manager = new TransferManager({ now: () => now });
  const batchId = manager.createBatch(context);
  const id = manager.startTransfer({ batchId, totalSize: 0 });
  let settle;
  const worker = new Promise(resolve => { settle = resolve; });
  manager.registerWorker(batchId, new AbortController(), worker, true);
  manager.sealBatch(batchId);
  manager.completeTransfer(id);
  now = 999999999;
  assert.deepEqual(manager.cleanup(1), { transfersRemoved: 0, batchesRemoved: 0 });
  assert.equal(manager.removeTransfer(id), false);
  manager.updateBatchProgress(batchId, { settled: true });
  now++;
  assert.deepEqual(manager.cleanup(1), { transfersRemoved: 0, batchesRemoved: 0 });
  settle();
  await worker;
  assert.deepEqual(manager.cleanup(1), { transfersRemoved: 1, batchesRemoved: 1 });
});
