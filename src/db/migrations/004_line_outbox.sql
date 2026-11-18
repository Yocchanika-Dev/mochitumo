CREATE TABLE line_outbox (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES rental_requests(request_id),
  body_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','sending','delivered','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_http_status INTEGER,
  delivered_at TEXT
);

-- 申請作成トランザクション内で固定した本文を保存する。
-- 過去イベントを自動バックフィルして募集を再公開することはしない。
CREATE TRIGGER enqueue_line_request_created AFTER INSERT ON event_logs
WHEN NEW.event_type = 'request.created'
BEGIN
  INSERT INTO line_outbox(event_id,request_id,body_json)
  SELECT CAST(NEW.event_log_id AS TEXT),r.request_id,
    json_object('event_id',CAST(NEW.event_log_id AS TEXT),
      'event_type','request.created','occurred_at',NEW.created_at,
      'request',json_object('request_id',r.request_id,
        'borrower_display_name',u.name,'status',r.status,'bike_id',r.bike_id,
        'created_at',r.created_at,'updated_at',r.updated_at))
  FROM rental_requests r JOIN users u ON u.student_id=r.borrower_student_id
  WHERE r.request_id=NEW.entity_id;
END;
