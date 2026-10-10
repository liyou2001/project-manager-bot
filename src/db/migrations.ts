import type { Database } from 'better-sqlite3';

/**
 * Schema changes, applied in order. The database's `user_version` records how
 * many have run. Never edit a migration that has shipped; append a new one.
 */
const migrations: string[] = [
  // 1: initial schema. IF NOT EXISTS because these tables predate migrations.
  `
  CREATE TABLE IF NOT EXISTS guild_projects (
    guild_id    TEXT PRIMARY KEY,
    guild_name  TEXT,
    website_url TEXT NOT NULL,
    github_url  TEXT NOT NULL,
    updated_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Guilds that have been sent the setup prompt, so restarts don't re-send it.
  CREATE TABLE IF NOT EXISTS guild_prompts (
    guild_id    TEXT PRIMARY KEY,
    prompted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];

export function runMigrations(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < migrations.length; version++) {
    db.transaction(() => {
      db.exec(migrations[version]!);
      db.pragma(`user_version = ${version + 1}`);
    })();
    console.log(`Applied database migration ${version + 1}`);
  }
}
