const fs = require('node:fs').promises;
const path = require('node:path');

const LOCATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

class LocationManager {
  constructor(config, { fsModule = fs, cwd = process.cwd(), platform = process.platform, mountInfoReader } = {}) {
    this.config = config || {};
    this.fs = fsModule;
    this.cwd = cwd;
    this.platform = platform;
    this.mountInfoReader = mountInfoReader || (fsModule.readFile ? (filePath, encoding) => fsModule.readFile(filePath, encoding) : null);
    this.locations = this._normalizeLocations();
  }

  _normalizeLocations() {
    const storagePath = this.config.fileSystem?.storagePath || './storage';
    const configuredLocations = this.config.fileSystem?.locations;
    const locations = configuredLocations === undefined
      ? [{
          id: 'default',
          displayName: 'Default',
          rootPath: storagePath,
          enabled: true,
          readOnly: false,
          order: 0
        }]
      : configuredLocations;

    if (!Array.isArray(locations) || locations.length === 0) {
      throw new Error('fileSystem.locations must be a non-empty array when configured');
    }

    const ids = new Set();
    return locations.map((location, index) => {
      if (!location || typeof location !== 'object') {
        throw new Error(`fileSystem.locations[${index}] must be an object`);
      }

      const id = String(location.id || '');
      if (!LOCATION_ID_PATTERN.test(id)) {
        throw new Error(`fileSystem.locations[${index}].id must be a stable opaque identifier`);
      }
      if (ids.has(id)) {
        throw new Error(`Duplicate Location id: ${id}`);
      }
      ids.add(id);

      const displayName = String(location.displayName || '').trim();
      if (!displayName) {
        throw new Error(`Location ${id} requires displayName`);
      }

      const rootPath = String(location.rootPath || '').trim();
      if (!rootPath) {
        throw new Error(`Location ${id} requires rootPath`);
      }

      const storageType = location.storageType || (this.config.fileSystem?.type === 'nfs' ? 'nfs' : 'local');
      if (!['local', 'nfs'].includes(storageType)) {
        throw new Error(`Location ${id} storageType must be local or nfs`);
      }

      return Object.freeze({
        id,
        displayName,
        rootPath: path.resolve(this.cwd, rootPath),
        storageType,
        enabled: location.enabled !== false,
        readOnly: location.readOnly === true,
        order: Number.isFinite(Number(location.order)) ? Number(location.order) : index
      });
    }).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  getLocations({ includeDisabled = true } = {}) {
    return this.locations.filter((location) => includeDisabled || location.enabled);
  }

  getPublicLocations({ includeDisabled = false } = {}) {
    return this.getLocations({ includeDisabled }).map(({ id, displayName, enabled, readOnly, order }) => ({
      id,
      displayName,
      enabled,
      readOnly,
      order
    }));
  }

  getLocation(locationId) {
    return this.locations.find((location) => location.id === locationId) || null;
  }

  getNamespace(locationId) {
    const location = this.getLocation(locationId);
    if (!location) throw new Error(`Unknown Location: ${locationId}`);
    return `location:${location.id}`;
  }

  resolveRelativePath(locationId, relativePath = '') {
    const location = this.getLocation(locationId);
    if (!location) throw new Error(`Unknown Location: ${locationId}`);
    const candidate = path.resolve(location.rootPath, relativePath);
    const relative = path.relative(location.rootPath, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Path escapes the Location root');
    }
    return candidate;
  }

  async getHealth(locationId) {
    const location = this.getLocation(locationId);
    if (!location) throw new Error(`Unknown Location: ${locationId}`);
    if (!location.enabled) return { ...location, status: 'disabled' };

    try {
      if (location.storageType === 'nfs' && !(await this.isMounted(location.rootPath))) {
        return { ...location, status: 'offline', errorCode: 'NOT_MOUNTED' };
      }
      const stats = await this.fs.stat(location.rootPath);
      if (!stats.isDirectory()) return { ...location, status: 'error', errorCode: 'ENOTDIR' };
      await this.fs.access(location.rootPath);
      return { ...location, status: 'online' };
    } catch (error) {
      const status = error.code === 'EACCES' || error.code === 'EPERM'
        ? 'permission_denied'
        : error.code === 'ENOENT' || error.code === 'ENOTDIR'
          ? 'offline'
          : 'error';
      return { ...location, status, errorCode: error.code };
    }
  }

  async isMounted(rootPath) {
    if (this.platform !== 'linux') return true;
    if (!this.mountInfoReader) return false;

    const mountInfo = await this.mountInfoReader('/proc/self/mountinfo', 'utf8');
    return mountInfo.split(/\r?\n/).some((line) => {
      const separator = line.indexOf(' - ');
      if (separator === -1) return false;
      const fields = line.slice(0, separator).split(' ');
      const filesystemType = line.slice(separator + 3).split(' ')[0];
      const mountPoint = fields[4];
      if (!mountPoint) return false;
      if (!['nfs', 'nfs4'].includes(filesystemType)) return false;
      return mountPoint.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))) === rootPath;
    });
  }

  async getHealthStatuses() {
    return Promise.all(this.locations.map((location) => this.getHealth(location.id)));
  }
}

module.exports = LocationManager;
