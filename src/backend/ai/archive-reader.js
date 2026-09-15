const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const tar = require('tar');
const yauzl = require('yauzl');
const { isTextEntry } = require('./chunker');

const fault = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const safeEntry = (name) => {
  const portable = name.replace(/\\/g, '/');
  if (!portable || portable.startsWith('/') || portable.split('/').includes('..') || /^[a-z]:/i.test(portable)) throw fault(400, `Unsafe archive entry: ${name}`);
  return portable;
};

async function readZip(filePath, limits, root) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      let fileCount = 0;
      let total = 0;
      const stop = (err) => { zip.close(); reject(err); };
      zip.readEntry();
      zip.on('entry', (entry) => {
        try {
          const name = safeEntry(entry.fileName);
          if (/\/$/.test(name)) return zip.readEntry();
          if (++fileCount > limits.maxArchiveFiles) return stop(fault(413, 'Archive contains too many files'));
          if (entry.uncompressedSize > limits.maxSingleExpandedFileBytes || (total += entry.uncompressedSize) > limits.maxArchiveExpandedBytes) return stop(fault(413, 'Archive exceeds the expansion limit'));
          if (!isTextEntry(name)) return zip.readEntry();
          zip.openReadStream(entry, async (streamError, stream) => {
            if (streamError) return stop(streamError);
            const chunks = [];
            let bytes = 0;
            stream.on('data', chunk => { bytes += chunk.length; chunks.push(chunk); });
            stream.on('error', stop);
            stream.on('end', async () => {
              try {
                const output = path.join(root, ...name.split('/'));
                await fsp.mkdir(path.dirname(output), { recursive: true });
                await fsp.writeFile(output, Buffer.concat(chunks));
                entries.push({ name, path: output, size: bytes });
                zip.readEntry();
              } catch (writeError) { stop(writeError); }
            });
          });
        } catch (entryError) { stop(entryError); }
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
    });
  });
}

async function readTar(filePath, limits, root) {
  const metadata = [];
  let fileCount = 0;
  let total = 0;
  await tar.t({ file: filePath, strict: true, onentry: entry => {
    const name = safeEntry(entry.path);
    if (entry.type !== 'File') return;
    if (++fileCount > limits.maxArchiveFiles) throw fault(413, 'Archive contains too many files');
    if (entry.size > limits.maxSingleExpandedFileBytes || (total += entry.size) > limits.maxArchiveExpandedBytes) throw fault(413, 'Archive exceeds the expansion limit');
    if (isTextEntry(name)) metadata.push({ name, size: entry.size });
  }});
  await tar.x({ file: filePath, cwd: root, strict: true, preservePaths: false, noChmod: true, filter: entryPath => {
    const name = safeEntry(entryPath);
    return isTextEntry(name);
  }});
  const result = [];
  for (const item of metadata) {
    const output = path.join(root, ...item.name.split('/'));
    const stat = await fsp.stat(output);
    result.push({ name: item.name, path: output, size: stat.size });
  }
  return result;
}

async function extractArchive(filePath, options = {}) {
  const limits = { maxArchiveFiles: 2000, maxArchiveExpandedBytes: 1073741824, maxSingleExpandedFileBytes: 104857600, ...options };
  const root = await fsp.mkdtemp(path.join(options.tempRoot || os.tmpdir(), 'filetransfer-ai-'));
  try {
    const entries = /\.zip$/i.test(filePath)
      ? await readZip(filePath, limits, root)
      : await readTar(filePath, limits, root);
    return { root, entries, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { extractArchive, safeEntry };
