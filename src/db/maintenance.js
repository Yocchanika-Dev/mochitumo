const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function openReadOnly(filename) {
  return new Database(filename, { readonly: true, fileMustExist: true });
}

function checkDatabase(db) {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok')
    throw new Error('Database integrity check failed');
  if (db.pragma('foreign_key_check').length) throw new Error('Database foreign key check failed');
}

// SQLite online backup APIはWALの未checkpointデータも含む。一式をcpしない。
// 復元も新しいファイルだけに作成し、稼働DBの上書きはしない。
async function copyDatabase(source, destination) {
  const db = openReadOnly(source);
  try {
    checkDatabase(db);
    fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(destination, 'wx', 0o600);
    fs.closeSync(fd);
    try {
      await db.backup(destination);
      const restored = openReadOnly(destination);
      try {
        checkDatabase(restored);
      } finally {
        restored.close();
      }
    } catch (error) {
      // 作成した不完全コピーだけを除去する。既存ファイルには触れない。
      fs.unlinkSync(destination);
      throw error;
    }
  } finally {
    db.close();
  }
}

function requestDiagnostics(db, requestId) {
  return db.transaction(() => {
    const request = db
      .prepare(
        `SELECT request_id,status,bike_id,created_at,updated_at
      FROM rental_requests WHERE request_id=?`,
      )
      .get(requestId);
    if (!request) return null;
    const commands = db
      .prepare(
        `SELECT command_id,action,status,attempt_count,result_code,created_at,sent_at,acked_at,completed_at
      FROM lock_commands WHERE request_id=? ORDER BY created_at`,
      )
      .all(requestId);
    const notifications = db
      .prepare(
        `SELECT event_id,status,attempts,last_http_status,delivered_at
      FROM line_outbox WHERE request_id=? ORDER BY event_id`,
      )
      .all(requestId);
    const needsReview = commands.some((c) => ['failed', 'timed_out'].includes(c.status));
    return {
      request,
      commands,
      notifications,
      guidance: needsReview
        ? 'Inspect the physical lock before operator recovery. No automatic re-unlock.'
        : request.status === 'requesting'
          ? 'Only the authenticated borrower may normally cancel.'
          : 'Do not force state changes. Confirm device results and existing operation IDs.',
    };
  })();
}

module.exports = { openReadOnly, checkDatabase, copyDatabase, requestDiagnostics };
