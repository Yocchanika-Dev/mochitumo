const express = require('express');
const { requireHttps, authenticateLineService } = require('./middleware');
const { invalidRequest } = require('./validation');
const { listOpenRequests, listRequestEvents } = require('../rental/queries');
const { createLineWebhookHandler } = require('../line/webhook');

function createIntegrationRouter(db, options) {
  const router = express.Router();
  const token = options.lineToken || process.env.LINE_SERVICE_TOKEN;
  const secret = options.lineSecret || process.env.LINE_CHANNEL_SECRET;
  const https = requireHttps(options.requireHttps);
  const auth = authenticateLineService(token);

  router.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({
      status: 'ok',
      database: 'ok',
      serial: options.serial?.connected ? 'connected' : 'disconnected',
    });
  });
  router.get('/api/line/requests', https, auth, (req, res) => {
    res.json({ requests: listOpenRequests(db) });
  });
  // Cursorは消費・削除しない。送信成功後の保存と重複排除はLINE担当が行う。
  router.get('/api/line/events', https, auth, (req, res) => {
    const after = req.query.after || '0';
    if (!/^\d{1,15}$/.test(after)) invalidRequest();
    res.json(listRequestEvents(db, after));
  });
  router.post(
    ['/webhooks/line', '/api/requests/:id/approve'],
    https,
    auth,
    express.raw({ type: 'application/json', limit: '64kb' }),
    createLineWebhookHandler(db, secret),
  );
  return router;
}
module.exports = { createIntegrationRouter };
