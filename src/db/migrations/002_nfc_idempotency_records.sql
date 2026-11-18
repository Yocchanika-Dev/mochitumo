CREATE TABLE IF NOT EXISTS idempotency_records (
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  client_request_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES rental_requests(request_id),
  response_student_id TEXT NOT NULL REFERENCES users(student_id),
  response_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, client_request_id)
);

INSERT OR IGNORE INTO idempotency_records (
  device_id,
  client_request_id,
  request_fingerprint,
  request_id,
  response_student_id,
  response_status,
  created_at
)
SELECT
  source_device_id,
  client_request_id,
  request_fingerprint,
  request_id,
  borrower_student_id,
  'requesting',
  created_at
FROM rental_requests;
