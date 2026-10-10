import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { openSetupModal } from '../setup.js';
import type { Command } from './types.js';

export const setupCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription("Set or update this server's hackathon page and GitHub links")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  execute: openSetupModal,
};
