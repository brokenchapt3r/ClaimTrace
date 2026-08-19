import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const database = await createDatabase(config);
const app = await buildApp(config, database);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await database.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
