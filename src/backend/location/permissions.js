const CAPABILITIES = Object.freeze([
  'list',
  'read',
  'upload',
  'write',
  'delete',
  'rename',
  'mkdir',
  'copy',
  'move',
  'share'
]);

const CAPABILITY_ALIASES = Object.freeze({
  download: 'read',
  copy_move: 'copy'
});
const MUTATION_CAPABILITIES = new Set(['upload', 'write', 'delete', 'rename', 'mkdir', 'copy', 'move', 'share']);

class LocationPermissionManager {
  constructor(locationManager) {
    this.locationManager = locationManager;
    this.userResolver = null;
  }

  setUserResolver(userResolver) {
    this.userResolver = userResolver;
  }

  normalizeCapabilities(capabilities) {
    if (capabilities === 'all' || (Array.isArray(capabilities) && capabilities.includes('all'))) {
      return [...CAPABILITIES];
    }

    const values = Array.isArray(capabilities)
      ? capabilities
      : capabilities && typeof capabilities === 'object'
        ? Object.entries(capabilities).filter(([, allowed]) => allowed).map(([name]) => name)
        : [];

    return [...new Set(values
      .map((capability) => CAPABILITY_ALIASES[capability] || capability)
      .filter((capability) => CAPABILITIES.includes(capability)))];
  }

  getLocationPermissions(user) {
    if (user?.role === 'admin') {
      return Object.fromEntries(this.locationManager.getLocations({ includeDisabled: false })
        .map((location) => [location.id, [...CAPABILITIES]]));
    }

    const configured = user?.locationPermissions;
    if (configured && typeof configured === 'object') {
      return Object.fromEntries(Object.entries(configured)
        .map(([locationId, capabilities]) => [locationId, this.normalizeCapabilities(capabilities)]));
    }

    // Preserve legacy users during migration, but never grant new Locations implicitly.
    const legacyCapabilities = this.normalizeCapabilities(user?.permissions || ['read']);
    if (this.locationManager.getLocation('default')?.enabled) {
      return { default: legacyCapabilities.includes('list') ? legacyCapabilities : ['list', ...legacyCapabilities] };
    }
    return {};
  }

  can(user, locationId, capability) {
    const location = this.locationManager.getLocation(locationId);
    if (!location || !location.enabled) return false;
    if (location.readOnly && MUTATION_CAPABILITIES.has(capability)) return false;
    return this.getLocationPermissions(user)[locationId]?.includes(capability) === true;
  }

  assert(user, locationId, capability) {
    if (!this.can(user, locationId, capability)) {
      throw Object.assign(new Error('Location permission denied'), { statusCode: 403 });
    }
  }

  async assertCurrent(user, locationId, capability) {
    const currentUser = user?.role === 'admin' || !this.userResolver
      ? user
      : await this.userResolver(user.username) || user;
    this.assert(currentUser, locationId, capability);
  }

  validateMapping(mapping) {
    if (mapping === undefined) return undefined;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new Error('locationPermissions must be an object');
    }

    const normalized = {};
    for (const [locationId, capabilities] of Object.entries(mapping)) {
      if (!this.locationManager.getLocation(locationId)) {
        throw new Error(`Unknown Location in permission mapping: ${locationId}`);
      }
      normalized[locationId] = this.normalizeCapabilities(capabilities);
    }
    return normalized;
  }

  getPublicPermissions(user) {
    return this.getLocationPermissions(user);
  }

  getAccessibleLocations(user) {
    const permissions = this.getLocationPermissions(user);
    return this.locationManager.getLocations({ includeDisabled: false })
      .filter((location) => this.can(user, location.id, 'list'))
      .map(({ id, displayName, enabled, readOnly, order }) => ({
        id,
        displayName,
        enabled,
        readOnly,
        order,
        capabilities: permissions[id] || []
      }));
  }
}

module.exports = { CAPABILITIES, LocationPermissionManager };
