const express = require('express');
const { authenticate } = require('../middleware/auth');

const currentUserId = req => req.user?.id === undefined || req.user?.id === null ? null : String(req.user.id);
const sendError = (res, error, fallback) => {
  const candidate = Number(error?.statusCode);
  const status = (candidate >= 400 && candidate < 500) || candidate === 503 ? candidate : 500;
  res.status(status).json({ error: status >= 500 ? fallback : error.message });
};

const createTerminalTargetRouter = ({ targetStore, sessionManager, auth = authenticate } = {}) => {
  const router = express.Router();

  router.get('/terminal/targets', auth, async (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ targets: await targetStore.list(userId) });
    } catch (error) { sendError(res, error, 'Unable to load SSH targets.'); }
  });

  router.post('/terminal/targets', auth, async (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    try {
      const target = await targetStore.create(userId, req.body || {});
      res.status(201).json({ target });
    } catch (error) { sendError(res, error, 'Unable to create SSH target.'); }
  });

  router.put('/terminal/targets/:id', auth, async (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    try {
      const target = await targetStore.update(userId, req.params.id, req.body || {});
      if (!target) return res.status(404).json({ error: 'SSH target was not found.' });
      await sessionManager.closeTarget(userId, target.id);
      res.json({ target });
    } catch (error) { sendError(res, error, 'Unable to update SSH target.'); }
  });

  router.delete('/terminal/targets/:id', auth, async (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    try {
      const target = await targetStore.get(userId, req.params.id);
      if (!target) return res.status(404).json({ error: 'SSH target was not found.' });
      await sessionManager.closeTarget(userId, target.id);
      const deleted = await targetStore.remove(userId, target.id);
      res.json({ success: deleted });
    } catch (error) { sendError(res, error, 'Unable to delete SSH target.'); }
  });

  router.post('/terminal/targets/:id/test', auth, async (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    try {
      res.json(await sessionManager.testConnection(userId, req.params.id));
    } catch (error) { sendError(res, error, 'SSH connection test failed.'); }
  });

  return router;
};

module.exports = createTerminalTargetRouter();
module.exports.createTerminalTargetRouter = createTerminalTargetRouter;
