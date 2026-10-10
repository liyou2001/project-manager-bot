import { db } from './index.js';

export interface ProjectRow {
  guild_id: string;
  guild_name: string | null;
  website_url: string;
  github_url: string | null;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectInput {
  guildId: string;
  guildName: string | null;
  websiteUrl: string;
  githubUrl: string | null;
  updatedBy: string;
}

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
