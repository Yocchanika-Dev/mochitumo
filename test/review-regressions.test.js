const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { openDatabase, migrateDatabase } = require('../src/db/database');
const { seedDevelopmentData, DEMO_CARD_UID } = require('../src/db/seed');
const { createNfcRentalRequest } = require('../src/nfc/request-service');
const { cancel, cardStudent } = require('../src/rental/service');
const { listRequestEvents } = require('../src/rental/queries');
const { EventSender } = require('../src/line/event-sender');
const { UsbSerialAdapter, MockSerialAdapter } = require('../src/serial/adapters');
const { SerialBridge } = require('../src/serial/bridge');
const { createApp } = require('../server');
const { createRuntimeOptions } = require('../src/runtime');

function context(t) {
  const db = openDatabase(':memory:');
  seedDevelopmentData(db);
  t.after(() => db.close());
  const requestId = createNfcRentalRequest(db, {
    deviceId: 'nfc-reader-01',
    cardUid: DEMO_CARD_UID,
    action: 'request',
    clientRequestId: crypto.randomUUID(),
  }).response.request_id;
  const eventId = db.prepare('SELECT event_id FROM line_outbox').get().event_id;
  const sender = (fetchImpl) =>
    new EventSender(db, {
      url: 'https://example.invalid/events',
      token: 'dummy-review-token',
      fetchImpl,
    });
  return { db, requestId, eventId, sender };
}

test('期限切れleaseの古い送信結果は後続workerの成功を上書きしない', async (t) => {
  const { db, eventId, sender } = context(t);
  let finishOld;
  const old = sender(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const pending = old.send();
  db.prepare('UPDATE line_outbox SET next_attempt_at=0').run();
  const current = sender(async () => ({ status: 202 }));
  assert.equal((await current.send()).status, 'delivered');
  finishOld({ status: 500 });
  assert.equal((await pending).status, 'superseded');
  const row = db.prepare('SELECT * FROM line_outbox WHERE event_id=?').get(eventId);
  assert.equal(row.status, 'delivered');
  assert.equal(row.last_http_status, 202);
  assert.equal(row.attempts, 2);
});

test('異常終了で残ったsendingも最大5回の自動送信に含める', async (t) => {
  const { db, sender } = context(t);
  db.prepare("UPDATE line_outbox SET status='sending',attempts=5,next_attempt_at=0").run();
  const worker = sender(() => assert.fail('自動再送上限を超えて送らない'));
  assert.equal((await worker.send()).status, 'no_event');
  assert.equal(db.prepare('SELECT status FROM line_outbox').get().status, 'failed');
  worker.fetchImpl = async () => ({ status: 200 });
  const eventId = db.prepare('SELECT event_id FROM line_outbox').get().event_id;
  assert.equal((await worker.send(eventId)).status, 'delivered');
});

test('停止中に完了したUSB openを再接続・通知せず閉じる', () => {
  class FakePort extends EventEmitter {
    open(callback) {
      this.complete = callback;
    }
    close() {
      this.isOpen = false;
      this.emit('close');
    }
  }
  const ports = [];
  const adapter = new UsbSerialAdapter({
    path: 'mock',
    createPort: () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    },
  });
  let opens = 0;
  adapter.on('open', () => opens++);
  adapter.start();
  adapter.start();
  assert.equal(ports.length, 1);
  adapter.close();
  ports[0].isOpen = true;
  ports[0].complete();
  assert.equal(ports[0].isOpen, false);
  assert.equal(adapter.connected, false);
  assert.equal(opens, 0);
  assert.equal(adapter.timer, null);
});

test('SerialBridgeの停止後は受信リスナー・タイマーを残さない', (t) => {
  const { db } = context(t);
  const adapter = new MockSerialAdapter();
  const bridge = new SerialBridge(db, adapter);
  bridge.start();
  const timer = bridge.timer;
  bridge.start();
  assert.equal(bridge.timer, timer);
  bridge.close();
  bridge.close();
  assert.equal(adapter.listenerCount('data'), 0);
  assert.equal(adapter.listenerCount('open'), 0);
  assert.equal(bridge.timer, null);
});

test('JOINでイベントを取得しても発生時刻と最新申請時刻を混同しない', (t) => {
  const { db, requestId } = context(t);
  const created = db
    .prepare("SELECT created_at FROM event_logs WHERE event_type='request.created'")
    .get().created_at;
  cancel(db, {
    id: requestId,
    studentId: 'S1001',
    source: 'nfc:nfc-reader-01',
    eventId: 'cancel-review',
  });
  db.prepare("UPDATE rental_requests SET updated_at='2030-01-01T00:00:00.000Z'").run();
  const result = listRequestEvents(db, '0');
  assert.equal(result.events[0].occurred_at, created);
  assert.equal(result.events[0].request.updated_at, '2030-01-01T00:00:00.000Z');
  assert.equal(result.events[0].request.status, 'cancelled');
  assert.equal(result.events[0].request.borrower_display_name, '借り手デモ');
  assert.equal(result.events[0].request.created_at, created);
  assert.equal(result.events.length, 2);
  assert.deepEqual(listRequestEvents(db, result.next_cursor), {
    events: [],
    next_cursor: result.next_cursor,
  });
});

