import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getEventInfo, setEventTimezone } from '../db/events.js';
import { isValidTimezone } from '../events/normalize.js';
import { canManageProject, MISSING_PERMISSION_MESSAGE } from '../util/permissions.js';
import type { Command } from './types.js';

const AUTO = 'auto';
const ALL_ZONES = Intl.supportedValuesOf('timeZone').filter(isValidTimezone);
const MAX_CHOICES = 25;

export const timezoneCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('timezone')
    .setDescription("Set the hackathon's time zone if the one I found is wrong")
    .addStringOption((option) =>
      option
        .setName('zone')
        .setDescription('e.g. America/New_York, or "auto" to use the one found on the site')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    if (!canManageProject(interaction)) {
      await interaction.reply({ content: MISSING_PERMISSION_MESSAGE, flags: MessageFlags.Ephemeral });
      return;
    }
    const zone = interaction.options.getString('zone', true).trim();
    const override = zone.toLowerCase() === AUTO ? null : zone;
    if (override !== null && !isValidTimezone(override)) {
      await interaction.reply({
        content: `**${zone}** isn't a time zone I can use. Pick a city-based one from the list, e.g. \`America/New_York\` (not \`EST\`, which ignores daylight saving).`,
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

    const { timezone, updated } = setEventTimezone(interaction.guildId, override);
    const items = `Updated ${updated} timeline item${updated === 1 ? '' : 's'}; see \`/event\`.`;
    if (override) {
      await interaction.reply(`Time zone set to **${timezone}**. ${items}`);
    } else if (timezone) {
      await interaction.reply(`Using the time zone found on the site, **${timezone}**. ${items}`);
    } else {
      await interaction.reply('Cleared the manual time zone, but the site didn’t say which one it uses, so times are shown as written.');
    }
  },

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase().replace(/\s+/g, '_');
    const choices = [
      ...(AUTO.startsWith(typed) ? [{ name: 'auto (use the time zone found on the site)', value: AUTO }] : []),
      ...ALL_ZONES.filter((zone) => zone.toLowerCase().includes(typed)).map((zone) => ({ name: zone, value: zone })),
    ];
    await interaction.respond(choices.slice(0, MAX_CHOICES));
  },
};
