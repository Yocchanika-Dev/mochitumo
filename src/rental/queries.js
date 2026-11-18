const { HttpError } = require('../http/errors');

const REQUEST_WITH_BORROWER = `
  SELECT r.*, u.name AS borrower_display_name
  FROM rental_requests r
  JOIN users u ON u.student_id = r.borrower_student_id
`;

function getRequest(db, id) {
  const row = db.prepare(`${REQUEST_WITH_BORROWER} WHERE r.request_id = ?`).get(id);
  if (!row) throw new HttpError(404, 'REQUEST_NOT_FOUND', '申請が見つかりません');
  return row;
}

function publicRequest(row) {
  return {
    request_id: row.request_id,
    borrower_display_name: row.borrower_display_name,
    status: row.status,
    bike_id: row.bike_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listOpenRequests(db) {
  return db
    .prepare(
      `${REQUEST_WITH_BORROWER}
    WHERE r.status = 'requesting' ORDER BY r.created_at
  `,
    )
    .all()
    .map(publicRequest);
}

function listAvailableOwnedBikes(db, studentId) {
  return db
    .prepare(
      `
    SELECT bike_id, availability FROM bikes
    WHERE owner_student_id = ? AND availability = 'available'
    ORDER BY bike_id
  `,
    )
    .all(studentId);
}

function listRequestEvents(db, after) {
  // 1回のJOINで最新requestを取得し、イベントごとの追加SELECTを避ける。
  const rows = db
    .prepare(
      `
    SELECT r.*, u.name AS borrower_display_name,
      e.event_log_id, e.event_type, e.created_at AS occurred_at
    FROM event_logs e
    JOIN rental_requests r ON r.request_id = e.entity_id
    JOIN users u ON u.student_id = r.borrower_student_id
    WHERE e.event_log_id > ? AND (
      e.event_type LIKE 'request.%'
      OR e.event_type IN ('command.failed', 'command.timed_out')
    )
    ORDER BY e.event_log_id LIMIT 100
  `,
    )
    .all(Number(after));

  return {
    events: rows.map((row) => ({
      event_id: String(row.event_log_id),
      event_type: row.event_type,
      occurred_at: row.occurred_at,
      request: publicRequest(row),
    })),
    next_cursor: rows.length ? String(rows.at(-1).event_log_id) : after,
  };
}

module.exports = {
  getRequest,
  publicRequest,
  listOpenRequests,
  listRequestEvents,
  listAvailableOwnedBikes,
};
