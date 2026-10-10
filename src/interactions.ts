import { MessageFlags, type Interaction } from 'discord.js';
import { commands } from './commands/index.js';
import type { ComponentHandler } from './commands/types.js';
import { eventComponents } from './events/components.js';
import { setupComponents } from './setup.js';

const commandsByName = new Map(commands.map((command) => [command.data.name, command]));

const componentHandlers: ComponentHandler[] = [setupComponents, eventComponents];
const handlersByPrefix = new Map(componentHandlers.map((handler) => [handler.prefix, handler]));

/** Route a slash command, autocomplete, button, select menu or modal to its handler. */
export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isAutocomplete()) {
    await commandsByName
      .get(interaction.commandName)
      ?.autocomplete?.(interaction)
      .catch((error: unknown) => console.error('Autocomplete failed:', error));
    return;
  }
  try {
    if (interaction.isChatInputCommand()) {
      await commandsByName.get(interaction.commandName)?.execute(interaction);
    } else if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
      const [prefix = '', action = ''] = interaction.customId.split(':');
      await handlersByPrefix.get(prefix)?.handle(interaction, action);
    }
  } catch (error) {
    console.error('Interaction failed:', error);
    if (!interaction.isRepliable()) return;
    const message = { content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral } as const;
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content: message.content }).catch(() => {});
    } else if (!interaction.replied) {
      await interaction.reply(message).catch(() => {});
    }
  }
}
