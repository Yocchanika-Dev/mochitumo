const MAX_ATTEMPTS = 5;
const LEASE_MS = 30000;
const HTTP_TIMEOUT_MS = 5000;

// 本文とevent_idはDBに固定。トークンやfetchエラー詳細はログに出さない。
class EventSender {
  constructor(db, { url, token, fetchImpl = fetch, allowTestHttp = false } = {}) {
    let target;
    try {
      target = new URL(url);
    } catch {
      throw new Error('HTTPSの通知先URLを設定してください');
    }
    if (
      (target.protocol !== 'https:' && !(allowTestHttp && target.protocol === 'http:')) ||
      target.username ||
      target.password
    ) {
      throw new Error('HTTPSの通知先URLを設定してください');
    }
    if (typeof token !== 'string' || token.length < 16)
      throw new Error('BACKEND_EVENTS_TOKENが必要です');
    Object.assign(this, { db, url, token, fetchImpl, busy: false, closed: false });
  }

  claim(eventId) {
    return this.db
      .transaction(() => {
        const now = Date.now();
        const item = eventId
          ? this.db.prepare('SELECT * FROM line_outbox WHERE event_id=?').get(eventId)
          : this.db
              .prepare(
                "SELECT * FROM line_outbox WHERE status IN ('pending','sending') AND next_attempt_at<=? ORDER BY CAST(event_id AS INTEGER) LIMIT 1",
              )
              .get(now);
        if (!item || (item.status === 'sending' && item.next_attempt_at > now)) return;
        // 異常終了で残ったsendingも自動再送上限に含める。明示再送は引き続き可能。
        if (!eventId && item.attempts >= MAX_ATTEMPTS) {
          this.db
            .prepare("UPDATE line_outbox SET status='failed' WHERE event_id=?")
            .run(item.event_id);
          return;
        }
        const request = this.db
          .prepare('SELECT status FROM rental_requests WHERE request_id=?')
          .get(item.request_id);
        if (!item.delivered_at && request?.status !== 'requesting') {
          this.db
            .prepare("UPDATE line_outbox SET status='skipped' WHERE event_id=?")
            .run(item.event_id);
          return;
        }
        this.db
          .prepare(
            "UPDATE line_outbox SET status='sending',attempts=attempts+1,next_attempt_at=? WHERE event_id=?",
          )
          .run(now + LEASE_MS, item.event_id);
        return { ...item, attempts: item.attempts + 1 };
      })
      .immediate();
  }

  async post(row) {
    let status;
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: row.body_json,
        redirect: 'error',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      status = response.status;
      await response.body?.cancel();
    } catch {
      /* 接続先や認証情報を含むエラー詳細は保存しない */
    }
    return status;
  }

  finish(row, httpStatus) {
    const success = httpStatus === 200 || httpStatus === 202;
    const retry =
      (!httpStatus || httpStatus === 429 || httpStatus >= 500) && row.attempts < MAX_ATTEMPTS;
    const status = success ? 'delivered' : retry ? 'pending' : 'failed';
    const result = this.db
      .prepare(
        `
      UPDATE line_outbox SET status=?,last_http_status=?,next_attempt_at=?,delivered_at=?
      WHERE event_id=? AND status='sending' AND attempts=?
    `,
      )
      .run(
        status,
        httpStatus || null,
        success ? 0 : Date.now() + 1000 * 2 ** (row.attempts - 1),
        success ? new Date().toISOString() : row.delivered_at,
        row.event_id,
        row.attempts,
      );
    // leaseを別workerが取得済みなら、その新しい結果を上書きしない。
    return {
      event_id: row.event_id,
      http_status: httpStatus || null,
      status: result.changes ? status : 'superseded',
    };
  }

  async send(eventId) {
    if (this.busy || this.closed) return { status: 'busy' };
    this.busy = true;
    try {
      const row = this.claim(eventId);
      if (!row) return { status: 'no_event' };
      const status = await this.post(row);
      if (this.closed || !this.db.open) return { status: 'stopped' };
      return this.finish(row, status);
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(
      () => this.send().catch(() => console.warn('[LINE events] Delivery error')),
      1000,
    );
    this.timer.unref();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
  }
}
module.exports = { EventSender };
