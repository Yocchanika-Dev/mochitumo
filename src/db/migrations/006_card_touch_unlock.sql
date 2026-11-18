-- HTTPSのロックリーダーを許可済み自転車へ固定する。申請端末を自動で登録しない。
CREATE TABLE lock_readers (
  device_id TEXT PRIMARY KEY REFERENCES devices(device_id),
  bike_id TEXT NOT NULL UNIQUE REFERENCES bikes(bike_id),
  created_at TEXT NOT NULL
);

-- 既存unlock commandも、明示的なカードタッチ確認なしでは送信しない。
CREATE TABLE unlock_authorizations (
  command_id TEXT PRIMARY KEY REFERENCES lock_commands(command_id),
  borrower_student_id TEXT NOT NULL REFERENCES users(student_id),
  reader_source TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(reader_source, client_request_id)
);
