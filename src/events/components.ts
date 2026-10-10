import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { ComponentHandler } from '../commands/types.js';
import { appendPastedText } from '../db/events.js';
import { getProject } from '../db/projects.js';
import { canManageProject, MISSING_PERMISSION_MESSAGE } from '../util/permissions.js';
import { runEventRefresh } from './refresh.js';

const PASTE_MODAL_ID = 'event:paste-submit';
const PASTE_INPUT_ID = 'text';

function buildPasteModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(PASTE_MODAL_ID)
    .setTitle('Paste the schedule')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(PASTE_INPUT_ID)
          .setLabel('Schedule, rules or deadlines')
          .setPlaceholder('Paste from the hackathon site, Discord or a hacker guide. Paste again to add more.')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000),
      ),
    );
}

/** Buttons on the event cards: "Paste schedule" and "Try again". */
export const eventComponents: ComponentHandler = {
  prefix: 'event',
  async handle(interaction: MessageComponentInteraction | ModalSubmitInteraction, action: string) {
    if (!interaction.inGuild()) return;
    if (!canManageProject(interaction)) {
      await interaction.reply({ content: MISSING_PERMISSION_MESSAGE, flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === 'paste' && interaction.isButton()) {
      await interaction.showModal(buildPasteModal());
    } else if (action === 'paste-submit' && interaction.isModalSubmit()) {
      const project = getProject(interaction.guildId);
      if (!project) {
        await interaction.reply({ content: 'Set up the project first with `/setup`.', flags: MessageFlags.Ephemeral });
        return;
      }
      const text = interaction.fields.getTextInputValue(PASTE_INPUT_ID).trim();
      appendPastedText(interaction.guildId, project.website_url, text);
      await runEventRefresh(interaction);
    } else if (action === 'retry' && interaction.isButton()) {
      await runEventRefresh(interaction);
    }
  },
};
