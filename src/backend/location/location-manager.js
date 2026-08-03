const fs = require('node:fs').promises;
const path = require('node:path');

const LOCATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

class LocationManager {
  constructor(config, { fsModule = fs, cwd = process.cwd() } = {}) {
    this.config = config || {};
    this.fs = fsModule;
    this.cwd = cwd;
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

      return Object.freeze({
        id,
        displayName,
        rootPath: path.resolve(this.cwd, rootPath),
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
    if (candidate !== location.rootPath && !candidate.startsWith(`${location.rootPath}${path.sep}`)) {
      throw new Error('Path escapes the Location root');
    }
    return candidate;
  }

  async getHealth(locationId) {
    const location = this.getLocation(locationId);
    if (!location) throw new Error(`Unknown Location: ${locationId}`);
    if (!location.enabled) return { ...location, status: 'disabled' };

    try {
      const stats = await this.fs.stat(location.rootPath);
      if (!stats.isDirectory()) return { ...location, status: 'not_directory' };
      await this.fs.access(location.rootPath);
      return { ...location, status: 'healthy' };
    } catch (error) {
      const status = error.code === 'EACCES' || error.code === 'EPERM'
        ? 'permission_denied'
        : 'missing';
      return { ...location, status, errorCode: error.code };
    }
  }

  async getHealthStatuses() {
    return Promise.all(this.locations.map((location) => this.getHealth(location.id)));
  }
}

module.exports = LocationManager;
