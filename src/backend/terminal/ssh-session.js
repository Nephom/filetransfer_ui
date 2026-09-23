const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('ssh2');

const MAX_COLS = 400;
const MAX_ROWS = 200;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_INPUT_BYTES_PER_SECOND = 512 * 1024;
const MAX_OUTPUT_BUFFER_BYTES = 512 * 1024;
const ATTACH_TICKET_TTL_MS = 15 * 1000;
const RECONNECT_GRACE_MS = 5 * 1000;
const SESSION_TOMBSTONE_MS = 30 * 1000;
const WS_OPEN = 1;

const sessionError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const normaliseDimension = (value, fallback, maximum) => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= maximum ? numeric : fallback;
};
const dimensions = input => ({
  cols: normaliseDimension(input?.cols, 120, MAX_COLS),
  rows: normaliseDimension(input?.rows, 32, MAX_ROWS)
});

const publicSession = session => ({
  sessionId: session.id,
  targetId: session.targetId,
  sshStatus: session.sshStatus,
  transportStatus: session.transportStatus,
  error: session.error || null,
  reconnectDeadline: session.reconnectDeadline || null,
  hostKeyUpdated: Boolean(session.hostKeyUpdated)
});

class SshSessionManager {
  constructor({ targetStore, hostKeyStore, maxSessionsPerUser = 8, maxSessionsPerTarget = 4 } = {}) {
    this.targetStore = targetStore;
    this.hostKeyStore = hostKeyStore;
    this.maxSessionsPerUser = maxSessionsPerUser;
    this.maxSessionsPerTarget = maxSessionsPerTarget;
    this.sessions = new Map();
    this.tickets = new Map();
  }

  countSessions(predicate) {
    return [...this.sessions.values()].filter(session => !['disconnected', 'error'].includes(session.sshStatus) && predicate(session)).length;
  }

