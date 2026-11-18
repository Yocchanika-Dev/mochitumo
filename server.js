const express = require('express');
const path = require('path');
const { openDatabase } = require('./src/db/database');
const { errorHandler } = require('./src/http/errors');
const { createNfcRouter } = require('./src/http/nfc-routes');
const { createIntegrationRouter } = require('./src/http/integration-routes');
const { createVirtualBikeRouter } = require('./src/http/virtual-bike-routes');
const { createRuntimeOptions } = require('./src/runtime');

const HOST = '0.0.0.0';
const PORT = 3000;

function createApp(options = {}) {
  const app = express();
  const ownsDatabase = !options.db;
  const db = options.db || openDatabase(options.databasePath);
  const requireHttps =
    options.requireHttps ??
    (process.env.NODE_ENV === 'production' || process.env.ALLOW_INSECURE_NFC_HTTP !== 'true');
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY;
  if (trustProxy) app.set('trust proxy', trustProxy);

  app.locals.db = db;
  app.locals.virtualDemoEnabled = options.enableVirtualBike === true;
  app.locals.requireHttps = requireHttps;
  app.locals.closeDatabase = () => {
    app.locals.eventSender?.close();
    app.locals.serial?.close();
    if (ownsDatabase && db.open) db.close();
  };

  try {
    if (options.serialAdapter) {
      const { SerialBridge } = require('./src/serial/bridge');
      app.locals.serial = new SerialBridge(db, options.serialAdapter, options.serialOptions);
      app.locals.serial.start();
    }
    if (options.enableVirtualBike === true) {
      app.use(express.static(path.join(__dirname, 'public')));
    }
    app.use('/api', createNfcRouter(db, { requireHttps }));
    // 公式署名の検証にはraw bodyが必要。共通JSONパーサーより先に登録する。
    app.use(createIntegrationRouter(db, { ...options, requireHttps, serial: app.locals.serial }));
    app.use(express.json());
    if (options.enableVirtualBike === true) app.use('/api', createVirtualBikeRouter());
    app.use((req, res) => res.status(404).json({ success: false, error: 'NOT_FOUND' }));
    app.use(errorHandler);

    // 起動入口でだけ実送信設定を読込む。テストのcreateAppへ環境の秘密を持ち込まない。
    if (options.eventDelivery) {
      const { EventSender } = require('./src/line/event-sender');
      app.locals.eventSender = new EventSender(db, options.eventDelivery);
      app.locals.eventSender.start();
    }
  } catch (error) {
    app.locals.closeDatabase();
    throw error;
  }
  return app;
}

if (require.main === module) {
  require('./src/config').loadEnvironmentFile();
  const app = createApp(createRuntimeOptions());
  const server = app.listen(PORT, HOST, () => {
    console.log(`Bike rental server is running at http://localhost:${PORT}`);
    console.log(`Smartphone access: http://<PCのローカルIPアドレス>:${PORT}`);
    if (app.locals.requireHttps) console.log('[NFC API] HTTPS is required');
    else console.warn('[NFC API] Insecure HTTP is enabled for isolated development only');
    console.log(`[Virtual demo] ${app.locals.virtualDemoEnabled ? 'enabled' : 'disabled'}`);
  });
  server.once('error', () => {
    app.locals.closeDatabase();
    console.error('Server could not start. Check the configured port and runtime settings.');
    process.exitCode = 1;
  });
  function shutdown() {
    server.close(() => {
      app.locals.closeDatabase();
      process.exit(0);
    });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
module.exports = { createApp };
