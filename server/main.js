/**
 * Run the game server.
 *
 * Usage: node server/main.js [--dev]
 *
 * Environment:
 *   PORT              default 2567
 *   HOST              default 127.0.0.1; 0.0.0.0 to accept other machines
 *   VIGAME_DB         SQLite file, default data/vigame.db
 *   MONITOR_PASSWORD  mounts /monitor behind this password (user "admin")
 *   VIGAME_DEV=1      same as --dev: rebuild the page per request, mount /playground
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startGameServer } from './app.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = resolve(ROOT, process.env.VIGAME_DB ?? 'data/vigame.db');
const dev = process.argv.includes('--dev') || process.env.VIGAME_DEV === '1';
const host = process.env.HOST ?? '127.0.0.1';

mkdirSync(dirname(db), { recursive: true });

const server = await startGameServer({
  port: Number(process.env.PORT ?? 2567),
  host,
  db,
  monitorPassword: process.env.MONITOR_PASSWORD || undefined,
  dev,
  handleSignals: true,
});

const shown = host === '0.0.0.0' ? server.url.replace('0.0.0.0', 'localhost') : server.url;
console.log(`vigame game server: ${shown}`);
console.log(`  database: ${db} (journal: ${server.storage.journalMode()})`);
if (process.env.MONITOR_PASSWORD) console.log(`  monitor:  ${shown}monitor (user "admin")`);
if (dev) console.log(`  playground: ${shown}playground`);
