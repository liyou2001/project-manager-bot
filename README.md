# project-manager-bot

A Discord bot that helps a hackathon team manage its project. It reads the hackathon page, turns the team's idea into a timeline and task list, tracks who is working on what, and reminds the team before events.

Right now it collects the team's hackathon page and GitHub links. The rest is being built in stages.

## How it works

1. When the bot is invited to a server, it posts a **Set up project** prompt in the server's system channel. If it can't post there, it uses the first text channel it can post in. If no channel works, it DMs the server owner. Servers that added the bot while it was offline get the prompt the next time it starts.
2. Clicking the button opens a form asking for the **hackathon page** (Devpost or the event site) and the **GitHub URL**. Only members with **Manage Server** can submit it.
3. The links are checked and saved to `data/bot.db`, with one row per server.

Slash commands:

| Command    | Who                        | What                                            |
| ---------- | -------------------------- | ----------------------------------------------- |
| `/setup`   | Members with Manage Server | Opens the form, pre-filled with any saved links |
| `/project` | Everyone                   | Shows the saved links                           |

## Setup

1. Create an application at <https://discord.com/developers/applications>, go to **Bot**, and copy the token.
2. Install and configure:
   ```sh
   npm install
   cp .env.example .env   # then fill in DISCORD_TOKEN and the AI settings
   ```
3. Invite the bot. Under **OAuth2 → URL Generator**, select the scopes `bot` and `applications.commands`, and the bot permissions `View Channels`, `Send Messages`, and `Embed Links`. Then open the generated URL.
4. Run it:
   ```sh
   npm run dev                 # run the TypeScript directly, restarting on file changes
   npm run build && npm start  # compile to dist/ and run the compiled output
   npm run typecheck           # type-check without emitting
   npm test                    # run the tests
   ```

No privileged gateway intents are needed.

## Choosing an AI model

The bot works with any supported AI provider. Set the model in `.env` as `<provider>:<model-id>`, along with that provider's API key:

```sh
AI_MODEL=anthropic:claude-opus-5-5   # or openai:<model-id>, google:<model-id>
ANTHROPIC_API_KEY=...
```

| Provider    | API key variable               |
| ----------- | ------------------------------ |
| `anthropic` | `ANTHROPIC_API_KEY`            |
| `openai`    | `OPENAI_API_KEY`               |
| `google`    | `GOOGLE_GENERATIVE_AI_API_KEY` |

To send one job to a different model, for example a cheaper model for reading event pages, set `AI_MODEL_EXTRACT` or `AI_MODEL_PLAN`. The bot checks this configuration at startup and stops with a clear message if anything is missing.

All AI calls go through [src/ai/llm.ts](src/ai/llm.ts), which uses the [Vercel AI SDK](https://ai-sdk.dev). To add another provider, install its `@ai-sdk/*` package and add it to the `providers` map and `API_KEY_ENV` there.

## Code layout

| Path | What's there |
| --- | --- |
| [src/index.ts](src/index.ts) | Startup: Discord client, server join and leave events |
| [src/interactions.ts](src/interactions.ts) | Sends each slash command, button and form to its handler |
| [src/commands/](src/commands/) | One file per slash command. Register new ones in `commands/index.ts` |
| [src/setup.ts](src/setup.ts) | The setup prompt and form |
| [src/ai/llm.ts](src/ai/llm.ts) | The model-agnostic AI wrapper |
| [src/db/](src/db/) | The SQLite connection, migrations and queries |

**Buttons and forms:** custom IDs look like `prefix:action`, for example `project-setup:open`. Each prefix has a handler that is registered in `interactions.ts`.

**Database changes:** add a new entry to the end of the list in [src/db/migrations.ts](src/db/migrations.ts). Never edit a migration that has already run. SQLite's `user_version` setting records which migrations have run.

## Data

The data is stored in the `guild_projects` table:

| Column        | Description                         |
| ------------- | ----------------------------------- |
| `guild_id`    | Discord server ID (primary key)     |
| `guild_name`  | Server name at the time of saving   |
| `website_url` | Hackathon page                      |
| `github_url`  | GitHub user/org or repository URL   |
| `updated_by`  | Discord user ID of who last saved   |
| `created_at`, `updated_at` | UTC timestamps         |
