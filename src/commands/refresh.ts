import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { runEventRefresh } from '../events/refresh.js';
import type { Command } from './types.js';

export const refreshCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('Read the hackathon site again and update the schedule, deadlines and requirements')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!interaction.inGuild()) return;
    await runEventRefresh(interaction);
  },
};
