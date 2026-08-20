import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, isDatabaseConfigured, withDatabaseClient } from './database.js';

if (!isDatabaseConfigured()) {
  console.error('DATABASE_URL must be configured before running migrations.');
  process.exitCode = 1;
} else {
  const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const migrationDirectory = path.join(rootDirectory, 'database', 'migrations');

  try {
    const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();
    await withDatabaseClient(async (client) => {
      await client.query("SELECT pg_advisory_lock(hashtext('tradegate:migrations'))");
      try {
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
          filename TEXT PRIMARY KEY,
          checksum TEXT,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
        const applied = await client.query('SELECT filename, checksum FROM schema_migrations');
        const appliedFiles = new Map(applied.rows.map((row) => [row.filename, row.checksum]));

        for (const filename of files) {
          const sql = await readFile(path.join(migrationDirectory, filename), 'utf8');
          const checksum = createHash('sha256').update(sql).digest('hex');
          if (appliedFiles.has(filename)) {
            const previousChecksum = appliedFiles.get(filename);
            if (previousChecksum && previousChecksum !== checksum) throw new Error(`Applied migration ${filename} has changed`);
            if (!previousChecksum) await client.query('UPDATE schema_migrations SET checksum = $2 WHERE filename = $1', [filename, checksum]);
            continue;
          }

          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, checksum]);
            await client.query('COMMIT');
            console.log(`Applied migration ${filename}`);
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext('tradegate:migrations'))");
      }
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
