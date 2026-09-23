const express = require('express');
const { URL } = require('node:url');
const { WebSocketServer } = require('ws');
const { authenticate } = require('../middleware/auth');
const { MAX_COLS, MAX_ROWS } = require('../terminal/ssh-session');

const currentUserId = req => req.user?.id === undefined || req.user?.id === null ? null : String(req.user.id);
const sendError = (res, error, fallback) => {
  const candidate = Number(error?.statusCode);
  const status = (candidate >= 400 && candidate < 500) || candidate === 503 ? candidate : 500;
  res.status(status).json({ error: status >= 500 ? fallback : error.message });
};
const validDimension = (value, maximum) => value === undefined || (Number.isInteger(value) && value >= 1 && value <= maximum);

const createTerminalSessionRouter = ({ sessionManager, auth = authenticate } = {}) => {
  const router = express.Router();

  router.post('/terminal/sessions', auth, async (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    if (typeof req.body?.targetId !== 'string' || !req.body.targetId) return res.status(400).json({ error: 'targetId is required.' });
    if (!validDimension(req.body?.cols, MAX_COLS) || !validDimension(req.body?.rows, MAX_ROWS)) return res.status(400).json({ error: 'Terminal dimensions are invalid.' });
    try {
      res.status(201).json({ session: await sessionManager.create(userId, req.body.targetId, req.body) });
    } catch (error) { sendError(res, error, 'Unable to create SSH session.'); }
  });

  router.get('/terminal/sessions/:id', auth, (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    const session = sessionManager.status(userId, req.params.id);
    if (!session) return res.status(404).json({ error: 'SSH session was not found.' });
    res.set('Cache-Control', 'no-store');
    res.json({ session });
  });

  router.post('/terminal/sessions/:id/attach', auth, (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    try {
      const session = sessionManager.getOwned(userId, req.params.id);
      if (!session) return res.status(404).json({ error: 'SSH session was not found.' });
      if (session.ended || session.sshStatus === 'disconnected' || session.sshStatus === 'error') return res.status(409).json({ error: 'SSH session is no longer attachable.' });
      res.json({ session: sessionManager.issueTicket(session) });
    } catch (error) { sendError(res, error, 'Unable to attach SSH session.'); }
  });

  router.post('/terminal/sessions/:id/disconnect', auth, async (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    try {
      const disconnected = await sessionManager.disconnect(userId, req.params.id);
      if (!disconnected) return res.status(404).json({ error: 'SSH session was not found.' });
      res.json({ success: true });
    } catch (error) { sendError(res, error, 'Unable to disconnect SSH session.'); }
  });

  return router;
};

const createTerminalWebSocketGateway = ({ sessionManager } = {}) => {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const servers = new Set();
  const rejectUpgrade = (socket, status, message) => {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const handleUpgrade = async (request, socket, head) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const match = /^\/ws\/terminal\/([^/]+)$/u.exec(url.pathname);
      if (!match) return rejectUpgrade(socket, 404, 'Not Found');
      const ticket = url.searchParams.get('ticket');
      if (!ticket) return rejectUpgrade(socket, 401, 'Unauthorized');
      const session = sessionManager.consumeTicket(match[1], ticket);
      webSocketServer.handleUpgrade(request, socket, head, client => sessionManager.attach(session, client));
    } catch (error) {
      rejectUpgrade(socket, Number(error?.statusCode) === 401 ? 401 : 403, Number(error?.statusCode) === 401 ? 'Unauthorized' : 'Forbidden');
    }
  };
  const attachServer = server => {
    if (!server || servers.has(server)) return;
    server.on('upgrade', handleUpgrade);
    servers.add(server);
  };
  const close = () => {
    for (const server of servers) server.removeListener('upgrade', handleUpgrade);
    servers.clear();
    webSocketServer.close();
  };
  return { attachServer, close };
};

module.exports = createTerminalSessionRouter();
module.exports.createTerminalSessionRouter = createTerminalSessionRouter;
module.exports.createTerminalWebSocketGateway = createTerminalWebSocketGateway;
