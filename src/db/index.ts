import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './migrations.js';

const dbPath = process.env.DATABASE_PATH || 'data/bot.db';
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

runMigrations(db);
