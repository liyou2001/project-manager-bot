# project-manager-bot

A Discord bot that asks for your project's website and GitHub links when it joins a server, and stores them in SQLite.

## How it works

1. When the bot is invited to a server, it posts a **Set up project** prompt in the server's system channel. If it can't post there, it uses the first text channel it can post in. If no channel works, it DMs the server owner.
2. Clicking the button opens a form asking for the **website URL** and **GitHub URL**. Only members with **Manage Server** can submit it.
3. The links are checked and saved to `data/bot.db`, with one row per server.

Slash commands:

| Command    | Who                      | What                                       |
| ---------- | ------------------------ | ------------------------------------------ |
| `/setup`   | Members with Manage Server | Opens the form, pre-filled with any saved links |
| `/project` | Everyone                 | Shows the saved links                      |

## Setup

1. Create an application at <https://discord.com/developers/applications>, go to **Bot**, and copy the token.
2. Install and configure:
   ```sh
   npm install
   cp .env.example .env   # then paste your token into DISCORD_TOKEN
   ```
3. Invite the bot. Under **OAuth2 → URL Generator**, select the scopes `bot` and `applications.commands`, and the bot permissions `View Channels`, `Send Messages`, and `Embed Links`. Then open the generated URL.
4. Run it:
   ```sh
   npm run dev               # run the TypeScript directly, restarting on file changes
   npm run build && npm start  # compile to dist/ and run the compiled output
   npm run typecheck         # type-check without emitting
   ```

No privileged gateway intents are needed.

## Data

The data is stored in the `guild_projects` table:

| Column        | Description                         |
| ------------- | ----------------------------------- |
| `guild_id`    | Discord server ID (primary key)     |
| `guild_name`  | Server name at the time of saving   |
| `website_url` | Project website                     |
| `github_url`  | GitHub user/org or repository URL   |
| `updated_by`  | Discord user ID of who last saved   |
| `created_at`, `updated_at` | UTC timestamps         |
