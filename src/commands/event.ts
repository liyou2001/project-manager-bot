import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { replyWithEventCards } from '../events/refresh.js';
import type { Command } from './types.js';

export const eventCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription("Show the hackathon's schedule, deadlines, requirements and rules")
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!interaction.inGuild()) return;
    await replyWithEventCards(interaction);
  },
};
