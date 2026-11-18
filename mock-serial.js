// 独立したメモリDBで実行。実DBや実機は変更しない。
const crypto = require('crypto');
const { openDatabase } = require('./src/db/database');
const { seedDevelopmentData } = require('./src/db/seed');
const { DEMO_DEVICE_ID, DEMO_CARD_UID } = require('./src/development-defaults');
const { createNfcRentalRequest } = require('./src/nfc/request-service');
const { approve, requestLock } = require('./src/rental/service');
const { SerialBridge } = require('./src/serial/bridge');
const { MockSerialAdapter } = require('./src/serial/adapters');
const db = openDatabase(':memory:');
seedDevelopmentData(db);
db.prepare(
  "UPDATE bikes SET device_id='MOCK_BIKE03',relay_id='MOCK_RELAY' WHERE bike_id='B003'",
).run();
const adapter = new MockSerialAdapter();
const bridge = new SerialBridge(db, adapter, { relayId: 'MOCK_RELAY' });
adapter.on('sent', (command) => {
  console.log('TX', JSON.stringify(command));
  if (command.message_type !== 'command') return;
  adapter.receive(JSON.stringify({ ...command, message_type: 'ack' }) + '\n');
  adapter.receive(
    JSON.stringify({ ...command, message_type: 'result', result: `${command.action}_success` }) +
      '\n',
  );
});
try {
  bridge.start();
  const id = createNfcRentalRequest(db, {
    deviceId: DEMO_DEVICE_ID,
    cardUid: DEMO_CARD_UID,
    action: 'request',
    clientRequestId: crypto.randomUUID(),
  }).response.request_id;
  console.log('requesting', id);
  approve(db, { id, studentId: 'S1002', bikeId: 'B003', eventId: crypto.randomUUID() });
  console.log('approved');
  bridge.tick();
  console.log('Card touch required; commands sent:', adapter.sent.length);
  adapter.receive(
    JSON.stringify({
      v: 1,
      message_type: 'card_tap',
      relay_id: 'MOCK_RELAY',
      device_id: 'MOCK_BIKE03',
      action: 'unlock',
      card_uid: DEMO_CARD_UID,
      client_request_id: crypto.randomUUID(),
    }) + '\n',
  );
  console.log(db.prepare('SELECT status FROM rental_requests WHERE request_id=?').get(id).status);
  requestLock(db, { id, studentId: 'S1001', eventId: crypto.randomUUID() });
  bridge.tick();
  console.log(db.prepare('SELECT status FROM rental_requests WHERE request_id=?').get(id).status);
} finally {
  bridge.close();
  db.close();
}
