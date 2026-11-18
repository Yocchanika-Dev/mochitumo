CREATE TABLE IF NOT EXISTS users (
  student_id TEXT PRIMARY KEY,
  line_user_id TEXT UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  device_key_salt TEXT NOT NULL,
  device_key_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_authenticated_at TEXT,
  key_rotated_at TEXT
);

CREATE TABLE IF NOT EXISTS nfc_cards (
  card_uid TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(student_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'replaced')),
  replaces_card_uid TEXT REFERENCES nfc_cards(card_uid),
  issued_at TEXT NOT NULL,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_card_per_student
ON nfc_cards (student_id)
WHERE status = 'active';

CREATE TABLE IF NOT EXISTS bikes (
  bike_id TEXT PRIMARY KEY,
  owner_student_id TEXT NOT NULL REFERENCES users(student_id),
  availability TEXT NOT NULL
    CHECK (availability IN ('available', 'reserved', 'rented', 'maintenance')),
  device_id TEXT UNIQUE,
  relay_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rental_requests (
  request_id TEXT PRIMARY KEY,
  borrower_student_id TEXT NOT NULL REFERENCES users(student_id),
  lender_student_id TEXT REFERENCES users(student_id),
  bike_id TEXT REFERENCES bikes(bike_id),
  status TEXT NOT NULL
    CHECK (status IN ('requesting', 'cancelled', 'approved', 'rented', 'returned')),
  source_device_id TEXT NOT NULL REFERENCES devices(device_id),
  client_request_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  cancelled_at TEXT,
  rented_at TEXT,
  returned_at TEXT,
  UNIQUE (source_device_id, client_request_id),
  CHECK (
    (status IN ('requesting', 'cancelled') AND lender_student_id IS NULL AND bike_id IS NULL)
    OR
    (status IN ('approved', 'rented', 'returned') AND lender_student_id IS NOT NULL AND bike_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_request_per_borrower
ON rental_requests (borrower_student_id)
WHERE status IN ('requesting', 'approved', 'rented');

CREATE UNIQUE INDEX IF NOT EXISTS one_active_request_per_bike
ON rental_requests (bike_id)
WHERE status IN ('approved', 'rented');

CREATE TABLE IF NOT EXISTS lock_commands (
  command_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES rental_requests(request_id),
  bike_id TEXT NOT NULL REFERENCES bikes(bike_id),
  action TEXT NOT NULL CHECK (action IN ('unlock', 'lock')),
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'sent', 'acknowledged', 'succeeded', 'failed', 'timed_out')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  acked_at TEXT,
  completed_at TEXT,
  UNIQUE (request_id, action)
);

CREATE TABLE IF NOT EXISTS event_logs (
  event_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_events (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (source, source_id, event_id)
);
