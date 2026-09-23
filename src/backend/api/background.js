const express = require('express');
const database = require('../database/db');
const { authenticate } = require('../middleware/auth');

const MAX_BACKGROUND_SIZE = 5 * 1024 * 1024;
const MIN_BACKGROUND_SCALE = 0.5;
const MAX_BACKGROUND_SCALE = 2;
const MAX_BACKGROUND_DIMENSION = 100000;
const IMAGE_DATA_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const IMAGE_MIME_PATTERN = /^image\/[a-z0-9.+-]+$/i;

const errorWithStatus = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const currentUserId = (req) => req.user?.id === undefined || req.user?.id === null ? null : String(req.user.id);

const parseBackground = (body = {}) => {
  if (typeof body.data !== 'string' || !body.data || body.data.length % 4 !== 0 || !IMAGE_DATA_PATTERN.test(body.data)) {
    throw errorWithStatus('Background image data is invalid.');
  }
  if (typeof body.mimeType !== 'string' || !IMAGE_MIME_PATTERN.test(body.mimeType)) {
    throw errorWithStatus('Background image type is invalid.');
  }
  const image = Buffer.from(body.data, 'base64');
  if (!image.length || image.length > MAX_BACKGROUND_SIZE) throw errorWithStatus('Background image must be 5MB or smaller.');

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const width = Number(body.width);
  const height = Number(body.height);
  const scale = Number(body.scale);
  const position = body.position || {};
  const x = Number(position.x);
  const y = Number(position.y);
  if (!name || name.length > 255) throw errorWithStatus('Background image name is invalid.');
  if (!Number.isInteger(width) || width < 1 || width > MAX_BACKGROUND_DIMENSION) throw errorWithStatus('Background image width is invalid.');
  if (!Number.isInteger(height) || height < 1 || height > MAX_BACKGROUND_DIMENSION) throw errorWithStatus('Background image height is invalid.');
  if (!Number.isFinite(scale) || scale < MIN_BACKGROUND_SCALE || scale > MAX_BACKGROUND_SCALE) throw errorWithStatus('Background image scale is invalid.');
  if (!Number.isFinite(x) || x < 0 || x > 100 || !Number.isFinite(y) || y < 0 || y > 100) throw errorWithStatus('Background image position is invalid.');

  return { image, mimeType: body.mimeType.toLowerCase(), name, width, height, size: image.length, scale, x, y };
};

const serializeBackground = (row) => ({
  data: Buffer.from(row.image).toString('base64'),
  mimeType: row.mimeType,
  name: row.name,
  width: row.width,
  height: row.height,
  size: row.size,
  scale: row.scale,
  position: { x: row.positionX, y: row.positionY },
  updatedAt: row.updatedAt
});

const createBackgroundRouter = ({ db = database, auth = authenticate } = {}) => {
  const router = express.Router();

  router.get('/user/background', auth, async (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    try {
      const row = await db.get('SELECT image, mimeType, name, width, height, size, scale, positionX, positionY, updatedAt FROM user_pane_backgrounds WHERE userId = ?', [userId]);
      res.set('Cache-Control', 'no-store');
      res.json({ background: row ? serializeBackground(row) : null });
    } catch (error) {
      res.status(500).json({ error: 'Unable to load background image.' });
    }
  });

  router.put('/user/background', auth, async (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    try {
      const background = parseBackground(req.body);
      const updatedAt = Date.now();
      await db.run(`
        INSERT OR REPLACE INTO user_pane_backgrounds
          (userId, image, mimeType, name, width, height, size, scale, positionX, positionY, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [userId, background.image, background.mimeType, background.name, background.width, background.height, background.size, background.scale, background.x, background.y, updatedAt]);
      res.set('Cache-Control', 'no-store');
      res.json({
        success: true,
        background: {
          mimeType: background.mimeType,
          name: background.name,
          width: background.width,
          height: background.height,
          size: background.size,
          scale: background.scale,
          position: { x: background.x, y: background.y },
          updatedAt
        }
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to save background image.' });
    }
  });

  router.delete('/user/background', auth, async (req, res) => {
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).json({ error: 'Authenticated user ID is required.' });
    try {
      const result = await db.run('DELETE FROM user_pane_backgrounds WHERE userId = ?', [userId]);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, deleted: result.changes > 0 });
    } catch (error) {
      res.status(500).json({ error: 'Unable to remove background image.' });
    }
  });

  return router;
};

module.exports = createBackgroundRouter();
module.exports.createBackgroundRouter = createBackgroundRouter;
module.exports.parseBackground = parseBackground;
