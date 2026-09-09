const fs = require('node:fs').promises;
const path = require('node:path');

function pathError(code, message) {
  const statusCode = ({ EACCES: 403, EPERM: 403, ELOOP: 403, ENOENT: 404,
    EINVAL: 409, EEXIST: 409, EDEADLK: 409, ESTALE: 409, ABORT_ERR: 409,
    ESHUTDOWN: 503, NOT_MOUNTED: 503, ENOTSUP: 400, ENOTDIR: 400 })[code] || 500;
  return Object.assign(new Error(message), { code, statusCode });
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Only the administrator-selected root may resolve through a symbolic link.
async function assertSafePath(rootPath, targetPath, { allowMissing = true } = {}) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const canonicalRoot = await fs.realpath(root);
  if (!(await fs.stat(canonicalRoot)).isDirectory()) throw pathError('ENOTDIR', 'Location root is not a directory');
  const relative = containsPath(root, target) ? path.relative(root, target)
    : containsPath(canonicalRoot, target) ? path.relative(canonicalRoot, target) : null;
  if (relative === null) throw pathError('EACCES', 'Path escapes the Location root');
  let current = canonicalRoot;
  const components = relative ? relative.split(path.sep) : [];
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return path.join(current, ...components.slice(i + 1));
      throw error;
    }
    if (stats.isSymbolicLink()) throw pathError('ELOOP', 'Symbolic links below the Location root are not allowed');
    if (i < components.length - 1 && !stats.isDirectory()) throw pathError('ENOTDIR', 'A path component is not a directory');
    // Normalize existing component spelling on case-insensitive filesystems.
    current = await fs.realpath(current);
  }
  return current;
}

// Returns a preflight manifest. Callers must not mutate until the entire walk succeeds.
async function assertSafeTree(targetPath) {
  const target = await assertSafePath(path.parse(path.resolve(targetPath)).root, targetPath, { allowMissing: false });
  const entries = [];
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) throw pathError('ELOOP', 'Recursive selections must not contain symbolic links');
    if (!stats.isDirectory() && !stats.isFile()) throw pathError('ENOTSUP', 'Only regular files and directories are supported');
    entries.push({ path: current, stats });
    if (stats.isDirectory()) {
      for (const name of await fs.readdir(current)) pending.push(path.join(current, name));
    }
  }
  return entries;
}

async function assertTransferPaths(source, destination) {
  source = await assertSafePath(path.parse(path.resolve(source)).root, source, { allowMissing: false });
  destination = await assertSafePath(path.parse(path.resolve(destination)).root, destination);
  if (containsPath(source, destination) || containsPath(destination, source)) {
    throw pathError('EINVAL', 'Transfer paths must not be equal or contain one another');
  }
  const sourceStats = await fs.lstat(source);
  let destinationStats;
  try { destinationStats = await fs.lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (destinationStats && sourceStats.dev === destinationStats.dev && sourceStats.ino === destinationStats.ino) {
    throw pathError('EINVAL', 'Transfer paths refer to the same physical object');
  }
  return { source, destination };
}

module.exports = { assertSafePath, assertSafeTree, assertTransferPaths, containsPath, pathError };
