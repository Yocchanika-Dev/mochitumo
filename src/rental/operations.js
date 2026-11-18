const crypto = require('crypto');
const { HttpError } = require('../http/errors');

function operation(db, source, eventId, input, work) {
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return db
    .transaction(() => {
      const old = db
        .prepare('SELECT * FROM operation_receipts WHERE source=? AND event_id=?')
        .get(source, eventId);
      if (old) {
        if (old.fingerprint !== fingerprint) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同じイベントIDで内容が異なります');
        }
        return JSON.parse(old.response_json);
      }
      const result = work();
      db.prepare(
        `INSERT INTO operation_receipts
      (source, event_id, fingerprint, response_json, created_at) VALUES (?,?,?,?,?)`,
      ).run(source, eventId, fingerprint, JSON.stringify(result), new Date().toISOString());
      return result;
    })
    .immediate();
}

module.exports = { operation };
