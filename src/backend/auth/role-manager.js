const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { systemLogger } = require('../utils/logger');
const { CAPABILITIES } = require('../location/permissions');

// A Role is a named, reusable permission matrix: { locationId: capabilities[] }.
// Users reference a role via `roleId`; LocationPermissionManager resolves the
// role's matrix as the user's base grants, while any per-user
// `locationPermissions` entries still override individual Locations (so a
// role gives a baseline that can be fine-tuned per user without editing the
// shared role).
class RoleManager {
  constructor() {
    this.rolesFilePath = process.env.ROLES_FILE_PATH || path.join(__dirname, '../../roles.json');
    this.roles = new Map();
    this.initialized = false;
    this.locationPermissionManager = null;
  }

  // Injected so role capability lists can be validated/normalized against
  // the same CAPABILITIES/alias rules used everywhere else, and so we can
  // confirm a Location ID actually exists before saving it into a role.
  setLocationPermissionManager(manager) {
    this.locationPermissionManager = manager;
  }

  async initialize() {
    try {
      await this.loadRoles();
      this.initialized = true;
      systemLogger.logSystem('INFO', `Role manager initialized with ${this.roles.size} role(s)`);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to initialize role manager: ${error.message}`);
      this.initialized = true;
    }
  }

  async loadRoles() {
    try {
      const data = await fs.readFile(this.rolesFilePath, 'utf8');
      const roleData = JSON.parse(data);
      this.roles.clear();
      (roleData.roles || []).forEach((role) => this.roles.set(role.id, role));
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.roles.clear();
        await this.saveRoles();
      } else {
        systemLogger.logSystem('WARN', `Error loading roles file: ${error.message}`);
        this.roles.clear();
      }
    }
  }

  async saveRoles() {
    try {
      const roleData = {
        lastUpdated: new Date().toISOString(),
        roles: Array.from(this.roles.values())
      };
      await fs.writeFile(this.rolesFilePath, JSON.stringify(roleData, null, 2));
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to save roles: ${error.message}`);
      throw new Error('Failed to save role data');
    }
  }

  normalizeLocationPermissions(locationPermissions) {
    if (locationPermissions === undefined || locationPermissions === null) return {};
    if (typeof locationPermissions !== 'object' || Array.isArray(locationPermissions)) {
      throw new Error('locationPermissions must be an object of { locationId: capabilities[] }');
    }

    // Prefer the shared validator (also checks the Location actually exists);
    // fall back to plain capability normalization if it isn't wired yet.
    if (this.locationPermissionManager) {
      return this.locationPermissionManager.validateMapping(locationPermissions) || {};
    }

    const normalized = {};
    for (const [locationId, capabilities] of Object.entries(locationPermissions)) {
      const values = Array.isArray(capabilities) ? capabilities : [];
      normalized[locationId] = [...new Set(values.filter((capability) => CAPABILITIES.includes(capability)))];
    }
    return normalized;
  }

  async createRole({ name, description, locationPermissions }) {
    if (!this.initialized) throw new Error('Role manager not initialized');

    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw new Error('Role name is required');
    if (Array.from(this.roles.values()).some((role) => role.name.toLowerCase() === trimmedName.toLowerCase())) {
      throw new Error(`Role '${trimmedName}' already exists`);
    }

    const normalized = this.normalizeLocationPermissions(locationPermissions);

    const role = {
      id: crypto.randomUUID(),
      name: trimmedName,
      description: String(description || '').trim(),
      locationPermissions: normalized,
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };

    this.roles.set(role.id, role);
    await this.saveRoles();
    return role;
  }

  async updateRole(id, updates) {
    if (!this.initialized) throw new Error('Role manager not initialized');

    const role = this.roles.get(id);
    if (!role) throw new Error(`Role '${id}' not found`);

    const next = { ...role };

    if (updates.name !== undefined) {
      const trimmedName = String(updates.name || '').trim();
      if (!trimmedName) throw new Error('Role name is required');
      if (Array.from(this.roles.values()).some((other) => other.id !== id && other.name.toLowerCase() === trimmedName.toLowerCase())) {
        throw new Error(`Role '${trimmedName}' already exists`);
      }
      next.name = trimmedName;
    }

    if (updates.description !== undefined) next.description = String(updates.description || '').trim();
    if (updates.locationPermissions !== undefined) next.locationPermissions = this.normalizeLocationPermissions(updates.locationPermissions);

    next.updated = new Date().toISOString();
    this.roles.set(id, next);
    await this.saveRoles();
    return next;
  }

  async deleteRole(id) {
    if (!this.initialized) throw new Error('Role manager not initialized');
    if (!this.roles.has(id)) throw new Error(`Role '${id}' not found`);
    this.roles.delete(id);
    await this.saveRoles();
    return { message: 'Role deleted successfully' };
  }

  getRole(id) {
    if (!id) return null;
    return this.roles.get(id) || null;
  }

  getAllRoles() {
    return Array.from(this.roles.values());
  }
}

module.exports = RoleManager;
