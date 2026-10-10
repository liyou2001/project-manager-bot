import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { checkAiConfig } from './ai/llm.js';
import { commands } from './commands/index.js';
import { clearPrompted } from './db/projects.js';
import { handleInteraction } from './interactions.js';
import { promptIfNeeded } from './setup.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

try {
  console.log(`AI model: ${checkAiConfig().join(', ')}`);
} catch (error) {
  console.error(`AI is not configured: ${(error as Error).message}`);
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Without an 'error' listener, any error discord.js emits (including a failed async event
// handler) would crash the bot.
client.on(Events.Error, (error) => console.error('Discord client error:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag} (in ${readyClient.guilds.cache.size} servers)`);
  try {
    await readyClient.application.commands.set(commands.map((command) => command.data.toJSON()));
  } catch (error) {
    console.error('Could not register slash commands:', error);
  }

  // Catch servers that added the bot while it was offline.
  for (const guild of readyClient.guilds.cache.values()) {
    await promptIfNeeded(guild);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`Joined guild ${guild.name} (${guild.id})`);
  clearPrompted(guild.id); // A fresh invite should always get a prompt if not set up
  await promptIfNeeded(guild);
});

client.on(Events.GuildDelete, (guild) => {
  console.log(`Left guild ${guild.name} (${guild.id})`);
  clearPrompted(guild.id);
});

client.on(Events.InteractionCreate, handleInteraction);

client.login(token);
