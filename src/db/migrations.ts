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
  // 2: make github_url optional. SQLite can't drop NOT NULL in place, so rebuild the table.
  `
  CREATE TABLE guild_projects_new (
    guild_id    TEXT PRIMARY KEY,
    guild_name  TEXT,
    website_url TEXT NOT NULL,
    github_url  TEXT,
    updated_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO guild_projects_new (guild_id, guild_name, website_url, github_url, updated_by, created_at, updated_at)
    SELECT guild_id, guild_name, website_url, github_url, updated_by, created_at, updated_at FROM guild_projects;
  DROP TABLE guild_projects;
  ALTER TABLE guild_projects_new RENAME TO guild_projects;
  `,
  // 3: what the bot learned from the hackathon site, plus the shared timeline.
  `
  CREATE TABLE event_info (
    guild_id          TEXT PRIMARY KEY,
    source_url        TEXT NOT NULL,
    name              TEXT,
    summary           TEXT,
    venue             TEXT,
    timezone          TEXT,
    requirements_json TEXT NOT NULL DEFAULT '[]',
    judging_json      TEXT NOT NULL DEFAULT '[]',
    rules_json        TEXT NOT NULL DEFAULT '[]',
    sources_json      TEXT NOT NULL DEFAULT '{"pages":[],"skipped":[],"unreadableTimes":0}',
    pasted_text       TEXT,
    fetched_at        TEXT
  );
  -- Event schedule and deadlines (source 'event'); later also the team's plan (source 'plan').
  CREATE TABLE timeline_items (
    id          INTEGER PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('event', 'plan')),
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    local_start TEXT NOT NULL,
    local_end   TEXT,
    starts_at   TEXT,
    ends_at     TEXT,
    location    TEXT,
    description TEXT,
    reminded_at TEXT
  );
  CREATE INDEX timeline_items_guild_start ON timeline_items (guild_id, starts_at);
  `,
  // 4: a time zone set with /timezone, kept separately so re-reading the site doesn't undo it.
  `
  ALTER TABLE event_info ADD COLUMN timezone_override TEXT;
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
