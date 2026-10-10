import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getProject } from '../db/projects.js';
import { projectEmbed } from '../setup.js';
import type { Command } from './types.js';

export const projectCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('project')
    .setDescription("Show this server's project links")
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!interaction.inGuild()) return;
    const project = getProject(interaction.guildId);
    await interaction.reply(
      project
        ? { embeds: [projectEmbed(project).setTitle('Project links')] }
        : { content: 'No project links yet. Ask an admin to run `/setup`.', flags: MessageFlags.Ephemeral },
    );
  },
};
