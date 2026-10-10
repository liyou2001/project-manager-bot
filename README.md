# project-manager-bot

A Discord bot that helps a hackathon team manage its project. It reads the hackathon page, turns the team's idea into a timeline and task list, tracks who is working on what, and reminds the team before events.

Right now it collects the team's links, reads the hackathon site, and posts the schedule, deadlines, requirements, judging criteria and key rules. The planning and task features are being built in stages.

## How it works

1. When the bot is invited to a server, it posts a **Set up project** prompt in the server's system channel. If it can't post there, it uses the first text channel it can post in. If no channel works, it DMs the server owner. Servers that added the bot while it was offline get the prompt the next time it starts.
2. Clicking the button opens a form asking for the **hackathon page** (Devpost or the event site) and, optionally, the **GitHub URL**. Only members with **Manage Server** can submit it.
3. The bot then reads the hackathon site and posts what it found:
   - **Overview:** the event name, a short summary, the venue, the time zone and the next deadline.
   - **Requirements:** what the team has to submit.
   - **Judging criteria** and **Rules highlights.**
   - **Timeline:** the schedule and deadlines together, grouped by day. Deadlines are marked ⏰ with a live countdown.

   Times use Discord timestamps, so everyone sees them in their own time zone. A status message shows progress while the bot works, which takes about 30 seconds.
4. If the site can't be read, or has no schedule, a **Paste schedule** button lets an admin paste the schedule, for example from the hackathon's Discord or a hacker guide.

Slash commands:

| Command | Who | What |
| --- | --- | --- |
| `/setup` | Members with Manage Server | Opens the form, pre-filled with any saved links. Reads the site again if the link changed |
| `/project` | Everyone | Shows the saved links |
| `/event` | Everyone | Shows the schedule, deadlines, requirements and rules again |
| `/refresh` | Members with Manage Server | Reads the hackathon site again |
| `/timezone <zone>` | Members with Manage Server | Fixes the event's time zone if the bot guessed wrong. The fix survives `/refresh`; `/timezone auto` goes back to the guess |

## Setup

1. Create an application at <https://discord.com/developers/applications>, go to **Bot**, and copy the token.
2. Install and configure:
   ```sh
   npm install
   npm run setup:browser  # downloads headless Chromium (~150 MB) for JavaScript-heavy sites
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
AI_MODEL=openai:gpt-5-mini   # or anthropic:<model-id>, google:<model-id>
OPENAI_API_KEY=...
```

| Provider    | API key variable               |
| ----------- | ------------------------------ |
| `anthropic` | `ANTHROPIC_API_KEY`            |
| `openai`    | `OPENAI_API_KEY`               |
| `google`    | `GOOGLE_GENERATIVE_AI_API_KEY` |

To send one job to a different model, for example a cheaper model for reading event pages, set `AI_MODEL_EXTRACT` or `AI_MODEL_PLAN`. The bot checks this configuration at startup and stops with a clear message if anything is missing.

All AI calls go through [src/ai/llm.ts](src/ai/llm.ts), which uses the [Vercel AI SDK](https://ai-sdk.dev). To add another provider, install its `@ai-sdk/*` package and add it to the `providers` map and `API_KEY_ENV` there.

## Reading hackathon sites

The crawler in [src/web/](src/web/) reads up to 10 pages per run. It tries at most 15 pages and stops after 90 seconds or about 120,000 characters of text, so one slow or broken site can't hold things up.

- **Devpost:** the main page, `/details/dates`, `/rules`, `/updates` and `/resources`. Pages like participants and the project gallery are skipped.
- **The official site:** the hackathon's own site, where workshop schedules usually live. The crawler finds it among the links (or website names) on the Devpost page by matching it to the event name, so sponsor links aren't followed. On that site it prefers schedule, agenda and FAQ pages.
- **JavaScript-heavy pages:** schedule pages on official sites are opened in headless Chromium, and the crawler clicks each day tab ("Saturday", "Day 2") so schedules split across tabs are read in full. Without Chromium the bot still works, but it may miss these schedules.
- **Safety:** the crawler respects `robots.txt` (in the browser too), waits between requests to the same site, and refuses links that point to private network addresses. In the browser, every request and every redirect hop is checked the same way, and service workers and WebSockets are turned off.
- **Known gap:** the address check looks up a site's address separately from the request itself, so a site that changes its DNS answer in between (DNS rebinding) could get past it. That only matters if the bot runs somewhere with internal services worth protecting.

To test against a real site without Discord:

```sh
npm run try:extract -- https://some-hackathon.devpost.com/            # crawl and extract
npm run try:extract -- <url> --crawl-only --text                     # see exactly what text was read
npm run try:extract -- <url> --model openai:gpt-5-nano               # compare another model
```

## Code layout

| Path | What's there |
| --- | --- |
| [src/index.ts](src/index.ts) | Startup: Discord client, server join and leave events |
| [src/interactions.ts](src/interactions.ts) | Sends each slash command, autocomplete, button and form to its handler |
| [src/commands/](src/commands/) | One file per slash command. Register new ones in `commands/index.ts` |
| [src/setup.ts](src/setup.ts) | The setup prompt and form |
| [src/web/](src/web/) | Fetching, rendering and crawling hackathon sites |
| [src/ai/](src/ai/) | The model-agnostic AI wrapper, schemas and prompts |
| [src/events/](src/events/) | Reading the site end to end, converting times, and the Discord cards |
| [src/db/](src/db/) | The SQLite connection, migrations and queries |

**Buttons and forms:** custom IDs look like `prefix:action`, for example `project-setup:open` or `event:paste`. Each prefix has a handler that is registered in `interactions.ts`.

**Database changes:** add a new entry to the end of the list in [src/db/migrations.ts](src/db/migrations.ts). Never edit a migration that has already run. SQLite's `user_version` setting records which migrations have run.

## Data

All data is in `data/bot.db`.

| Table | What it holds |
| --- | --- |
| `guild_projects` | Each server's hackathon page and GitHub links, and who saved them |
| `guild_prompts` | Which servers have been sent the setup prompt |
| `event_info` | What was read from the hackathon site: summary, venue, detected and manual time zones, requirements, judging criteria, rules, which pages were read, and any pasted text. Pasted text and a manual time zone are cleared when the hackathon link changes |
| `timeline_items` | Schedule items and deadlines, stored both as written on the site and in UTC |