  buildClientConfig(session, target) {
    const config = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: 15 * 1000,
      keepaliveInterval: 10 * 1000,
      keepaliveCountMax: 3,
      hostVerifier: (key, verify) => {
        this.hostKeyStore.record({ userId: session.userId, target, key })
          .then(result => { session.hostKeyUpdated = Boolean(result.changed); verify(true); })
          .catch(() => verify(false));
      }
    };
    if (target.authType === 'private-key') {
      config.privateKey = target.privateKey;
      if (target.passphrase) config.passphrase = target.passphrase;
    } else if (target.authType === 'password') {
      config.password = target.password;
    } else {
      throw sessionError('Unsupported SSH authentication type.');
    }
    return config;
  }

  async connectClient(session, target, { openShell = true } = {}) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      let shellOpened = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        try { client.end(); } catch { /* The client may already be closed. */ }
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      client.on('error', error => {
        if (settled && session.id && this.sessions.has(session.id)) this.fail(session, error);
        else fail(error);
      });
      client.once('close', () => {
        if (!settled) fail(new Error('SSH connection closed before it was ready.'));
        else if (session.id && this.sessions.has(session.id) && !session.ended) this.remoteEnded(session);
      });
      client.once('ready', () => {
        if (!openShell) {
          settled = true;
          resolve(client);
          return;
        }
        client.shell({ cols: session.cols, rows: session.rows, term: 'xterm-256color' }, (error, stream) => {
          if (error) return fail(error);
          shellOpened = true;
          session.client = client;
          session.stream = stream;
          stream.on('data', data => this.forwardOutput(session, data));
          stream.stderr?.on('data', data => this.forwardOutput(session, data));
          stream.once('close', () => {
            if (!session.ended && shellOpened) this.remoteEnded(session);
          });
          settled = true;
          resolve(client);
        });
      });
      try { client.connect(this.buildClientConfig(session, target)); }
      catch (error) { fail(error); }
    });
  }

  async create(userId, targetId, input = {}) {
    const owner = String(userId);
    const target = await this.targetStore.get(owner, targetId, { secrets: true });
    if (!target) throw sessionError('SSH target was not found.', 404);
    if (this.countSessions(session => session.userId === owner) >= this.maxSessionsPerUser) throw sessionError('The user SSH session limit has been reached.', 429);
    if (this.countSessions(session => session.userId === owner && session.targetId === targetId) >= this.maxSessionsPerTarget) throw sessionError('The target SSH session limit has been reached.', 429);

    const session = {
      id: randomUUID(),
      userId: owner,
      targetId,
      target,
      ...dimensions(input),
      sshStatus: 'connecting',
      transportStatus: 'detached',
      reconnectDeadline: null,
      error: null,
      client: null,
      stream: null,
      socket: null,
      outputBuffer: [],
      outputBufferBytes: 0,
      inputWindowStarted: 0,
      inputWindowBytes: 0,
      graceTimer: null,
      initialAttachTimer: null,
      tombstoneTimer: null,
      hostKeyUpdated: false,
      ended: false
    };
    this.sessions.set(session.id, session);
    try {
      await this.connectClient(session, target);
      session.sshStatus = 'connected';
      await this.targetStore.markConnected(owner, targetId);
      const response = this.issueTicket(session);
      session.initialAttachTimer = setTimeout(() => {
        if (!session.ended && !session.socket && session.transportStatus === 'detached') this.finish(session, 'disconnected', 'Terminal attach timed out.');
      }, ATTACH_TICKET_TTL_MS);
      session.initialAttachTimer.unref?.();
      return response;
    } catch (error) {
      clearTimeout(session.initialAttachTimer);
      try { session.stream?.close(); } catch { /* Connection setup failed before channel cleanup. */ }
      try { session.client?.end(); } catch { /* Connection setup failed before client cleanup. */ }
      this.sessions.delete(session.id);
      session.ended = true;
      throw error;
    }
  }

  async testConnection(userId, targetId) {
    const owner = String(userId);
    const target = await this.targetStore.get(owner, targetId, { secrets: true });
    if (!target) throw sessionError('SSH target was not found.', 404);
    const probe = { id: `probe-${randomUUID()}`, userId: owner, targetId, cols: 120, rows: 32 };
    let client;
    try {
      client = await this.connectClient(probe, target, { openShell: false });
      await this.targetStore.markConnected(owner, targetId);
      return { success: true, hostKeyFingerprint: (await this.targetStore.get(owner, targetId))?.hostKeyFingerprint || null };
    } finally {
      try { client?.end(); } catch { /* Probe cleanup is best effort. */ }
    }
  }

  issueTicket(session) {
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ATTACH_TICKET_TTL_MS;
    this.tickets.set(ticket, { sessionId: session.id, userId: session.userId, targetId: session.targetId, expiresAt });
    const timer = setTimeout(() => this.tickets.delete(ticket), ATTACH_TICKET_TTL_MS);
    timer.unref?.();
    return { ...publicSession(session), attachTicket: ticket, attachTicketExpiresAt: expiresAt };
  }

  consumeTicket(sessionId, ticket) {
    const record = this.tickets.get(ticket);
    if (!record || record.sessionId !== sessionId || record.expiresAt <= Date.now()) {
      this.tickets.delete(ticket);
      throw sessionError('Terminal attach ticket is invalid or expired.', 401);
    }
    this.tickets.delete(ticket);
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== record.userId || session.targetId !== record.targetId || session.ended) throw sessionError('SSH session is unavailable.', 404);
    return session;
  }

  getOwned(userId, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== String(userId)) return null;
    return session;
  }

  status(userId, sessionId) {
    const session = this.getOwned(userId, sessionId);
    if (!session) return null;
    return publicSession(session);
  }

  attach(session, socket) {
    if (session.ended || session.sshStatus === 'disconnected' || session.sshStatus === 'error') throw sessionError('SSH session is not attachable.', 409);
    if (session.socket && session.socket.readyState === WS_OPEN) session.socket.close(1008, 'Terminal attached elsewhere');
    clearTimeout(session.graceTimer);
    session.graceTimer = null;
    clearTimeout(session.initialAttachTimer);
    session.initialAttachTimer = null;
    session.reconnectDeadline = null;
    session.socket = socket;
    session.transportStatus = 'attached';
    session.sshStatus = 'connected';
    this.sendStatus(session);
    for (const output of session.outputBuffer) if (socket.readyState === WS_OPEN) socket.send(output);
    session.outputBuffer = [];
    session.outputBufferBytes = 0;
    socket.on('message', (message, isBinary) => this.handleInput(session, socket, message, isBinary));
    socket.once('close', () => {
      if (session.socket !== socket || session.ended) return;
      session.socket = null;
      this.detach(session);
    });
    socket.once('error', () => {});
  }

  handleInput(session, socket, message, isBinary) {
    if (session.socket !== socket || session.ended || !session.stream?.writable) return;
    const value = Buffer.isBuffer(message) ? message : Buffer.from(String(message));
    if (value.length > MAX_INPUT_BYTES) return socket.close(1009, 'Terminal input is too large');
    const now = Date.now();
    if (now - session.inputWindowStarted >= 1000) {
      session.inputWindowStarted = now;
      session.inputWindowBytes = 0;
    }
    session.inputWindowBytes += value.length;
    if (session.inputWindowBytes > MAX_INPUT_BYTES_PER_SECOND) return socket.close(1009, 'Terminal input rate is too high');
    if (!isBinary && value[0] === 123) {
      try {
        const control = JSON.parse(value.toString('utf8'));
        if (control?.type === 'resize') {
          const next = dimensions(control);
          session.cols = next.cols;
          session.rows = next.rows;
          session.stream.setWindow(session.rows, session.cols, 0, 0);
          return;
        }
      } catch { /* Raw terminal input may begin with an opening brace. */ }
    }
    session.stream.write(value);
  }

  forwardOutput(session, data) {
    if (session.ended) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (session.socket?.readyState === WS_OPEN) {
      session.socket.send(chunk);
      return;
    }
    session.outputBuffer.push(chunk);
    session.outputBufferBytes += chunk.length;
    while (session.outputBufferBytes > MAX_OUTPUT_BUFFER_BYTES && session.outputBuffer.length) {
      session.outputBufferBytes -= session.outputBuffer.shift().length;
    }
  }

  sendStatus(session) {
    if (session.socket?.readyState === WS_OPEN) session.socket.send(JSON.stringify({ type: 'status', ...publicSession(session) }));
  }

  detach(session) {
    if (session.ended || !['connected', 'reconnecting'].includes(session.sshStatus)) return;
    session.transportStatus = 'detached';
    session.sshStatus = 'reconnecting';
    session.reconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
    this.sendStatus(session);
    clearTimeout(session.graceTimer);
    session.graceTimer = setTimeout(() => this.expireDetached(session), RECONNECT_GRACE_MS);
    session.graceTimer.unref?.();
  }

  expireDetached(session) {
    if (session.ended || session.transportStatus !== 'detached') return;
    this.finish(session, 'disconnected', 'Terminal reconnect grace period expired.');
  }

  remoteEnded(session) {
    if (session.ended) return;
    this.finish(session, 'disconnected', 'The remote SSH session ended.');
  }

  fail(session, error) {
    if (session.ended) return;
    this.finish(session, 'error', error?.message || 'SSH session failed.');
  }

  finish(session, status, error = null) {
    if (session.ended) return;
    session.sshStatus = status;
    session.transportStatus = 'detached';
    session.reconnectDeadline = null;
    session.error = error;
    session.ended = true;
    clearTimeout(session.graceTimer);
    clearTimeout(session.initialAttachTimer);
    if (session.socket?.readyState === WS_OPEN) {
      this.sendStatus(session);
      session.socket.close(1000, status === 'error' ? 'SSH session failed' : 'SSH session ended');
    }
    session.socket = null;
    try { session.stream?.close(); } catch { /* Channel may already be closed. */ }
    try { session.client?.end(); } catch { /* Client may already be closed. */ }
    session.stream = null;
    session.client = null;
    session.target = null;
    for (const [ticket, record] of this.tickets) if (record.sessionId === session.id) this.tickets.delete(ticket);
    clearTimeout(session.tombstoneTimer);
    session.tombstoneTimer = setTimeout(() => this.sessions.delete(session.id), SESSION_TOMBSTONE_MS);
    session.tombstoneTimer.unref?.();
  }

  async disconnect(userId, sessionId) {
    const session = this.getOwned(userId, sessionId);
    if (!session) return false;
    this.finish(session, 'disconnected', 'Disconnected by the user.');
    return true;
  }

  async closeTarget(userId, targetId) {
    for (const session of this.sessions.values()) {
      if (session.userId === String(userId) && session.targetId === targetId) this.finish(session, 'disconnected', 'The SSH target was deleted.');
    }
  }

  async closeAll() {
    for (const session of this.sessions.values()) this.finish(session, 'disconnected', 'The server is shutting down.');
    this.tickets.clear();
  }
}

module.exports = {
  ATTACH_TICKET_TTL_MS,
  MAX_COLS,
  MAX_ROWS,
  RECONNECT_GRACE_MS,
  SshSessionManager,
  dimensions,
  publicSession
};
