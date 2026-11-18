const { loadEnvironmentFile } = require('../src/config');
const { DEFAULT_DATABASE_PATH } = require('../src/db/database');
const { copyDatabase, openReadOnly, requestDiagnostics } = require('../src/db/maintenance');

async function main() {
  loadEnvironmentFile();
  const [action, first, second, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected arguments');
  const current = process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH;
  if (action === 'status' && first && !second) {
    const db = openReadOnly(current);
    try {
      const result = requestDiagnostics(db, first);
      if (!result) {
        console.error('Request not found');
        process.exitCode = 1;
      } else console.log(JSON.stringify(result, null, 2));
    } finally {
      db.close();
    }
  } else if (action === 'backup' && first && !second) {
    await copyDatabase(current, first);
    console.log('Backup created and integrity verified.');
  } else if (action === 'restore' && first && second) {
    await copyDatabase(first, second);
    console.log('Restored to a new database and integrity verified. Active database unchanged.');
  } else throw new Error('Usage');
}
main().catch(() => {
  console.error(
    'Operation failed. Check arguments, database integrity, permissions, and that destination does not exist. No active database was overwritten.',
  );
  process.exitCode = 1;
});
