import { closeDatabase } from './database.js';
import { runAllIngestion } from './ingestion.js';

try {
  const results = await runAllIngestion();
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
