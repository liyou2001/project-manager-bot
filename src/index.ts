import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { clearPrompted, getProject } from './db.js';
import {
  SETUP_BUTTON_ID,
  SETUP_MODAL_ID,
  handleSetupSubmit,
  openSetupModal,
  projectEmbed,
  promptIfNeeded,
} from './setup.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription("Set or update this server's project website and GitHub links")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('project')
    .setDescription("Show this server's project links")
    .setContexts(InteractionContextType.Guild),
].map((command) => command.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  await readyClient.application.commands.set(commands);
  console.log(`Logged in as ${readyClient.user.tag} (in ${readyClient.guilds.cache.size} servers)`);

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

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) return;
      if (interaction.commandName === 'setup') {
        await openSetupModal(interaction);
      } else if (interaction.commandName === 'project') {
        const project = getProject(interaction.guildId);
        await interaction.reply(
          project
            ? { embeds: [projectEmbed(project).setTitle('Project links')] }
            : { content: 'No project links yet. Ask an admin to run `/setup`.', flags: MessageFlags.Ephemeral },
        );
      }
    } else if (interaction.isButton() && interaction.customId === SETUP_BUTTON_ID) {
      await openSetupModal(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId === SETUP_MODAL_ID) {
      await handleSetupSubmit(interaction);
    }
  } catch (error) {
    console.error('Interaction failed:', error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

client.login(token);
