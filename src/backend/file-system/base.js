const fs = require('node:fs').promises;
const path = require('node:path');
const { assertSafePath, assertSafeTree, assertTransferPaths, containsPath, pathError } = require('./path-safety');
const { withOperationLocks } = require('./operation-locks');

class LocalFileSystem {
  constructor({ storagePath } = {}) {
    this.storagePath = storagePath && path.resolve(storagePath);
    this.rootIdentity = null;
  }

  async checked(target, { allowMissing = true, external = false, protectRoot = false } = {}) {
    let root = this.storagePath;
    if (!root || external) root = path.parse(path.resolve(target)).root;
    const canonical = await fs.realpath(root);
    const stats = await fs.stat(canonical);
    if (this.storagePath && !external) {
      const identity = `${canonical}:${stats.dev}:${stats.ino}`;
      if (this.rootIdentity && this.rootIdentity !== identity) throw pathError('ESTALE', 'Location root identity changed');
      this.rootIdentity = identity;
    }
    const safe = await assertSafePath(root, target, { allowMissing });
    if (protectRoot && safe === canonical) throw pathError('EPERM', 'Cannot mutate a storage root');
    return safe;
  }

  async read(target) { return fs.readFile(await this.checked(target, { allowMissing: false })); }

  async write(target, content, options = {}) {
    return withOperationLocks([target], async () => {
      target = await this.checked(target, { protectRoot: true });
      await fs.writeFile(target, content, options);
    }, { signal: options.signal });
  }

  async delete(target) {
    return withOperationLocks([target], async () => {
      target = await this.checked(target, { allowMissing: false, protectRoot: true });
      const entries = await assertSafeTree(target);
      await withOperationLocks(entries.map(entry => entry.path), () => fs.rm(target, { recursive: true }));
    });
  }

  async list(target) {
    target = await this.checked(target, { allowMissing: false });
    return Promise.all((await fs.readdir(target)).map(async name => {
      const item = await this.checked(path.join(target, name), { allowMissing: false });
      const stats = await fs.lstat(item);
      return { name, path: item, isDirectory: stats.isDirectory(), size: stats.size, modified: stats.mtime.toISOString() };
    }));
  }

  async mkdir(target) {
    return withOperationLocks([target], async () => fs.mkdir(await this.checked(target), { recursive: true }));
  }

  async exists(target) {
    try {
      await this.checked(target, { allowMissing: false });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async stat(target) {
    const stats = await fs.lstat(await this.checked(target, { allowMissing: false }));
    return { size: stats.size, isFile: stats.isFile(), isDirectory: stats.isDirectory(), modified: stats.mtime, created: stats.birthtime };
  }

  async transferPaths(source, destination, moving = false) {
    // A destination filesystem also accepts a caller-authorized other Location
    // or trusted upload-temp source. It is still checked without following links.
    const external = this.storagePath && !containsPath(this.storagePath, path.resolve(source))
      && !containsPath(await fs.realpath(this.storagePath), path.resolve(source));
    source = await this.checked(source, { allowMissing: false, external, protectRoot: moving });
    destination = await this.checked(destination, { protectRoot: true });
    return assertTransferPaths(source, destination);
  }

  async rename(source, destination) {
    return withOperationLocks([source, destination], async () => {
      ({ source, destination } = await this.transferPaths(source, destination, true));
      const entries = await assertSafeTree(source);
      try { entries.push(...await assertSafeTree(destination)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await withOperationLocks(entries.map(entry => entry.path), () => fs.rename(source, destination));
    });
  }

  async copy(source, destination) {
    return withOperationLocks([source, destination], async () => {
      ({ source, destination } = await this.transferPaths(source, destination));
      const entries = await assertSafeTree(source);
      let destinationEntries = [];
      try { destinationEntries = await assertSafeTree(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Preflight every merge target, including hard-link aliases inside trees.
      const sourceIdentities = new Set(entries.map(({ stats }) => `${stats.dev}:${stats.ino}`));
      for (const entry of entries) {
        const target = path.join(destination, path.relative(source, entry.path));
        await this.checked(target);
        try {
          const stats = await fs.lstat(target);
          if (sourceIdentities.has(`${stats.dev}:${stats.ino}`)) throw pathError('EINVAL', 'Destination aliases a source object');
          if (stats.isDirectory() !== entry.stats.isDirectory()) throw pathError('EEXIST', 'Source and destination types differ');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await withOperationLocks([...entries, ...destinationEntries].map(entry => entry.path), async () => {
        for (const entry of entries) {
          const target = path.join(destination, path.relative(source, entry.path));
          if (entry.stats.isDirectory()) await fs.mkdir(target, { recursive: true });
          else await fs.copyFile(entry.path, target);
        }
      });
    });
  }

  async move(source, destination) {
    return withOperationLocks([source, destination], async () => {
      ({ source, destination } = await this.transferPaths(source, destination, true));
      try {
        await this.rename(source, destination);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await this.copy(source, destination);
        // The source may be outside this destination instance (staged uploads).
        if (this.storagePath && !containsPath(await fs.realpath(this.storagePath), source)) {
          await new LocalFileSystem().delete(source);
        } else await this.delete(source);
      }
    });
  }
}

class FileSystem {
  constructor(options = {}) {
    this.options = options;
    this.backend = this._initializeBackend();
  }
  _initializeBackend() { return new LocalFileSystem(this.options); }
  async read(target) { return this.backend.read(target); }
  async write(target, content, options = {}) { return this.backend.write(target, content, options); }
  async delete(target) { return this.backend.delete(target); }
  async list(target) { return this.backend.list(target); }
  async mkdir(target) { return this.backend.mkdir(target); }
  async exists(target) { return this.backend.exists(target); }
  async stat(target) { return this.backend.stat(target); }
  async rename(source, destination) { return this.backend.rename(source, destination); }
  async copy(source, destination) { return this.backend.copy(source, destination); }
  async move(source, destination) { return this.backend.move(source, destination); }
}

module.exports = { FileSystem, LocalFileSystem };
