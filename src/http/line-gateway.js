const express = require('express');
const { createIntegrationRouter } = require('./integration-routes');
const { errorHandler } = require('./errors');

// ngrokはこのloopback専用入口だけを公開。NFC・仮想デモ・静的ファイルは登録しない。
function createLineGateway(db, options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(createIntegrationRouter(db, { ...options, requireHttps: true }));
  app.use((req, res) =>
    res.status(404).json({ success: false, error: 'NOT_FOUND', message: '公開対象外のパスです' }),
  );
  app.use(errorHandler);
  return app;
}

module.exports = { createLineGateway };
