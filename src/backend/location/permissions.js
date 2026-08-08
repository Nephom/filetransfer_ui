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
    this.roleResolver = null;
  }

  setUserResolver(userResolver) {
    this.userResolver = userResolver;
  }

  // Resolver: (roleId) => Role | null. Lets a user's `roleId` supply a
  // shared, reusable Location permission matrix (see RoleManager) instead of
  // (or as a base for) their own ad-hoc `locationPermissions`.
  setRoleResolver(roleResolver) {
    this.roleResolver = roleResolver;
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

    // A role supplies a shared, reusable baseline matrix. Per-user
    // `locationPermissions` (if present) still override individual
    // Locations on top of the role, so an admin can grant a role for the
    // common case and hand-tune exceptions per user without touching the
    // shared role definition.
    const role = user?.roleId && this.roleResolver ? this.roleResolver(user.roleId) : null;
    const roleBase = role?.locationPermissions && typeof role.locationPermissions === 'object'
      ? Object.fromEntries(Object.entries(role.locationPermissions)
          .map(([locationId, capabilities]) => [locationId, this.normalizeCapabilities(capabilities)]))
      : null;

    const configured = user?.locationPermissions;
    const userOverrides = configured && typeof configured === 'object'
      ? Object.fromEntries(Object.entries(configured)
          .map(([locationId, capabilities]) => [locationId, this.normalizeCapabilities(capabilities)]))
      : null;

    if (roleBase || userOverrides) {
      return { ...(roleBase || {}), ...(userOverrides || {}) };
    }

    // Preserve legacy users during migration, but never grant new Locations implicitly.
    const legacyCapabilities = this.normalizeCapabilities(user?.permissions || ['read']);
    // Legacy users previously had normal folder operations; keep mkdir available
    // until an explicit per-Location permission mapping is configured.
    if (!legacyCapabilities.includes('mkdir')) legacyCapabilities.push('mkdir');
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
    const location = this.locationManager.getLocation(locationId);
    const label = location ? `${location.displayName} (${location.id})` : locationId;
    if (!location || !location.enabled) {
      throw Object.assign(new Error(`Location ${label} is unavailable.`), { statusCode: 404 });
    }
    if (location.readOnly && MUTATION_CAPABILITIES.has(capability)) {
      throw Object.assign(new Error(`permission denied: Location ${label} is read-only; ${capability} operations are not allowed.`), { statusCode: 403 });
    }
    if (!this.getLocationPermissions(user)[locationId]?.includes(capability)) {
      throw Object.assign(new Error(`permission denied: ${capability} permission is not granted for Location ${label}.`), { statusCode: 403 });
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
