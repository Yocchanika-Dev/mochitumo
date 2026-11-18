const { DEFAULT_DATABASE_PATH, openDatabase } = require('../src/db/database');
require('../src/config').loadEnvironmentFile();

const db = openDatabase();
db.close();
console.log(`Database migrations applied: ${process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH}`);
