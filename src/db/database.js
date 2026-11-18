const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DEFAULT_DATABASE_PATH = path.join(__dirname, '..', '..', 'data', 'mobaeco.sqlite');

function ensureDatabaseDirectory(filename) {
  if (filename === ':memory:') {
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

function migrateDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = db
    .prepare('SELECT migration_name FROM schema_migrations')
    .all()
    .map((row) => row.migration_name);
  const appliedNames = new Set(applied);

  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((filename) => filename.endsWith('.sql'))
    .sort();

  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE migration_name = ?');
  const applyMigration = db.transaction((filename, sql) => {
    // 一覧取得後に別プロセスが移行を終えている場合も、書込ロック内で再確認する。
    if (isApplied.get(filename)) return;
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (migration_name, applied_at) VALUES (?, ?)').run(
      filename,
      new Date().toISOString(),
    );
  });

  for (const filename of migrationFiles) {
    if (appliedNames.has(filename)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    applyMigration.immediate(filename, sql);
  }
}

function openDatabase(filename = process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH) {
  ensureDatabaseDirectory(filename);
  const db = new Database(filename);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    migrateDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

module.exports = {
  DEFAULT_DATABASE_PATH,
  migrateDatabase,
  openDatabase,
};
