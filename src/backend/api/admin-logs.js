const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const readline = require('node:readline');
const { requireAdmin } = require('../middleware/auth');
const { systemLogger, redactLogData, redactUrl } = require('../utils/logger');

const USER_KEY_PREFIX = 'u-';
const ANONYMOUS_USER_KEY = 'anonymous';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const redactData = typeof redactLogData === 'function' ? redactLogData : value => value;
const redactRequest = typeof redactUrl === 'function' ? redactUrl : value => String(value ?? '');

const encodeUserKey = username => username === null
  ? ANONYMOUS_USER_KEY
  : `${USER_KEY_PREFIX}${Buffer.from(username, 'utf8').toString('base64url')}`;

const decodeUserKey = value => {
  if (value === ANONYMOUS_USER_KEY) return { valid: true, username: null };
  if (typeof value !== 'string' || !value.startsWith(USER_KEY_PREFIX) || !/^[A-Za-z0-9_-]+$/.test(value.slice(USER_KEY_PREFIX.length))) {
    return { valid: false };
  }
  try {
    const username = Buffer.from(value.slice(USER_KEY_PREFIX.length), 'base64url').toString('utf8');
    return encodeUserKey(username) === value ? { valid: true, username } : { valid: false };
  } catch {
    return { valid: false };
  }
};

const ipFromLogFilename = filename => {
  const match = /^(\d{1,3}(?:_\d{1,3}){3})\.log$/.exec(filename);
  if (!match) return null;
  const ip = match[1].replace(/_/g, '.');
  return net.isIP(ip) === 4 ? ip : null;
};

const parseLogEntry = (line, sequence, redact = redactData, redactRequestUrl = redactRequest) => {
  const match = /^\[([^\]]+)\]\s+\[([A-Z]+)\]\s+(.*)$/.exec(line);
  if (!match) return null;

  const [, timestamp, level, payload] = match;
  const urlMarker = ' | URL: ';
  const urlIndex = payload.lastIndexOf(urlMarker);
  const message = urlIndex < 0 ? payload : payload.slice(0, urlIndex);
  const requestMetadata = urlIndex < 0 ? '' : payload.slice(urlIndex + urlMarker.length);

  let username = null;
  const requestUser = /(?:^|\s\|\s)User:\s*(.+?)(?:\s+\((?:admin|superuser|user)\))?$/.exec(requestMetadata);
  if (requestUser) {
    username = requestUser[1].trim();
  } else {
    const authUser = /^AUTH\s+[^\s]+\s+-\s+User:\s*(.*?),\s*Status:/i.exec(message);
    if (authUser) username = authUser[1].trim();
  }

  let operation = message;
  if (/^AUTH\s+/i.test(operation)) {
    operation = operation.replace(/^(AUTH\s+[^\s]+\s+-\s+)User:\s*.*?,\s*(Status:)/i, '$1$2');
  }
  operation = String(redact(operation) ?? '').replace(/[\r\n]/g, ' ').trim();

  const requestUrlMatch = /^([A-Z]+)\s+(.+?)(?=\s+\|\s+(?:User-Agent|User):|$)/.exec(requestMetadata);
  if (requestUrlMatch) {
    const [, method, url] = requestUrlMatch;
    const safeUrl = String(redactRequestUrl(url));
    if (safeUrl) operation = `${operation} · ${method} ${safeUrl}`;
  }

  const operationType = normalizeOperation(message);
  return {
    sequence,
    timestamp,
    level,
    username: username || null,
    operationType,
    operation: String(redact(operation) ?? '').replace(/[\r\n]/g, ' ').trim()
  };
};

const normalizeOperation = message => {
  const patterns = [
    /^(?:FILE|API|CACHE|SECURITY)\s+([A-Z][A-Z0-9_]*)\b/i,
    /^AUTH\s+([A-Z][A-Z0-9_]*)\b/i,
    /^(UPLOAD|DOWNLOAD)\b/i,
    /^BATCH\s+UPLOAD\s+SUMMARY\b/i,
    /^SESSION\s+(START|END)\b/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match) {
      if (/^BATCH\s+UPLOAD/i.test(message)) return 'UPLOAD';
      if (/^SESSION\s+/i.test(message)) return match[1].toUpperCase();
      return match[1].toUpperCase();
    }
  }
  const fallback = /^([A-Z][A-Z0-9_]*)\b/i.exec(message);
  return fallback ? fallback[1].toUpperCase() : 'OTHER';
};

