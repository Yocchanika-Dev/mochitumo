const { log } = require('../db/events');
const { HttpError } = require('../http/errors');
const { validateLockTapBody } = require('../nfc/validation');
const { unlockForSerialReader } = require('../rental/card-unlock');

const SUCCESS_TRANSITIONS = {
  unlock: { from: 'approved', to: 'rented', timestamp: 'rented_at', availability: 'rented' },
  lock: { from: 'rented', to: 'returned', timestamp: 'returned_at', availability: 'available' },
};

class SerialBridge {
  constructor(db, adapter, { relayId, timeoutMs = 10000, maxAttempts = 3 } = {}) {
    Object.assign(this, {
      db,
      adapter,
      relayId,
      timeoutMs,
      maxAttempts,
      buffer: '',
      dropping: false,
      closed: false,
    });
    this.listeners = {
      data: (chunk) => this.receive(chunk),
      open: () => {
        this.buffer = '';
        this.dropping = false;
        this.runScheduledTick();
      },
      close: () => {
        this.buffer = '';
      },
      transportError: () => console.warn('[Serial] Transport error; retry pending'),
    };
    for (const [event, listener] of Object.entries(this.listeners)) adapter.on(event, listener);
  }
  get connected() {
    return this.adapter.connected;
  }
  start() {
    if (this.timer || this.closed) return;
    this.adapter.start();
    this.timer = setInterval(() => this.runScheduledTick(), 500);
    this.timer.unref();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const [event, listener] of Object.entries(this.listeners))
      this.adapter.removeListener(event, listener);
    this.adapter.close();
  }
  runScheduledTick() {
    try {
      this.tick();
    } catch {
      // 定期処理の一時的なDBエラーでHTTPサーバー全体を停止させない。
      console.warn('[Serial] Command processing error; retry pending');
    }
  }
  tick() {
    if (this.closed) return;
    const now = Date.now();
    const commands = this.db
      .prepare("SELECT * FROM lock_commands WHERE status IN ('queued','sent','acknowledged')")
      .all();
    for (const c of commands) {
      // 承認だけで作成された旧commandを含め、カードタッチ未確認のunlockは送らない。
      if (
        c.action === 'unlock' &&
        !this.db
          .prepare(
            `
        SELECT 1 FROM unlock_authorizations a
        JOIN rental_requests r ON r.request_id=? AND r.bike_id=?
          AND r.borrower_student_id=a.borrower_student_id AND r.status='approved'
        WHERE a.command_id=?
      `,
          )
          .get(c.request_id, c.bike_id, c.command_id)
      )
        continue;
      const expired = c.sent_at && now - Date.parse(c.sent_at) >= this.timeoutMs;
      if (c.status !== 'queued' && !expired) continue;
      if (c.attempt_count >= this.maxAttempts) {
        this.db
          .transaction(() => {
            this.db
              .prepare(
                "UPDATE lock_commands SET status='timed_out',completed_at=? WHERE command_id=?",
              )
              .run(new Date().toISOString(), c.command_id);
            log(this.db, 'command.timed_out', c.request_id, 'serial', { command_id: c.command_id });
          })
          .immediate();
        continue;
      }
      if (!this.connected) continue;
      const bike = this.db.prepare('SELECT * FROM bikes WHERE bike_id=?').get(c.bike_id);
      // DBに許可機器との対応がなければ実機へ送らない。
      if (!bike?.device_id || !bike.relay_id || bike.relay_id !== this.relayId) continue;
      this.db
        .prepare(
          "UPDATE lock_commands SET status='sent',attempt_count=attempt_count+1,sent_at=?,acked_at=NULL WHERE command_id=?",
        )
        .run(new Date().toISOString(), c.command_id);
      try {
        this.adapter.write(
          JSON.stringify({
            v: 1,
            message_type: 'command',
            command_id: c.command_id,
            request_id: c.request_id,
            bike_id: c.bike_id,
            device_id: bike.device_id,
            relay_id: this.relayId,
            action: c.action,
            attempt: c.attempt_count + 1,
          }) + '\n',
        );
      } catch {
        console.warn('[Serial] Send failed; retry pending');
      }
    }
  }
  receive(chunk) {
    if (this.closed) return;
    // バイト列を保持し、改行後にUTF-8へ変換。巨大行は改行まで捨てる。
    for (const byte of Buffer.from(chunk)) {
      if (byte === 10) {
        const line = this.buffer;
        const parse = !this.dropping;
        // handlerがMockへ書き込み、即座にACKを再受信しても前の行を連結しない。
        this.buffer = '';
        this.dropping = false;
        if (parse) {
          try {
            this.handleMessage(JSON.parse(Buffer.from(line, 'latin1').toString('utf8')));
          } catch {
            console.warn('[Serial] Invalid or unauthorized message discarded');
          }
        }
      } else if (!this.dropping) {
        this.buffer += String.fromCharCode(byte);
        if (this.buffer.length > 1024) {
          this.buffer = '';
          this.dropping = true;
        }
      }
    }
  }
  handleMessage(message) {
    if (message?.message_type === 'card_tap') return this.cardTap(message);
    return this.result(message);
  }
  cardTap(message) {
    if (
      message.v !== 1 ||
      message.relay_id !== this.relayId ||
      typeof message.device_id !== 'string'
    ) {
      throw new Error('invalid reader');
    }
    const body = {
      action: message.action,
      card_uid: message.card_uid,
      client_request_id: message.client_request_id,
    };
    validateLockTapBody(body);
    const reply = {
      v: 1,
      message_type: 'card_tap_result',
      relay_id: this.relayId,
      device_id: message.device_id,
      client_request_id: message.client_request_id,
    };
    try {
      const result = unlockForSerialReader(this.db, {
        relayId: this.relayId,
        deviceId: message.device_id,
        bikeId: message.bike_id,
        body,
      });
      this.adapter.write(
        JSON.stringify({
          ...reply,
          success: true,
          request_id: result.response.request.request_id,
          command_id: result.response.lock_command.command_id,
          command_status: result.response.lock_command.status,
        }) + '\n',
      );
      this.runScheduledTick();
    } catch (error) {
      this.adapter.write(
        JSON.stringify({
          ...reply,
          success: false,
          error: error instanceof HttpError ? error.code : 'INTERNAL_ERROR',
        }) + '\n',
      );
    }
  }
  result(m) {
    if (
      !m ||
      m.v !== 1 ||
      !['ack', 'result'].includes(m.message_type) ||
      m.relay_id !== this.relayId
    )
      throw new Error('invalid');
    this.db
      .transaction(() => {
        const c = this.db
          .prepare('SELECT * FROM lock_commands WHERE command_id=?')
          .get(m.command_id);
        const bike = this.db.prepare('SELECT * FROM bikes WHERE bike_id=?').get(m.bike_id);
        if (
          !c ||
          !bike ||
          c.bike_id !== m.bike_id ||
          bike.device_id !== m.device_id ||
          bike.relay_id !== m.relay_id ||
          m.request_id !== c.request_id
        )
          throw new Error('mismatch');
        if (['succeeded', 'failed'].includes(c.status)) return;
        // queuedは未送信。タイムアウト後の正規の遅延結果は同じcommandに限って受理。
        if (c.status === 'queued') throw new Error('unsent');
        if (
          c.action === 'unlock' &&
          !this.db
            .prepare(
              `
          SELECT 1 FROM unlock_authorizations WHERE command_id=?
        `,
            )
            .get(c.command_id)
        )
          throw new Error('card touch required');
        const now = new Date().toISOString();
        if (m.message_type === 'ack') {
          if (c.status === 'sent')
            this.db
              .prepare(
                "UPDATE lock_commands SET status='acknowledged',acked_at=? WHERE command_id=?",
              )
              .run(now, c.command_id);
          return;
        }
        if (![`${c.action}_success`, `${c.action}_failed`].includes(m.result))
          throw new Error('result');
        const success = m.result === `${c.action}_success`;
        const request = this.db
          .prepare('SELECT * FROM rental_requests WHERE request_id=?')
          .get(c.request_id);
        const transition = SUCCESS_TRANSITIONS[c.action];
        if (!request || request.bike_id !== c.bike_id || request.status !== transition.from)
          throw new Error('state');
        this.db
          .prepare(
            'UPDATE lock_commands SET status=?,result_code=?,completed_at=? WHERE command_id=?',
          )
          .run(success ? 'succeeded' : 'failed', m.result, now, c.command_id);
        if (success) {
          this.db
            .prepare(
              `UPDATE rental_requests SET status=?,${transition.timestamp}=?,updated_at=? WHERE request_id=?`,
            )
            .run(transition.to, now, now, c.request_id);
          this.db
            .prepare('UPDATE bikes SET availability=?,updated_at=? WHERE bike_id=?')
            .run(transition.availability, now, c.bike_id);
          log(this.db, `request.${transition.to}`, c.request_id, m.device_id, {
            command_id: c.command_id,
          });
        } else
          log(this.db, 'command.failed', c.request_id, m.device_id, { command_id: c.command_id });
      })
      .immediate();
  }
}
module.exports = { SerialBridge };
