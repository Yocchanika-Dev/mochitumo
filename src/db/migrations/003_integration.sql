CREATE UNIQUE INDEX one_bike_per_owner ON bikes(owner_student_id);

CREATE TABLE operation_receipts (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(source, event_id)
);