test('createAppはテスト環境の実送信設定を自動起動せず、起動入口でだけ設定する', (t) => {
  const { db } = context(t);
  const options = createRuntimeOptions({
    BACKEND_EVENTS_URL: 'https://example.invalid/events',
    BACKEND_EVENTS_TOKEN: 'dummy-review-token',
    SERIAL_MODE: 'off',
  });
  assert.equal(options.eventDelivery.url, 'https://example.invalid/events');
  const previousUrl = process.env.BACKEND_EVENTS_URL;
  const previousToken = process.env.BACKEND_EVENTS_TOKEN;
  let app;
  try {
    process.env.BACKEND_EVENTS_URL = 'https://example.invalid/events';
    process.env.BACKEND_EVENTS_TOKEN = 'dummy-review-token';
    app = createApp({ db });
    assert.equal(app.locals.eventSender, undefined);
  } finally {
    app?.locals.closeDatabase();
    if (previousUrl === undefined) delete process.env.BACKEND_EVENTS_URL;
    else process.env.BACKEND_EVENTS_URL = previousUrl;
    if (previousToken === undefined) delete process.env.BACKEND_EVENTS_TOKEN;
    else process.env.BACKEND_EVENTS_TOKEN = previousToken;
  }
  assert.equal(db.open, true);
});

test('アプリ初期化失敗時は既に起動したadapterを閉じる', (t) => {
  const { db } = context(t);
  const adapter = new MockSerialAdapter();
  assert.throws(
    () =>
      createApp({
        db,
        serialAdapter: adapter,
        eventDelivery: { url: 'invalid-url', token: 'dummy-review-token' },
      }),
    /HTTPS/,
  );
  assert.equal(adapter.connected, false);
  assert.equal(adapter.listenerCount('data'), 0);
  assert.equal(db.open, true);
});

test('一覧取得後に別の起動処理が移行を完了してもマイグレーションを二重適用しない', (t) => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  t.after(() => db.close());
  let interleaved = false;
  const interleavedDb = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql) => {
          const statement = target.prepare(sql);
          if (sql !== 'SELECT migration_name FROM schema_migrations') return statement;
          return {
            all() {
              const staleRows = statement.all();
              // 両起動が「まだ移行なし」と読んだ後に、一方だけが先に完了する順序を再現。
              if (!interleaved) {
                interleaved = true;
                migrateDatabase(db);
              }
              return staleRows;
            },
          };
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.doesNotThrow(() => migrateDatabase(interleavedDb));
  assert.equal(interleaved, true);
  assert.ok(
    db
      .prepare("SELECT 1 FROM schema_migrations WHERE migration_name='005_line_event_contract.sql'")
      .get(),
  );
  assert.doesNotThrow(() => migrateDatabase(db));
});

test('カード照会共通化後も未登録・無効カードのAPI別エラーを維持する', (t) => {
  const { db } = context(t);
  assert.equal(cardStudent(db, DEMO_CARD_UID), 'S1001');
  assert.throws(
    () => cardStudent(db, 'FFFFFFFFFFFFFFFF'),
    (e) => e.status === 403 && e.message === '有効なカードが必要です',
  );
  db.prepare("UPDATE users SET status='disabled' WHERE student_id='S1001'").run();
  assert.throws(
    () => cardStudent(db, DEMO_CARD_UID),
    (e) => e.code === 'CARD_DISABLED',
  );
  assert.throws(
    () =>
      createNfcRentalRequest(db, {
        deviceId: 'nfc-reader-01',
        cardUid: DEMO_CARD_UID,
        action: 'request',
        clientRequestId: crypto.randomUUID(),
      }),
    (e) => e.status === 403 && e.message === 'このカードは利用できません',
  );
  assert.throws(
    () =>
      createNfcRentalRequest(db, {
        deviceId: 'nfc-reader-01',
        cardUid: 'FFFFFFFFFFFFFFFF',
        action: 'request',
        clientRequestId: crypto.randomUUID(),
      }),
    (e) => e.status === 404 && e.code === 'CARD_NOT_REGISTERED',
  );
});

test('シリアル定期処理の一時DBエラーを捕捉し次の処理を継続する', (t) => {
  const { db } = context(t);
  const adapter = new MockSerialAdapter();
  const bridge = new SerialBridge(db, adapter);
  t.after(() => bridge.close());
  let calls = 0;
  const originalTick = bridge.tick.bind(bridge);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  bridge.tick = () => {
    if (++calls === 1) throw new Error('private database detail');
    originalTick();
  };
  assert.doesNotThrow(() => bridge.start());
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('private database detail'), false);
  assert.doesNotThrow(() => bridge.runScheduledTick());
  assert.equal(calls, 2);
});
