const { openDatabase } = require('../src/db/database');
const { createLineGateway } = require('../src/http/line-gateway');
require('../src/config').loadEnvironmentFile();

if (!process.env.LINE_SERVICE_TOKEN || process.env.LINE_SERVICE_TOKEN.length < 32) {
  console.error('LINE_SERVICE_TOKENを環境設定してください（32文字以上）');
  process.exitCode = 1;
} else {
  const db = openDatabase();
  const app = createLineGateway(db);
  const server = app.listen(3001, '127.0.0.1', () => {
    console.log('LINE gateway listening on 127.0.0.1:3001 (ngrok HTTPS upstream only)');
    console.log(
      process.env.LINE_CHANNEL_SECRET
        ? 'LINE signature verification configured'
        : 'LINE_CHANNEL_SECRET missing: signed operations return 503 until configured',
    );
  });
  server.once('error', () => {
    db.close();
    console.error('LINE gateway could not start');
    process.exitCode = 1;
  });
  function shutdown() {
    server.close(() => {
      if (db.open) db.close();
      process.exit(0);
    });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
