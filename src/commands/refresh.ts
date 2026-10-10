import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { runEventRefresh } from '../events/refresh.js';
import { canManageProject, MISSING_PERMISSION_MESSAGE } from '../util/permissions.js';
import type { Command } from './types.js';

export const refreshCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('Read the hackathon site again and update the schedule, deadlines and requirements')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!interaction.inGuild()) return;
    // Default permissions can be changed by server admins, so check here too.
    if (!canManageProject(interaction)) {
      await interaction.reply({ content: MISSING_PERMISSION_MESSAGE, flags: MessageFlags.Ephemeral });
      return;
    }
    await runEventRefresh(interaction);
  },
};
