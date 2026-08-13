const test = require('node:test');
const assert = require('node:assert/strict');
const { LocationPermissionManager, CAPABILITIES } = require('./permissions');

function createManager(locations = [{ id: 'team', displayName: 'Team', enabled: true, readOnly: false }]) {
  const locationManager = {
    getLocation: (id) => locations.find((location) => location.id === id),
    getLocations: () => locations
  };
  return new LocationPermissionManager(locationManager);
}

test('normalizes aliases and composite copy/move dependencies', () => {
  const manager = createManager();
  assert.deepEqual(manager.normalizeCapabilities(['download', 'copy_move']), ['read', 'copy', 'write', 'delete']);
});

test('uses a Permission Role as the base and user mapping as the per-location override', () => {
  const manager = createManager([
    { id: 'team', displayName: 'Team', enabled: true, readOnly: false },
    { id: 'archive', displayName: 'Archive', enabled: true, readOnly: false }
  ]);
  manager.setRoleResolver(() => ({ locationPermissions: { team: ['list', 'read'], archive: ['list'] } }));

  assert.deepEqual(manager.getLocationPermissions({
    roleId: 'editor',
    locationPermissions: { team: ['list', 'read', 'write'] }
  }), {
    team: ['list', 'read', 'write'],
    archive: ['list']
  });
});

test('falls back to legacy global permissions only for the default location', () => {
  const manager = createManager([{ id: 'default', displayName: 'Default', enabled: true, readOnly: false }]);
  assert.deepEqual(manager.getLocationPermissions({ permissions: ['list', 'read'] }), { default: ['list', 'read'] });
});

test('read-only locations reject mutation capabilities', () => {
  const manager = createManager([{ id: 'archive', displayName: 'Archive', enabled: true, readOnly: true }]);
  const user = { locationPermissions: { archive: CAPABILITIES } };
  assert.equal(manager.can(user, 'archive', 'read'), true);
  assert.equal(manager.can(user, 'archive', 'write'), false);
  assert.throws(() => manager.assert(user, 'archive', 'write'), /read-only/);
});

test('rejects unknown locations in permission mappings', () => {
  const manager = createManager();
  assert.throws(() => manager.validateMapping({ missing: ['read'] }), /Unknown Location in permission mapping: missing/);
});
