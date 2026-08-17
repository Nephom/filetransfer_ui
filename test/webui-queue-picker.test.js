const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sourcePath = path.join(__dirname, '..', 'src', 'frontend', 'public', 'components', 'FileBrowser.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const queueStart = source.indexOf('const enqueueQueueDownload = async (items) => {');
const queueEnd = source.indexOf('    const cancelQueueItem =', queueStart);
const queueSource = source.slice(queueStart, queueEnd);

test('WebUI queue requests a writable directory before flattening files', () => {
    const pickerIndex = queueSource.indexOf('window.showDirectoryPicker({ mode: \'readwrite\', startIn: \'downloads\' })');
    const flattenIndex = queueSource.indexOf("fetch('/api/files/flatten'");

    assert.notEqual(queueStart, -1);
    assert.notEqual(pickerIndex, -1);
    assert.notEqual(flattenIndex, -1);
    assert.ok(pickerIndex < flattenIndex);
});

test('WebUI queue preserves picker permission errors', () => {
    assert.match(source, /NotAllowedError.*SecurityError/);
    assert.match(source, /Destination folder permission was denied by the browser/);
    assert.doesNotMatch(queueSource, /throw new Error\('Destination folder selection was cancelled\.'\)/);
});
