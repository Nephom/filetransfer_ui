const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const buildDirectory = path.join(root, 'build-assets/browser');
const publicDirectory = path.join(buildDirectory, 'public');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Runtime imports use only Node built-ins. Build tools are development dependencies.
function checkBrowserBuild(directory = publicDirectory) {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
        if (manifest.version !== 1 || !/^app-[A-Z0-9]+\.js$/.test(manifest.entry)) throw new Error('invalid entry');
        const required = ['index.html', 'share.html', 'favicon.ico', manifest.entry];
        if (!manifest.files || required.some(name => !manifest.files[name])) throw new Error('incomplete manifest');
        if (Object.keys(manifest.files).some(name => !required.includes(name))) throw new Error('unexpected public asset');
        for (const [name, hash] of Object.entries(manifest.files)) {
            if (path.basename(name) !== name || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid manifest');
            const file = path.join(directory, name);
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || !stat.size || digest(fs.readFileSync(file)) !== hash) throw new Error(`invalid asset: ${name}`);
        }
        const allowed = new Set(['manifest.json', ...Object.keys(manifest.files)]);
        if (fs.readdirSync(directory).some(name => !allowed.has(name))) throw new Error('unexpected public asset');
        const index = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
        if (!index.includes(`src="/${manifest.entry}"`) || /text\/babel|react\.development|__BROWSER_ENTRY__/.test(index)) throw new Error('invalid index');
        return manifest;
    } catch (error) {
        throw new Error(`Browser build is missing or invalid (${error.message}). Run npm run build:browser.`);
    }
}

async function buildBrowser() {
    const esbuild = require('esbuild');
    const source = path.join(root, 'src/frontend/public');
    fs.mkdirSync(buildDirectory, { recursive: true });
    const staging = fs.mkdtempSync(path.join(buildDirectory, '.staging-'));
    const backup = path.join(buildDirectory, '.previous');
    try {
        const result = await esbuild.build({
            absWorkingDir: root, entryPoints: [path.join(source, 'app.js')], outdir: staging,
            entryNames: '[name]-[hash]', bundle: true, minify: true, format: 'esm',
            platform: 'browser', target: ['es2020'], loader: { '.js': 'jsx' },
            define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'eof', metafile: true
        });
        const entry = path.basename(Object.entries(result.metafile.outputs).find(([, info]) => info.entryPoint)[0]);
        fs.writeFileSync(path.join(staging, 'index.html'), fs.readFileSync(path.join(source, 'index.html'), 'utf8').replace('__BROWSER_ENTRY__', `/${entry}`));
        for (const name of ['share.html', 'favicon.ico']) fs.copyFileSync(path.join(source, name), path.join(staging, name));
        const files = Object.fromEntries(fs.readdirSync(staging).map(name => [name, digest(fs.readFileSync(path.join(staging, name)))]));
        fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ version: 1, entry, files }, null, 2));
        checkBrowserBuild(staging);
        fs.rmSync(backup, { recursive: true, force: true });
        if (fs.existsSync(publicDirectory)) fs.renameSync(publicDirectory, backup);
        try { fs.renameSync(staging, publicDirectory); }
        catch (error) {
            if (fs.existsSync(backup)) fs.renameSync(backup, publicDirectory);
            throw error;
        }
        fs.rmSync(backup, { recursive: true, force: true });
        return checkBrowserBuild();
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { publicDirectory, checkBrowserBuild, buildBrowser };
if (require.main === module) {
    Promise.resolve().then(() => {
        if (process.argv[2] === '--check') return checkBrowserBuild();
        if (process.argv.length > 2) throw new Error('Usage: node scripts/build-browser.js [--check]');
        return buildBrowser();
    }).then(manifest => console.log(`Browser build ready: ${manifest.entry}`))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
}
