import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProjectRow {
  guild_id: string;
  guild_name: string | null;
  website_url: string;
  github_url: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectInput {
  guildId: string;
  guildName: string | null;
  websiteUrl: string;
  githubUrl: string;
  updatedBy: string;
}

const dbPath = process.env.DATABASE_PATH || 'data/bot.db';
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_projects (
    guild_id    TEXT PRIMARY KEY,
    guild_name  TEXT,
    website_url TEXT NOT NULL,
    github_url  TEXT NOT NULL,
    updated_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Guilds that have been sent the setup prompt, so restarts don't re-send it.
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_prompts (
    guild_id    TEXT PRIMARY KEY,
    prompted_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const upsertStmt = db.prepare<ProjectInput>(`
  INSERT INTO guild_projects (guild_id, guild_name, website_url, github_url, updated_by)
  VALUES (@guildId, @guildName, @websiteUrl, @githubUrl, @updatedBy)
  ON CONFLICT(guild_id) DO UPDATE SET
    guild_name  = excluded.guild_name,
    website_url = excluded.website_url,
    github_url  = excluded.github_url,
    updated_by  = excluded.updated_by,
    updated_at  = datetime('now')
`);

const getStmt = db.prepare<[string], ProjectRow>('SELECT * FROM guild_projects WHERE guild_id = ?');

const wasPromptedStmt = db.prepare<[string], { guild_id: string }>(
  'SELECT guild_id FROM guild_prompts WHERE guild_id = ?',
);
const markPromptedStmt = db.prepare<[string]>(
  'INSERT OR REPLACE INTO guild_prompts (guild_id) VALUES (?)',
);
const clearPromptedStmt = db.prepare<[string]>('DELETE FROM guild_prompts WHERE guild_id = ?');

export function wasPrompted(guildId: string): boolean {
  return wasPromptedStmt.get(guildId) !== undefined;
}

export function markPrompted(guildId: string): void {
  markPromptedStmt.run(guildId);
}

export function clearPrompted(guildId: string): void {
  clearPromptedStmt.run(guildId);
}

export function saveProject(project: ProjectInput): void {
  upsertStmt.run(project);
}

export function getProject(guildId: string): ProjectRow | undefined {
  return getStmt.get(guildId);
}
