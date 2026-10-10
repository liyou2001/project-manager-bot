import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getEventInfo, setEventTimezone } from '../db/events.js';
import { isValidTimezone } from '../events/normalize.js';
import type { Command } from './types.js';

const ALL_ZONES = Intl.supportedValuesOf('timeZone');
const MAX_CHOICES = 25;

export const timezoneCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('timezone')
    .setDescription("Set the hackathon's time zone if the one I found is wrong")
    .addStringOption((option) =>
      option
        .setName('zone')
        .setDescription('e.g. America/New_York')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    const zone = interaction.options.getString('zone', true).trim();
    if (!isValidTimezone(zone)) {
      await interaction.reply({
        content: `**${zone}** isn't a time zone I know. Pick one from the list, e.g. \`America/New_York\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!getEventInfo(interaction.guildId)) {
      await interaction.reply({
        content: 'There’s no event info yet. Run `/setup` or `/refresh` first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const updated = setEventTimezone(interaction.guildId, zone);
    await interaction.reply(`Time zone set to **${zone}**. Updated ${updated} schedule item${updated === 1 ? '' : 's'}; see \`/event\`.`);
  },

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase().replace(/\s+/g, '_');
    const matches = ALL_ZONES.filter((zone) => zone.toLowerCase().includes(typed)).slice(0, MAX_CHOICES);
    await interaction.respond(matches.map((zone) => ({ name: zone, value: zone })));
  },
};
