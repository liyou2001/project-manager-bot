import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';

const tableNames = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  );

describe('runMigrations', () => {
  it('creates the schema on a fresh database and records the version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(tableNames(db)).toEqual(['guild_projects', 'guild_prompts']);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThan(0);
  });

  it('is a no-op when run again', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const version = db.pragma('user_version', { simple: true });
    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(version);
  });

  it('keeps data in a database created before migrations existed', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE guild_projects (
      guild_id TEXT PRIMARY KEY, guild_name TEXT, website_url TEXT NOT NULL, github_url TEXT NOT NULL,
      updated_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    db.exec(`INSERT INTO guild_projects (guild_id, website_url, github_url, updated_by)
      VALUES ('g1', 'https://a.dev/', 'https://github.com/a', 'u1')`);
    runMigrations(db);
    expect(db.prepare('SELECT guild_id FROM guild_projects').all()).toEqual([{ guild_id: 'g1' }]);
  });
});
