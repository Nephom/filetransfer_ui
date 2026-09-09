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

test('assertCurrent never trusts an unresolved admin role', async () => {
  const manager = createManager();
  const staleAdmin = { id: 7, username: 'fixture-user', role: 'admin' };
  await assert.rejects(manager.assertCurrent(staleAdmin, 'team', 'write'), { statusCode: 503 });
  manager.setUserResolver(async (username) => ({
    id: 7, username, role: 'user', active: true, locationPermissions: { team: ['read'] }
  }));
  await manager.assertCurrent(staleAdmin, 'team', 'read');
  await assert.rejects(manager.assertCurrent(staleAdmin, 'team', 'write'), { statusCode: 403 });
  manager.setUserResolver(async () => ({ id: 0, username: 'fixture-admin', role: 'admin', active: true }));
  await assert.rejects(manager.assertCurrent({ id: 0, username: 'fixture-admin', role: 'admin' }, 'team', 'write'), { statusCode: 401 });
});

test('assertCurrent resolves configured admin identity and checks live revocation', async () => {
  const manager = createManager();
  let currentUser = { id: 0, username: 'fixture-admin', role: 'admin', active: true };
  manager.setAccountResolver(async (identity) => ({
    exists: identity.id === currentUser?.id && identity.username === currentUser?.username,
    active: currentUser?.active === true, role: currentUser?.role, user: currentUser
  }));
  const admin = { id: 0, username: 'fixture-admin' };
  await manager.assertCurrent(admin, 'team', 'write');
  for (const identity of [null, { role: 'admin' }, { ...admin, id: '0' }, { ...admin, id: 7 }]) {
    await assert.rejects(manager.assertCurrent(identity, 'team', 'write'), { statusCode: 401 });
  }
  const user = { id: 7, username: 'fixture-user', role: 'admin' };
  currentUser = { ...user, role: 'user', active: true, locationPermissions: { team: ['read'] } };
  await manager.assertCurrent(user, 'team', 'read');
  await assert.rejects(manager.assertCurrent(user, 'team', 'write'), { statusCode: 403 });
  currentUser.active = false;
  await assert.rejects(manager.assertCurrent(user, 'team', 'read'), { statusCode: 401 });
  currentUser = null;
  await assert.rejects(manager.assertCurrent(user, 'team', 'read'), { statusCode: 401 });
});

test('username resolver keeps its interface but rejects changed live identities', async () => {
  const manager = createManager();
  const user = { id: 7, username: 'fixture-user' };
  for (const replacement of [
    { ...user, id: 8 }, { ...user, username: 'other-user' }, { ...user, active: false }, null
  ]) {
    manager.setUserResolver(async (username) => {
      assert.equal(username, user.username);
      return replacement && { active: true, locationPermissions: { team: ['read'] }, ...replacement };
    });
    await assert.rejects(manager.assertCurrent(user, 'team', 'read'), { statusCode: 401 });
  }
});
