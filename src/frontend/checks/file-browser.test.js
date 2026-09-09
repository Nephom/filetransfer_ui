const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const { publicDirectory, checkBrowserBuild, buildBrowser } = require('../../../scripts/build-browser');

function loadSource(relative) {
    const filename = path.resolve(__dirname, relative);
    const result = esbuild.buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', loader: { '.js': 'jsx' }, write: false });
    const module = new Module(filename);
    module.paths = Module._nodeModulePaths(path.dirname(filename));
    module._compile(result.outputFiles[0].text, filename);
    return module.exports;
}
const { deleteGroups, sortFiles, createRequestGate } = loadSource('../public/components/FileBrowser.js');
const { virtualRange } = loadSource('../public/components/VirtualFileList.js');

test('delete identities retain full paths and group legacy payloads by actual parent', () => {
    assert.deepEqual(deleteGroups([
        { name: 'same.txt', path: 'a/same.txt', isDirectory: false },
        { name: 'same.txt', path: 'b/same.txt', isDirectory: false },
        { name: 'other.txt', path: 'a/other.txt', isDirectory: false }
    ], 'unrelated'), [
        { currentPath: 'a', items: [{ name: 'same.txt', path: 'a/same.txt', isDirectory: false }, { name: 'other.txt', path: 'a/other.txt', isDirectory: false }] },
        { currentPath: 'b', items: [{ name: 'same.txt', path: 'b/same.txt', isDirectory: false }] }
    ]);
    assert.equal(deleteGroups([{ name: 'legacy' }], 'parent')[0].items[0].path, 'parent/legacy');
});

test('stable numeric sorting preserves source records and distinguishes duplicate basenames', () => {
    const records = [{ name: 'file10', path: 'z/file10' }, { name: 'file2', path: 'b/file2' }, { name: 'file2', path: 'a/file2' }];
    assert.deepEqual(sortFiles(records).map(file => file.path), ['a/file2', 'b/file2', 'z/file10']);
    assert.equal(records[0].name, 'file10');
    assert.equal(sortFiles([{ name: 'z', isDirectory: true }, { name: 'a' }], 'directory', 'desc')[0].name, 'z');
});

test('directory and search generations invalidate success, failure, selection and finalization together', () => {
    const gate = createRequestGate();
    const directory = gate.begin();
    const action = gate.capture();
    const search = gate.begin();
    assert.equal(directory.signal.aborted, true);
    assert.equal(directory.current(), false);
    assert.equal(action(), false);
    assert.equal(search.current(), true);
    gate.invalidate();
    assert.equal(search.signal.aborted, true);
    assert.equal(search.current(), false);
    assert.equal(gate.begin().current(), true);
});

test('virtual windows bound table nodes, clamp scroll, and handle empty and partial grid rows', () => {
    const table = virtualRange(10000, 1, 40, 600, 200000);
    assert.equal(table.start, 4996);
    assert.equal(table.end - table.start, 23);
    const grid = virtualRange(10000, 6, 162, 600, 200000);
    assert.ok(grid.end - grid.start <= 78);
    assert.equal(virtualRange(0, 1, 40, 600, 100).end, 0);
    const partial = virtualRange(11, 3, 162, 200, 999999);
    assert.equal(partial.rows, 4);
    assert.equal(partial.top, 448);
    assert.equal(virtualRange(11, 3, 162, 200, 999999, 4, 10).top, 438);
    assert.equal(partial.end, 11);
    assert.equal(virtualRange(11, 2, 162, 200, 999999).rows, 6);
});

test('readiness import has no CLI/build effects and uses no dev dependencies', () => {
    const output = execFileSync(process.execPath, ['-e', `const Module = require('module'); const original = Module._load; Module._load = function(name, ...args) { if (['esbuild', 'react', 'react-dom'].includes(name)) throw Error('runtime dev dependency'); return original.call(this, name, ...args); }; const api = require('./scripts/build-browser'); if (!require('path').isAbsolute(api.publicDirectory)) throw Error('relative path');`], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' });
    assert.equal(output, '');
});

test('readiness checks hashes and completeness without modifying artifacts', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-readiness-'));
    try {
        assert.throws(() => checkBrowserBuild(temporary), /npm run build:browser/);
        if (fs.existsSync(publicDirectory)) {
            const manifest = checkBrowserBuild();
            fs.cpSync(publicDirectory, temporary, { recursive: true });
            assert.deepEqual(checkBrowserBuild(temporary), manifest);
            fs.appendFileSync(path.join(temporary, manifest.entry), 'tampered');
            assert.throws(() => checkBrowserBuild(temporary), /invalid asset/);
        } else {
            throw new Error('Run npm run build:browser before readiness regression tests.');
        }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('shell entrypoints parse and check browser assets before restart kill', () => {
    const root = path.resolve(__dirname, '../../..');
    for (const file of ['build.sh', 'scripts/runtime.sh', 'start.sh', 'restart.sh']) execFileSync('bash', ['-n', path.join(root, file)]);
    const restart = fs.readFileSync(path.join(root, 'restart.sh'), 'utf8');
    assert.ok(restart.indexOf('check_browser_build || exit 1') < restart.indexOf('kill -TERM'));
    assert.doesNotMatch(restart, /npm run build:browser/);
});

test('failed compilation leaves the prior browser build ready', async () => {
    const previous = checkBrowserBuild();
    const load = Module._load;
    try {
        Module._load = function(name, ...args) {
            if (name === 'esbuild') return { build: async () => { throw new Error('fixture compilation failure'); } };
            return load.call(this, name, ...args);
        };
        await assert.rejects(buildBrowser(), /fixture compilation failure/);
        assert.deepEqual(checkBrowserBuild(), previous);
    } finally { Module._load = load; }
});

test('invalid replacement assets leave a test-owned running process untouched', async () => {
    const root = path.resolve(__dirname, '../../..');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-restart-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
        fs.mkdirSync(path.join(temporary, 'scripts'));
        for (const name of ['restart.sh', 'start.sh', 'scripts/runtime.sh', 'scripts/build-browser.js']) fs.copyFileSync(path.join(root, name), path.join(temporary, name));
        fs.writeFileSync(path.join(temporary, 'server.pid'), String(child.pid));
        for (const script of ['restart.sh', 'start.sh']) {
            const result = spawnSync('bash', [path.join(temporary, script)], { cwd: temporary, encoding: 'utf8', timeout: 5000 });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /npm run build:browser/);
            assert.equal(process.kill(child.pid, 0), true);
        }
        assert.equal(fs.existsSync(path.join(temporary, 'server.log')), false);
    } finally {
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

if (process.env.BROWSER_INSTALL_CHECK === '1') test('lockfile installs reproducibly in a disposable directory without lifecycle scripts', () => {
    const root = path.resolve(__dirname, '../../..');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-install-'));
    try {
        for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, name), path.join(temporary, name));
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
        execFileSync('npm', ['ci', '--ignore-scripts', '--include=dev', '--include=optional', '--no-audit', '--no-fund'], { cwd: temporary, env, timeout: 120000, stdio: 'pipe' });
        const localRequire = Module.createRequire(path.join(temporary, 'package.json'));
        assert.equal(localRequire('react/package.json').version, '18.3.1');
        assert.equal(localRequire('react-dom/package.json').version, '18.3.1');
        assert.equal(typeof localRequire('busboy'), 'function');
        assert.ok(localRequire('esbuild').transformSync('<div />', { loader: 'jsx' }).code.includes('createElement'));
        assert.equal(fs.readFileSync(path.join(temporary, 'package-lock.json'), 'utf8'), fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