const validDateFilter = value => {
  if (value === undefined || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};

const parseFilters = query => {
  const from = query.from === '' ? undefined : query.from;
  const to = query.to === '' ? undefined : query.to;
  if (!validDateFilter(from) || !validDateFilter(to)) return null;
  if (from && to && from > to) return null;
  let operation = query.operation;
  if (operation === '') operation = undefined;
  if (operation !== undefined) {
    if (typeof operation !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(operation)) return null;
    operation = operation.toUpperCase();
  }
  return { from, to, operation };
};

const matchesFilters = (record, filters) => {
  const date = record.timestamp.slice(0, 10);
  return (!filters.from || date >= filters.from) &&
    (!filters.to || date <= filters.to) &&
    (!filters.operation || record.operationType === filters.operation);
};

const createAdminLogsRouter = (options = {}) => {
  const router = express.Router();
  const configuredLogsDir = options.logsDir || systemLogger.logsDir;
  const logsDir = path.resolve(typeof configuredLogsDir === 'string' && configuredLogsDir
    ? configuredLogsDir
    : path.join(__dirname, '../../../logs'));
  const fileSystem = options.fileSystem || fs;
  const auth = options.auth || requireAdmin;
  const redact = options.redact || redactData;
  const redactRequestUrl = options.redactUrl || redactRequest;
  let cachedIndex = null;

  const listLogFiles = async () => {
    let entries;
    try {
      entries = await fileSystem.promises.readdir(logsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    const files = [];
    for (const entry of entries) {
      const ip = ipFromLogFilename(entry.name);
      if (!ip || !entry.isFile()) continue;
      const filePath = path.join(logsDir, entry.name);
      try {
        const stats = await fileSystem.promises.lstat(filePath);
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        files.push({ ip, filename: entry.name, filePath, size: stats.size, modifiedAt: stats.mtimeMs });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    files.sort((left, right) => left.ip.localeCompare(right.ip));
    return files;
  };

  const forEachLine = async (file, visit) => {
    const flags = fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0);
    const input = fileSystem.createReadStream(file.filePath, { flags });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let sequence = 0;
    try {
      for await (const line of lines) {
        await visit(line, sequence++);
      }
    } finally {
      lines.close();
      input.destroy();
    }
  };

  const signatureOf = files => files.map(file => `${file.filename}:${file.size}:${file.modifiedAt}`).join('|');

  const getIndex = async () => {
    const files = await listLogFiles();
    const signature = signatureOf(files);
    if (cachedIndex?.signature === signature) return cachedIndex;

    const users = new Map();
    for (const file of files) {
      try {
        await forEachLine(file, line => {
          const record = parseLogEntry(line, 0, redact, redactRequestUrl);
          if (!record) return;
          const key = encodeUserKey(record.username);
          let user = users.get(key);
          if (!user) {
            user = { key, username: record.username, latestAt: record.timestamp, entryCount: 0, ips: new Map(), operations: new Set() };
            users.set(key, user);
          }
          user.entryCount += 1;
          user.operations.add(record.operationType);
          if (record.timestamp > user.latestAt) user.latestAt = record.timestamp;
          let ip = user.ips.get(file.ip);
          if (!ip) {
            ip = { ip: file.ip, latestAt: record.timestamp, entryCount: 0, operations: new Set() };
            user.ips.set(file.ip, ip);
          }
          ip.entryCount += 1;
          ip.operations.add(record.operationType);
          if (record.timestamp > ip.latestAt) ip.latestAt = record.timestamp;
        });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    cachedIndex = { signature, files, users };
    return cachedIndex;
  };

  const parseLimit = value => {
    if (value === undefined) return DEFAULT_PAGE_SIZE;
    const limit = Number(value);
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE ? limit : null;
  };

  const findFileForIp = async ip => {
    if (typeof ip !== 'string' || net.isIP(ip) !== 4) return null;
    const filename = `${ip.replace(/\./g, '_')}.log`;
    const files = await listLogFiles();
    return files.find(file => file.filename === filename) || null;
  };

  router.get('/users', auth, async (req, res) => {
    try {
      const { users } = await getIndex();
      const result = [...users.values()]
        .map(user => ({
          key: user.key,
          username: user.username,
          latestAt: user.latestAt,
          entryCount: user.entryCount,
          ipCount: user.ips.size
        }))
        .sort((left, right) => right.latestAt.localeCompare(left.latestAt) ||
          String(left.username || '').localeCompare(String(right.username || '')));
      res.set('Cache-Control', 'no-store').json({ users: result });
    } catch (error) {
      res.status(500).json({ error: 'Unable to read user logs.' });
    }
  });

  router.get('/ips', auth, async (req, res) => {
    const decoded = decodeUserKey(req.query.user);
    if (!decoded.valid) return res.status(400).json({ error: 'Invalid log user.' });
    const filters = parseFilters(req.query);
    if (!filters) return res.status(400).json({ error: 'Invalid date range or operation filter.' });
    try {
      const { users, files } = await getIndex();
      const user = users.get(encodeUserKey(decoded.username));
      let ipSummaries = [...(user?.ips.values() || [])];
      if (filters.from || filters.to || filters.operation) {
        const filtered = new Map();
        for (const file of files) {
          await forEachLine(file, (line, sequence) => {
            const record = parseLogEntry(line, sequence, redact, redactRequestUrl);
            if (!record || record.username !== decoded.username || !matchesFilters(record, filters)) return;
            let summary = filtered.get(file.ip);
            if (!summary) {
              summary = { ip: file.ip, latestAt: record.timestamp, entryCount: 0, operations: new Set() };
              filtered.set(file.ip, summary);
            }
            summary.entryCount += 1;
            summary.operations.add(record.operationType);
            if (record.timestamp > summary.latestAt) summary.latestAt = record.timestamp;
          });
        }
        ipSummaries = [...filtered.values()];
      }
      const ips = ipSummaries
        .map(summary => ({ ...summary, operations: [...summary.operations].sort() }))
        .sort((left, right) => right.latestAt.localeCompare(left.latestAt) || left.ip.localeCompare(right.ip));
      res.set('Cache-Control', 'no-store').json({
        username: decoded.username,
        ips,
        operations: [...(user?.operations || [])].sort()
      });
    } catch (error) {
      res.status(500).json({ error: 'Unable to read IP log summaries.' });
    }
  });

  router.get('/entries', auth, async (req, res) => {
    const decoded = decodeUserKey(req.query.user);
    if (!decoded.valid) return res.status(400).json({ error: 'Invalid log user.' });
    const { ip, before } = req.query;
    if (typeof ip !== 'string' || net.isIP(ip) !== 4) return res.status(400).json({ error: 'Invalid IPv4 address.' });
    const filters = parseFilters(req.query);
    if (!filters) return res.status(400).json({ error: 'Invalid date range or operation filter.' });
    const limit = parseLimit(req.query.limit);
    if (limit === null) return res.status(400).json({ error: `limit must be between 1 and ${MAX_PAGE_SIZE}.` });
    let cursor = Number.POSITIVE_INFINITY;
    if (before !== undefined) {
      cursor = Number(before);
      if (!Number.isSafeInteger(cursor) || cursor < 0) return res.status(400).json({ error: 'Invalid log cursor.' });
    }

    try {
      const file = await findFileForIp(ip);
      if (!file) return res.set('Cache-Control', 'no-store').json({ entries: [], hasMore: false, nextCursor: null });
      const window = [];
      await forEachLine(file, (line, sequence) => {
        if (sequence >= cursor) return;
        const record = parseLogEntry(line, sequence, redact, redactRequestUrl);
        if (!record || record.username !== decoded.username || !matchesFilters(record, filters)) return;
        window.push(record);
        if (window.length > limit + 1) window.shift();
      });

      const hasMore = window.length > limit;
      const entries = window.slice(-limit).reverse().map(({ sequence, timestamp, level, operation, operationType }) => ({
        sequence,
        timestamp,
        level,
        operationType,
        operation
      }));
      const nextCursor = hasMore && entries.length ? entries[entries.length - 1].sequence : null;
      res.set('Cache-Control', 'no-store').json({ entries, hasMore, nextCursor });
    } catch (error) {
      res.status(500).json({ error: 'Unable to read IP log entries.' });
    }
  });

  return router;
};

module.exports = createAdminLogsRouter();
module.exports.createAdminLogsRouter = createAdminLogsRouter;
module.exports.parseLogEntry = parseLogEntry;
module.exports.ipFromLogFilename = ipFromLogFilename;
module.exports.normalizeOperation = normalizeOperation;
module.exports.parseFilters = parseFilters;
